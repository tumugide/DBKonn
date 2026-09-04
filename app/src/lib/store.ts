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
    // Skip a no-op set (common for the primitive signals — status, theme,
    // activeTab, activeConnId — which re-fire subscribers, and their IPC,
    // on every write). Object signals always get a fresh reference from
    // their callers, so this never suppresses a real change there.
    if (Object.is(this._val, val)) return;
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

// ── Connection colors ────────────────────────────────────────────────────────
// A small curated palette users can tag connections with, so e.g. production
// vs. staging vs. local are distinguishable at a glance in the rail/sidebar
// without having to read the name every time.

export const CONNECTION_COLORS: string[] = [
  "#e06c75", // red
  "#e5943f", // orange
  "#e5c07b", // yellow
  "#98c379", // green
  "#56b6c2", // teal
  "#61afef", // blue
  "#c678dd", // purple
  "#abb2bf", // gray
];

// ── App State ─────────────────────────────────────────────────────────────────

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

// ── Connection sessions ─────────────────────────────────────────────────────────
// A ConnSession is one open (connected) database — several can be open at
// once (TablePlus-style). `id` is a stable identity for the session itself;
// `connId` is the live IPC handle, which can change (e.g. switchDatabase
// disconnects and reconnects under the hood).

export interface ConnSession {
  id: string;
  connId: string;
  config: ConnectionConfig;
  /** All databases available to this user */
  databases: string[];
  selectedDatabase?: string;
  schemas: SchemaInfo[];
  selectedSchema?: string;
  tables: TableInfo[];
  selectedTable?: string;
  // Per-session tab strip — mirrored to/from the top-level openTabs/activeTab
  // signals below whenever this session is the focused one.
  openTabs: AppTab[];
  activeTabId: string | null;
}

export const appState = {
  theme: new Signal<ThemeType>("bios"),
  connections: new Signal<ConnectionConfig[]>([]),
  // The focused connection session (mirrors the matching entry in
  // connSessions — see the sync subscriptions below).
  activeConn: new Signal<ConnSession | null>(null),
  // Every currently open connection session, focused or not.
  connSessions: new Signal<ConnSession[]>([]),
  activeConnId: new Signal<string | null>(null),
  // Scratch signals for whichever tab is active in the focused session —
  // hydrated from / flushed into that tab's own record on every switch.
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
  /** True when the focused connection has an active transaction. */
  transactionActive: new Signal<boolean>(false),
  // The focused session's tab strip — mirrored into connSessions (see below).
  openTabs: new Signal<AppTab[]>([]),
  activeTab: new Signal<string | null>(null),
  filterRules: new Signal<FilterRule[]>([]),
};

// Keep connSessions in sync with whatever the focused session's live state
// is, so the connection rail + session persistence always reflect reality
// without every call site that mutates activeConn/openTabs/activeTab having
// to know about connSessions too.
function syncActiveSessionField(id: string | null, updater: (s: ConnSession) => ConnSession) {
  if (!id) return;
  const list = appState.connSessions.value;
  const idx = list.findIndex((s) => s.id === id);
  if (idx === -1) return;
  const next = [...list];
  next[idx] = updater(next[idx]!);
  appState.connSessions.set(next);
}

appState.activeConn.subscribe((ac) => {
  if (!ac) return;
  syncActiveSessionField(ac.id, (s) => ({ ...ac, openTabs: s.openTabs, activeTabId: s.activeTabId }));
});
appState.openTabs.subscribe((tabs) => {
  syncActiveSessionField(appState.activeConnId.value, (s) => ({ ...s, openTabs: tabs }));
});
appState.activeTab.subscribe((tabId) => {
  syncActiveSessionField(appState.activeConnId.value, (s) => ({ ...s, activeTabId: tabId }));
});
