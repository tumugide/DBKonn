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
}

export interface ColumnInfo {
  name: string;
  data_type: string;
  nullable: boolean;
  is_primary_key: boolean;
  default_value?: string;
  max_length?: number;
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

export const ipc = {
  connectDb:           (config: ConnectionConfig)                               => invoke<string>("connect_db", { config }),
  disconnectDb:        (connId: string)                                         => invoke<void>("disconnect_db", { connId }),
  testConnection:      (config: ConnectionConfig)                               => invoke<boolean>("test_connection", { config }),
  getActiveConnections:()                                                       => invoke<string[]>("get_active_connections"),

  listDatabases:       (connId: string)                                         => invoke<string[]>("list_databases", { connId }),
  listSchemas:         (connId: string)                                         => invoke<SchemaInfo[]>("list_schemas", { connId }),
  listTables:          (connId: string, schema?: string)                        => invoke<TableInfo[]>("list_tables", { connId, schema }),
  describeTable:       (connId: string, schema: string|undefined, table: string) => invoke<[ColumnInfo[], IndexInfo[]]>("describe_table", { connId, schema, table }),

  executeQuery:        (connId: string, sql: string)                            => invoke<QueryResult>("execute_query", { connId, sql }),
  fetchTableRows:      (connId: string, schema: string|undefined, table: string, page: PageRequest, whereClause?: string) =>
                         invoke<QueryResult>("fetch_table_rows", { connId, schema, table, page, whereClause }),
  countRows:           (connId: string, schema: string|undefined, table: string, whereClause?: string) =>
                         invoke<number>("count_rows", { connId, schema, table, whereClause }),

  validateSql:         (config: ConnectionConfig, sql: string)                  => invoke<ParseError|null>("validate_sql", { config, sql }),

  saveConnection:      (config: ConnectionConfig)                               => invoke<string>("save_connection", { config }),
  loadConnections:     ()                                                       => invoke<ConnectionConfig[]>("load_connections"),
  deleteConnection:    (connId: string)                                         => invoke<void>("delete_connection", { connId }),
};
