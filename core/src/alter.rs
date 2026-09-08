//! Dialect-aware DDL builders for the Structure editor (F5).
//!
//! Every identifier emitted here passes through `ident::quote_ident`; values
//! used as `DEFAULT` go through `ident::quote_literal` or a checked allowlist
//! of bare SQL keywords/expressions. The one *unquoted* interpolation is the
//! column `data_type` string, so it is gated by the strict charset in
//! `valid_data_type` (no quotes, semicolons, or comment markers).
//!
//! Also see the guardrail notes in CLAUDE.md: this follows the same principle
//! as `validate_db_name` (drivers/mod.rs) — DDL identifiers can't be
//! bind-parameterized, so restrictive charsets are the injection guard.

use serde::{Deserialize, Serialize};

use crate::connection::DbEngine;
use crate::ident::{quote_ident, quote_literal};

/// An atomic structure mutation, mirrored one-to-one by the frontend form in
/// `StructureModal.ts` (`ipc.ts` `AlterRequest`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum AlterRequest {
    AddColumn {
        name: String,
        data_type: String,
        nullable: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        default_value: Option<String>,
    },
    DropColumn {
        name: String,
    },
    RenameColumn {
        old_name: String,
        new_name: String,
    },
    CreateIndex {
        name: String,
        #[serde(default)]
        columns: Vec<String>,
        #[serde(default)]
        unique: bool,
    },
    DropIndex {
        name: String,
    },
}

/// Charset guard for *new* identifiers (added columns, renamed columns, new
/// indexes). DDL identifiers can't be bind-parameterized, and MSSQL's
/// `sp_rename` takes a plain dotted string rather than bracket-escaped
/// identifiers — a clean, restrictive charset is the only safe option.
pub fn validate_ddl_identifier(name: &str) -> Result<(), String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("Identifier cannot be empty".into());
    }
    if name.len() > 63 {
        return Err("Identifier is too long (max 63 characters)".into());
    }
    if !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
        return Err("Identifiers may only contain letters, numbers, and underscores".into());
    }
    if name.chars().next().is_some_and(|c| c.is_ascii_digit()) {
        return Err("Identifiers cannot start with a number".into());
    }
    Ok(())
}

/// The type string in ADD COLUMN is interpolated *unquoted*, so it never lets
/// quotes, semicolons, comment markers, or backslashes through. Enum-style
/// `('a','b')` payloads still pass.
pub fn valid_data_type(t: &str) -> bool {
    let t = t.trim();
    if t.is_empty() || t.len() > 64 {
        return false;
    }
    if t.contains("--")
        || t.contains("/*")
        || t.contains("*/")
        || t.contains(';')
        || t.contains('\\')
        || t.contains('`')
        || t.contains('"')
    {
        return false;
    }
    t.chars().all(|c| {
        c.is_ascii_alphanumeric() || matches!(c, '_' | ' ' | '(' | ')' | ',' | '.' | '[' | ']' | '\'')
    })
}

/// Bare SQL keywords/expressions allowed as an *unquoted* DEFAULT value.
/// Everything else is treated as a string literal via `quote_literal`.
const RAW_DEFAULTS: &[&str] = &[
    "CURRENT_TIMESTAMP",
    "CURRENT_DATE",
    "CURRENT_TIME",
    "LOCALTIMESTAMP",
    "LOCALTIME",
    "CURRENT_USER",
    "SESSION_USER",
    "SYSTEM_USER",
    "CURRENT_ROLE",
    "TRUE",
    "FALSE",
    "NOW",
    "NOW()",
    "SYSDATE",
    "GETDATE",
    "GETDATE()",
    "SYS_GUID()",
    "UUID",
    "UUID()",
    "GEN_RANDOM_UUID()",
    "NEWID",
    "NEWID()",
    "RANDOM()",
    "RAND()",
];

fn render_default(engine: &DbEngine, value: &str) -> Result<String, String> {
    let v = value.trim();
    if v.eq_ignore_ascii_case("NULL") {
        return Ok(String::new());
    }
    let up = v.to_ascii_uppercase();
    let plain = |s: &str| s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '(' | ')' | ' '));
    if plain(&up) && (RAW_DEFAULTS.contains(&up.as_str()) || up.contains("CURRENT_")) {
        Ok(v.to_string())
    } else {
        Ok(quote_literal(engine, v))
    }
}

fn qualified(engine: &DbEngine, schema: Option<&str>, table: &str) -> String {
    match schema {
        Some(s) if !s.is_empty() => format!(
            "{}.{}",
            quote_ident(engine, s),
            quote_ident(engine, table)
        ),
        _ => quote_ident(engine, table),
    }
}

/// Assemble the ALTER statement for `req` against `engine`. Returns a
/// human-readable error on invalid input; the caller runs the SQL (and gets
/// the SQL string back as the success message/transparency).
pub fn build_alter_sql(
    engine: DbEngine,
    schema: Option<&str>,
    table: &str,
    req: &AlterRequest,
) -> Result<String, String> {
    if table.trim().is_empty() {
        return Err("Table name cannot be empty".into());
    }
    let tbl = qualified(&engine, schema, table);
    match req {
        AlterRequest::AddColumn {
            name,
            data_type,
            nullable,
            default_value,
        } => {
            validate_ddl_identifier(name)?;
            let data_type = data_type.trim();
            if !valid_data_type(data_type) {
                return Err(
                    "Data type may only contain letters, numbers, spaces, commas, \
                     parentheses, and dots (e.g. VARCHAR(255), NUMERIC(10,2))"
                        .into(),
                );
            }
            let name_q = quote_ident(&engine, name);
            let mut sql = match engine {
                DbEngine::MSSQL => format!("ALTER TABLE {tbl} ADD {name_q} {data_type}"),
                _ => format!("ALTER TABLE {tbl} ADD COLUMN {name_q} {data_type}"),
            };
            if let Some(d) = default_value {
                let rendered = render_default(&engine, d)?;
                if !rendered.is_empty() {
                    sql.push_str(&format!(" DEFAULT {rendered}"));
                }
            }
            sql.push_str(if *nullable { " NULL" } else { " NOT NULL" });
            Ok(sql)
        }
        AlterRequest::DropColumn { name } => {
            if name.trim().is_empty() {
                return Err("Column name cannot be empty".into());
            }
            Ok(format!(
                "ALTER TABLE {tbl} DROP COLUMN {}",
                quote_ident(&engine, name)
            ))
        }
        AlterRequest::RenameColumn { old_name, new_name } => {
            validate_ddl_identifier(new_name)?;
            if old_name.trim().is_empty() {
                return Err("Old column name cannot be empty".into());
            }
            match engine {
                // sp_rename takes a dotted *string*, not bracket-escaped
                // identifiers — only doubling the literal quotes is needed.
                DbEngine::MSSQL => {
                    let path = match schema {
                        Some(s) if !s.is_empty() => format!("{s}.{table}.{old_name}"),
                        _ => format!("{table}.{old_name}"),
                    };
                    let obj = path.replace('\'', "''");
                    let new = new_name.trim().replace('\'', "''");
                    Ok(format!("EXEC sp_rename N'{obj}', N'{new}', 'COLUMN'"))
                }
                _ => Ok(format!(
                    "ALTER TABLE {tbl} RENAME COLUMN {} TO {}",
                    quote_ident(&engine, old_name),
                    quote_ident(&engine, new_name)
                )),
            }
        }
        AlterRequest::CreateIndex {
            name,
            columns,
            unique,
        } => {
            validate_ddl_identifier(name)?;
            if columns.is_empty() {
                return Err("An index needs at least one column".into());
            }
            let cols: String = columns
                .iter()
                .map(|c| {
                    let c = c.trim();
                    if c.is_empty() {
                        Err("Index column cannot be empty".into())
                    } else {
                        Ok(quote_ident(&engine, c))
                    }
                })
                .collect::<Result<Vec<String>, String>>()?
                .join(", ");
            let u = if *unique { "UNIQUE " } else { "" };
            Ok(format!(
                "CREATE {u}INDEX {} ON {tbl} ({cols})",
                quote_ident(&engine, name)
            ))
        }
        AlterRequest::DropIndex { name } => {
            if name.trim().is_empty() {
                return Err("Index name cannot be empty".into());
            }
            match engine {
                DbEngine::MySQL => Ok(format!(
                    "ALTER TABLE {tbl} DROP INDEX {}",
                    quote_ident(&engine, name)
                )),
                DbEngine::MSSQL => Ok(format!(
                    "DROP INDEX {} ON {tbl}",
                    quote_ident(&engine, name)
                )),
                DbEngine::Postgres => match schema {
                    Some(s) if !s.is_empty() => Ok(format!(
                        "DROP INDEX {}.{}",
                        quote_ident(&engine, s),
                        quote_ident(&engine, name)
                    )),
                    _ => Ok(format!("DROP INDEX {}", quote_ident(&engine, name))),
                },
                DbEngine::SQLite => Ok(format!("DROP INDEX {}", quote_ident(&engine, name))),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn add_column_types_are_quoted() {
        let sql = build_alter_sql(
            DbEngine::Postgres,
            Some("public"),
            "users",
            &AlterRequest::AddColumn {
                name: "age".into(),
                data_type: "INTEGER".into(),
                nullable: true,
                default_value: Some("0".into()),
            },
        )
        .unwrap();
        assert_eq!(sql, "ALTER TABLE \"public\".\"users\" ADD COLUMN \"age\" INTEGER DEFAULT '0' NULL");
    }

    #[test]
    fn add_column_rejects_injection_types() {
        let bad = ["INTEGER); DROP TABLE users; --", "text`", "var\"char", "int /* x */"];
        for t in bad {
            let r = build_alter_sql(
                DbEngine::Postgres,
                None,
                "t",
                &AlterRequest::AddColumn {
                    name: "c".into(),
                    data_type: t.into(),
                    nullable: true,
                    default_value: None,
                },
            );
            assert!(r.is_err(), "type {t:?} should be rejected");
        }
    }

    #[test]
    fn add_column_keeps_raw_expression_defaults() {
        let sql = build_alter_sql(
            DbEngine::Postgres,
            None,
            "t",
            &AlterRequest::AddColumn {
                name: "created".into(),
                data_type: "TIMESTAMPTZ".into(),
                nullable: false,
                default_value: Some("now()".into()),
            },
        )
        .unwrap();
        assert!(sql.ends_with(" DEFAULT now() NOT NULL"), "{sql}");
    }

    #[test]
    fn string_defaults_are_literalized() {
        let sql = build_alter_sql(
            DbEngine::Postgres,
            None,
            "t",
            &AlterRequest::AddColumn {
                name: "status".into(),
                data_type: "TEXT".into(),
                nullable: false,
                default_value: Some("hello ' world".into()),
            },
        )
        .unwrap();
        assert!(sql.ends_with(" DEFAULT 'hello '' world' NOT NULL"), "{sql}");
    }

    #[test]
    fn rename_column_dialect_split() {
        let pg = build_alter_sql(
            DbEngine::Postgres,
            Some("app"),
            "t",
            &AlterRequest::RenameColumn {
                old_name: "a".into(),
                new_name: "b".into(),
            },
        )
        .unwrap();
        assert_eq!(pg, "ALTER TABLE \"app\".\"t\" RENAME COLUMN \"a\" TO \"b\"");

        let mssql = build_alter_sql(
            DbEngine::MSSQL,
            Some("dbo"),
            "t",
            &AlterRequest::RenameColumn {
                old_name: "a".into(),
                new_name: "b".into(),
            },
        )
        .unwrap();
        assert_eq!(mssql, "EXEC sp_rename N'dbo.t.a', N'b', 'COLUMN'");
    }

    #[test]
    fn drop_index_dialect_forms() {
        let pg = build_alter_sql(
            DbEngine::Postgres,
            Some("public"),
            "t",
            &AlterRequest::DropIndex { name: "ix".into() },
        )
        .unwrap();
        assert_eq!(pg, "DROP INDEX \"public\".\"ix\"");

        let mysql = build_alter_sql(
            DbEngine::MySQL,
            Some("db"),
            "t",
            &AlterRequest::DropIndex { name: "ix".into() },
        )
        .unwrap();
        assert_eq!(mysql, "ALTER TABLE `db`.`t` DROP INDEX `ix`");

        let mssql = build_alter_sql(
            DbEngine::MSSQL,
            Some("dbo"),
            "t",
            &AlterRequest::DropIndex { name: "ix".into() },
        )
        .unwrap();
        assert_eq!(mssql, "DROP INDEX [ix] ON [dbo].[t]");
    }
}