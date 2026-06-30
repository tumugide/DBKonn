use anyhow::{bail, Context, Result};
use clap::{Parser, Subcommand};
use dbkonn_core::connection::{ConnectionConfig, DbEngine};
use std::path::PathBuf;
use std::process::Command;

#[derive(Parser)]
#[command(name = "dbctl", version, about = "DBKonn CLI — backup & restore databases")]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// Backup a database to a file
    Backup {
        /// Saved connection name
        #[arg(long)]
        conn: String,
        /// Output file path
        #[arg(long, short)]
        out: PathBuf,
    },
    /// Restore a database from a file
    Restore {
        /// Saved connection name
        #[arg(long)]
        conn: String,
        /// Input file path
        #[arg(long, short = 'i')]
        r#in: PathBuf,
    },
    /// List saved connections
    List,
}

fn config_dir() -> PathBuf {
    dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("DBKonn")
}

fn load_connections() -> Result<Vec<ConnectionConfig>> {
    let path = config_dir().join("connections.json");
    if !path.exists() {
        return Ok(vec![]);
    }
    let data = std::fs::read_to_string(&path)
        .with_context(|| format!("Reading {}", path.display()))?;
    let conns: Vec<ConnectionConfig> = serde_json::from_str(&data)?;
    Ok(conns)
}

fn find_connection(name: &str) -> Result<ConnectionConfig> {
    let conns = load_connections()?;
    conns
        .into_iter()
        .find(|c| c.name == name)
        .ok_or_else(|| anyhow::anyhow!("Connection '{}' not found", name))
}

fn resolve_password(config: &mut ConnectionConfig) -> Result<()> {
    // Try to pull password from keychain
    let entry = keyring::Entry::new("DBKonn", &config.id)
        .with_context(|| "Creating keyring entry")?;
    match entry.get_password() {
        Ok(pw) => {
            config.password = Some(pw);
        }
        Err(keyring::Error::NoEntry) => {}
        Err(e) => {
            eprintln!("Warning: could not read keychain: {}", e);
        }
    }
    Ok(())
}

fn run_cmd(mut cmd: Command, description: &str) -> Result<()> {
    println!("Running: {}", description);
    let status = cmd.status().with_context(|| format!("Executing {}", description))?;
    if !status.success() {
        bail!("{} failed with exit code {:?}", description, status.code());
    }
    Ok(())
}

fn backup(mut config: ConnectionConfig, out: &PathBuf) -> Result<()> {
    resolve_password(&mut config)?;
    match &config.engine {
        DbEngine::Postgres => {
            let mut cmd = Command::new("pg_dump");
            cmd.arg("-h").arg(config.host.as_deref().unwrap_or("localhost"))
               .arg("-p").arg(config.port.unwrap_or(5432).to_string())
               .arg("-U").arg(config.username.as_deref().unwrap_or("postgres"))
               .arg("-F").arg("c")
               .arg("-f").arg(out)
               .arg(config.database.as_deref().unwrap_or("postgres"));
            if let Some(pw) = &config.password {
                cmd.env("PGPASSWORD", pw);
            }
            run_cmd(cmd, "pg_dump")?;
        }
        DbEngine::MySQL => {
            let mut cmd = Command::new("mysqldump");
            cmd.arg("-h").arg(config.host.as_deref().unwrap_or("localhost"))
               .arg("-P").arg(config.port.unwrap_or(3306).to_string())
               .arg("-u").arg(config.username.as_deref().unwrap_or("root"));
            if let Some(pw) = &config.password {
                cmd.arg(format!("-p{}", pw));
            }
            cmd.arg(config.database.as_deref().unwrap_or(""))
               .arg("--result-file").arg(out);
            run_cmd(cmd, "mysqldump")?;
        }
        DbEngine::SQLite => {
            let src = config.file_path.as_deref().unwrap_or("");
            std::fs::copy(src, out)
                .with_context(|| format!("Copying SQLite file {} to {}", src, out.display()))?;
            println!("SQLite file copied to {}", out.display());
        }
        DbEngine::MSSQL => {
            // Use sqlcmd to generate a backup via BACKUP DATABASE T-SQL
            let host = config.host.as_deref().unwrap_or("localhost");
            let port = config.port.unwrap_or(1433);
            let db = config.database.as_deref().unwrap_or("master");
            let out_str = out.to_string_lossy();
            let sql = format!("BACKUP DATABASE [{}] TO DISK = N'{}' WITH FORMAT, INIT", db, out_str);
            let mut cmd = Command::new("sqlcmd");
            cmd.arg("-S").arg(format!("{}:{}", host, port))
               .arg("-Q").arg(&sql);
            if let Some(u) = &config.username {
                cmd.arg("-U").arg(u);
            }
            if let Some(p) = &config.password {
                cmd.arg("-P").arg(p);
            }
            run_cmd(cmd, "sqlcmd BACKUP DATABASE")?;
        }
    }
    println!("Backup complete: {}", out.display());
    Ok(())
}

fn restore(mut config: ConnectionConfig, input: &PathBuf) -> Result<()> {
    resolve_password(&mut config)?;
    match &config.engine {
        DbEngine::Postgres => {
            let mut cmd = Command::new("pg_restore");
            cmd.arg("-h").arg(config.host.as_deref().unwrap_or("localhost"))
               .arg("-p").arg(config.port.unwrap_or(5432).to_string())
               .arg("-U").arg(config.username.as_deref().unwrap_or("postgres"))
               .arg("-d").arg(config.database.as_deref().unwrap_or("postgres"))
               .arg("--clean")
               .arg(input);
            if let Some(pw) = &config.password {
                cmd.env("PGPASSWORD", pw);
            }
            run_cmd(cmd, "pg_restore")?;
        }
        DbEngine::MySQL => {
            let mut cmd = Command::new("mysql");
            cmd.arg("-h").arg(config.host.as_deref().unwrap_or("localhost"))
               .arg("-P").arg(config.port.unwrap_or(3306).to_string())
               .arg("-u").arg(config.username.as_deref().unwrap_or("root"));
            if let Some(pw) = &config.password {
                cmd.arg(format!("-p{}", pw));
            }
            cmd.arg(config.database.as_deref().unwrap_or(""))
               .arg("<").arg(input);
            run_cmd(cmd, "mysql restore")?;
        }
        DbEngine::SQLite => {
            let dst = config.file_path.as_deref().unwrap_or("");
            std::fs::copy(input, dst)
                .with_context(|| format!("Copying {} to {}", input.display(), dst))?;
            println!("SQLite file restored to {}", dst);
        }
        DbEngine::MSSQL => {
            let host = config.host.as_deref().unwrap_or("localhost");
            let port = config.port.unwrap_or(1433);
            let db = config.database.as_deref().unwrap_or("master");
            let in_str = input.to_string_lossy();
            let sql = format!(
                "RESTORE DATABASE [{}] FROM DISK = N'{}' WITH REPLACE",
                db, in_str
            );
            let mut cmd = Command::new("sqlcmd");
            cmd.arg("-S").arg(format!("{}:{}", host, port))
               .arg("-Q").arg(&sql);
            if let Some(u) = &config.username {
                cmd.arg("-U").arg(u);
            }
            if let Some(p) = &config.password {
                cmd.arg("-P").arg(p);
            }
            run_cmd(cmd, "sqlcmd RESTORE DATABASE")?;
        }
    }
    println!("Restore complete.");
    Ok(())
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt::init();
    let cli = Cli::parse();

    match cli.command {
        Commands::Backup { conn, out } => {
            let config = find_connection(&conn)?;
            backup(config, &out)?;
        }
        Commands::Restore { conn, r#in } => {
            let config = find_connection(&conn)?;
            restore(config, &r#in)?;
        }
        Commands::List => {
            let conns = load_connections()?;
            if conns.is_empty() {
                println!("No saved connections found.");
            } else {
                for c in &conns {
                    println!("[{}] {} — {}", c.id, c.name, c.engine);
                }
            }
        }
    }

    Ok(())
}
