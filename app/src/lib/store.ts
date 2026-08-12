import type {
  ConnectionConfig,
  QueryResult,
  TableInfo,
  SchemaInfo,
  ColumnInfo,
  RowValue,
} from "./ipc";
import type { FilterRule } from "./filter";

// ── Reactive mini-store (no framework) ───────────────────────────────────────

type Listener<T> = (val: T) => void;

export class Signal<T> {
  private _val: T;
  private _listeners: Set<Listener<T>> = new Set();

  constructor(initial: T) {
    this._val = initial;
  }

  get value(): T {
    return this._val;
  }

  set(val: T) {
    this._val = val;
    this._listeners.forEach((l) => l(val));
  }

  subscribe(l: Listener<T>): () => void {
    this._listeners.add(l);
    return () => this._listeners.delete(l);
  }
}

// ── Theme ─────────────────────────────────────────────────────────────────────

export type ThemeType = "bios" | "monokai" | "dark" | "light" | "catppuccin" | "ayu-dark" | "ayu-light";

export interface ThemeMeta {
  label: string;
  icon: string;
}

export const THEMES: Record<ThemeType, ThemeMeta> = {
  bios:       { label: "BIOS",        icon: "●" },
  monokai:    { label: "Monokai",     icon: "●" },
  dark:       { label: "Dark",        icon: "●" },
  light:      { label: "Light",       icon: "○" },
  catppuccin: { label: "Catppuccin",  icon: "●" },
  "ayu-dark": { label: "Ayu Dark",    icon: "●" },
  "ayu-light":{ label: "Ayu Light",   icon: "○" },
};

// ── App State ─────────────────────────────────────────────────────────────────

export interface ActiveConnection {
  connId: string;
  config: ConnectionConfig;
  /** All databases available to this user */
  databases: string[];
  selectedDatabase?: string;
  schemas: SchemaInfo[];
  selectedSchema?: string;
  tables: TableInfo[];
  selectedTable?: string;
}

export interface TableState {
  result?: QueryResult;
  totalRows: number;
  page: number;
  pageSize: number;
  orderBy?: string;
  orderDesc: boolean;
  whereClause: string;
  loading: boolean;
  error?: string;
  columns: ColumnInfo[];
}

export interface SelectedRecord {
  rowIndex: number;
  original: RowValue[];
  draft: RowValue[];
  dirty: boolean;
}

// ── Unified tab model ─────────────────────────────────────────────────────────
// Every open table or SQL query is a tab in one strip (TablePlus-style).

export interface TableTab {
  id: string;
  kind: "table";
  name: string;
  schema?: string;
  database?: string;
  connId: string;
  // Per-tab state — preserved when switching between tabs
  tableState: TableState;
  tableMetadata: ColumnInfo[];
  selectedRecord: SelectedRecord | null;
  filterRules: FilterRule[];
}

export interface QueryTab {
  id: string;
  kind: "query";
  title: string;
  connId: string;
  // Per-tab state — preserved when switching between tabs
  sqlDoc: string;
  sqlResult: QueryResult | null;
}

export type AppTab = TableTab | QueryTab;

export const appState = {
  theme: new Signal<ThemeType>("bios"),
  connections: new Signal<ConnectionConfig[]>([]),
  activeConn: new Signal<ActiveConnection | null>(null),
  tableState: new Signal<TableState>({
    totalRows: 0,
    page: 0,
    pageSize: 100,
    orderDesc: false,
    whereClause: "",
    loading: false,
    columns: [],
  }),
  tableMetadata: new Signal<ColumnInfo[]>([]),
  selectedRecord: new Signal<SelectedRecord | null>(null),
  status: new Signal<string>("Ready"),
  openTabs: new Signal<AppTab[]>([]),
  activeTab: new Signal<string | null>(null),
  filterRules: new Signal<FilterRule[]>([]),
};
