import { invoke } from "@tauri-apps/api/core";

// ── Types mirroring Rust structs ──────────────────────────────────────────────

export type DbEngine = "postgres" | "mysql" | "sqlite" | "mssql";
export type SslMode  = "prefer"   | "require" | "disable";

export interface ConnectionConfig {
  id: string;
  name: string;
  engine: DbEngine;
  host?: string;
  port?: number;
  username?: string;
  password?: string;
  database?: string;
  file_path?: string;
  ssl_mode: SslMode;
  /** User-assigned color tag (hex, e.g. "#e06c75") for telling connections apart at a glance */
  color?: string;
}

export interface ColumnInfo {
  name: string;
  data_type: string;
  nullable: boolean;
  is_primary_key: boolean;
  default_value?: string;
  max_length?: number;
  enum_values?: string[];
}

export interface IndexInfo {
  name: string;
  columns: string[];
  is_unique: boolean;
  is_primary: boolean;
}

export interface TableInfo {
  schema: string;
  name: string;
  table_type: string;
  row_count_estimate?: number;
}

export interface SchemaInfo {
  name: string;
}

export type RowValue = null | boolean | number | string | Record<string, unknown>;

export interface QueryResult {
  columns: ColumnInfo[];
  rows: RowValue[][];
  row_count: number;
  execution_time_ms: number;
  error?: string;
  affected_rows?: number;
}

export interface PageRequest {
  limit: number;
  offset: number;
  order_by?: string;
  order_desc: boolean;
}

export interface ParseError {
  message: string;
  line?: number;
  col?: number;
}

// ── IPC calls ─────────────────────────────────────────────────────────────────

/** Default ceiling for a browse/metadata round-trip. Generous — this is a
 *  stuck-call backstop, not a query budget. */
export const IPC_TIMEOUT_MS = 60_000;

/**
 * Reject a call that never settles.
 *
 * A Tauri `invoke` promise that neither resolves nor rejects (a command that
 * never returns a response) wedges every caller awaiting it — including the
 * table grid's loader, whose `finally` then never runs and leaves the loading
 * overlay stuck on top of otherwise-good rows with nothing able to clear it.
 * Turning that into a rejection lets normal error handling take over.
 */
export function withTimeout<T>(
  p: Promise<T>,
  what: string,
  ms = IPC_TIMEOUT_MS,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${what} timed out after ${Math.round(ms / 1000)}s`)),
      ms,
    );
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

export const ipc = {
  connectDb:           (config: ConnectionConfig)                               => invoke<string>("connect_db", { config }),
  disconnectDb:        (connId: string)                                         => invoke<void>("disconnect_db", { connId }),
  testConnection:      (config: ConnectionConfig)                               => invoke<boolean>("test_connection", { config }),

  listDatabases:       (connId: string)                                         => invoke<string[]>("list_databases", { connId }),
  createDatabase:      (connId: string, name: string)                           => invoke<void>("create_database", { connId, name }),
  listSchemas:         (connId: string)                                         => invoke<SchemaInfo[]>("list_schemas", { connId }),
  listTables:          (connId: string, schema?: string)                        => invoke<TableInfo[]>("list_tables", { connId, schema }),
  describeTable:       (connId: string, schema: string|undefined, table: string) => withTimeout(invoke<[ColumnInfo[], IndexInfo[]]>("describe_table", { connId, schema, table }), `describe ${table}`),

  executeQuery:        (connId: string, sql: string, requestId: string)          => invoke<QueryResult>("execute_query", { connId, sql, requestId }),
  cancelQuery:         (requestId: string)                                        => invoke<void>("cancel_query", { requestId }),
  fetchTableRows:      (connId: string, schema: string|undefined, table: string, page: PageRequest, whereClause?: string) =>
                         withTimeout(invoke<QueryResult>("fetch_table_rows", { connId, schema, table, page, whereClause }), `fetch ${table}`),
  countRows:           (connId: string, schema: string|undefined, table: string, whereClause?: string) =>
                         withTimeout(invoke<number>("count_rows", { connId, schema, table, whereClause }), `count ${table}`),

  validateSql:         (config: ConnectionConfig, sql: string)                  => invoke<ParseError|null>("validate_sql", { config, sql }),

  parseConnectionUrl:  (url: string)                                            => invoke<ConnectionConfig>("parse_connection_url", { url }),
  saveConnection:      (config: ConnectionConfig)                               => invoke<string>("save_connection", { config }),
  loadConnections:     ()                                                       => invoke<ConnectionConfig[]>("load_connections"),
  deleteConnection:    (connId: string)                                         => invoke<void>("delete_connection", { connId }),

  syncThemeMenu:       (theme: string)                                          => invoke<void>("sync_theme_menu", { theme }),
  syncQueryMenu:       (tabs: { id: string; title: string }[], activeTabId: string | null) =>
                         invoke<void>("sync_query_menu", { tabs, activeTabId }),

  beginTransaction:    (connId: string)                                         => invoke<void>("begin_transaction", { connId }),
  commitTransaction:   (connId: string)                                         => invoke<void>("commit_transaction", { connId }),
  rollbackTransaction: (connId: string)                                         => invoke<void>("rollback_transaction", { connId }),
  inTransaction:       (connId: string)                                         => invoke<boolean>("in_transaction", { connId }),
};
