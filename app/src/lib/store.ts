import type {
  ConnectionConfig,
  QueryResult,
  TableInfo,
  SchemaInfo,
  ColumnInfo,
  RowValue,
} from "./ipc";

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

// ── App State ─────────────────────────────────────────────────────────────────

export type MainView = "table" | "sql" | "connections";

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

export const appState = {
  connections: new Signal<ConnectionConfig[]>([]),
  activeConn: new Signal<ActiveConnection | null>(null),
  mainView: new Signal<MainView>("connections"),
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
  sqlResult: new Signal<QueryResult | null>(null),
  sqlLoading: new Signal<boolean>(false),
  sqlError: new Signal<string | null>(null),
  status: new Signal<string>("READY"),
};
