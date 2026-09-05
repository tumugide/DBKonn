import { EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { sql, PostgreSQL, MySQL, SQLite, MSSQL } from "@codemirror/lang-sql";
import { autocompletion, completionKeymap } from "@codemirror/autocomplete";
import { syntaxHighlighting, HighlightStyle } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";

import { ipc, type ConnectionConfig, type ColumnInfo, type QueryResult, type RowValue, type SavedQuery } from "../lib/ipc";
import { appState, type ThemeType } from "../lib/store";
import { DataGrid } from "./DataGrid";
import { createExportButton, type ExportButton } from "./ExportMenu";
import { saveExport, formatMeta, type ExportFormat } from "../lib/export";
import { splitStatements, statementIndexAt } from "../lib/sqlSplit";
import { addHistory, getHistory, clearHistory, historyLabel } from "../lib/queryHistory";
import { openSqlFile, openCsvFile, parseCsv, buildInsertStatements } from "../lib/import";
import { escapeHtml } from "../lib/escape";

type ThemeConfig = {
  theme: ReturnType<typeof EditorView.theme>;
  highlight: ReturnType<typeof syntaxHighlighting>;
};

const themeConfigs: Record<ThemeType, ThemeConfig> = {
  bios: {
    theme: EditorView.theme(
      {
        "&": {
          background: "#000000",
          color: "#33ff33",
          height: "100%",
          fontFamily: '"JetBrains Mono","Fira Code","Courier New",monospace',
          fontSize: "13px",
        },
        ".cm-content": { caretColor: "#33ff33", padding: "4px 0" },
        ".cm-cursor": { borderLeftColor: "#33ff33", borderLeftWidth: "2px" },
        "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": {
          background: "#005500",
        },
        ".cm-activeLine": { background: "#001500" },
        ".cm-gutters": {
          background: "#000000",
          color: "#004400",
          border: "none",
          borderRight: "1px solid #003300",
        },
        ".cm-activeLineGutter": { background: "#001500", color: "#007700" },
        ".cm-lineNumbers .cm-gutterElement": { color: "#004400" },
        ".cm-tooltip": {
          background: "#001200",
          border: "1px solid #00aa00",
          color: "#33ff33",
          fontFamily: '"JetBrains Mono","Courier New",monospace',
          fontSize: "12px",
        },
        ".cm-tooltip-autocomplete ul li[aria-selected]": {
          background: "#007700",
          color: "#000000",
        },
        ".cm-scroller": { overflow: "auto" },
      },
      { dark: true },
    ),
    highlight: syntaxHighlighting(
      HighlightStyle.define([
        { tag: t.keyword, color: "#ffffff", fontWeight: "bold" },
        { tag: t.comment, color: "#006600", fontStyle: "italic" },
        { tag: t.string, color: "#ffff00" },
        { tag: t.number, color: "#00ffff" },
        { tag: t.operator, color: "#33ff33" },
        { tag: t.punctuation, color: "#33ff33" },
        { tag: t.name, color: "#33ff33" },
        { tag: t.typeName, color: "#00ffff" },
        { tag: t.function(t.name), color: "#ffffff" },
        { tag: t.special(t.string), color: "#ffaa00" },
        { tag: t.variableName, color: "#33ff33" },
      ]),
    ),
  },

  monokai: {
    theme: EditorView.theme(
      {
        "&": {
          background: "#272822",
          color: "#f8f8f2",
          height: "100%",
          fontFamily: '"JetBrains Mono","Fira Code","Courier New",monospace',
          fontSize: "13px",
        },
        ".cm-content": { caretColor: "#f8f8f2", padding: "4px 0" },
        ".cm-cursor": { borderLeftColor: "#f8f8f2", borderLeftWidth: "2px" },
        "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": {
          background: "#49483e",
        },
        ".cm-activeLine": { background: "#31322b" },
        ".cm-gutters": {
          background: "#272822",
          color: "#4a4a3e",
          border: "none",
          borderRight: "1px solid #4a4a3e",
        },
        ".cm-activeLineGutter": { background: "#31322b", color: "#75715e" },
        ".cm-lineNumbers .cm-gutterElement": { color: "#4a4a3e" },
        ".cm-tooltip": {
          background: "#2d2e27",
          border: "1px solid #75715e",
          color: "#f8f8f2",
          fontFamily: '"JetBrains Mono","Courier New",monospace',
          fontSize: "12px",
        },
        ".cm-tooltip-autocomplete ul li[aria-selected]": {
          background: "#49483e",
          color: "#f8f8f2",
        },
        ".cm-scroller": { overflow: "auto" },
      },
      { dark: true },
    ),
    highlight: syntaxHighlighting(
      HighlightStyle.define([
        { tag: t.keyword, color: "#f92672", fontWeight: "bold" },
        { tag: t.comment, color: "#75715e", fontStyle: "italic" },
        { tag: t.string, color: "#e6db74" },
        { tag: t.number, color: "#ae81ff" },
        { tag: t.operator, color: "#f92672" },
        { tag: t.punctuation, color: "#f8f8f2" },
        { tag: t.name, color: "#f8f8f2" },
        { tag: t.typeName, color: "#66d9ef" },
        { tag: t.function(t.name), color: "#a6e22e" },
        { tag: t.special(t.string), color: "#fd971f" },
        { tag: t.variableName, color: "#f8f8f2" },
      ]),
    ),
  },

  dark: {
    theme: EditorView.theme(
      {
        "&": {
          background: "#1a1a1a",
          color: "#e0e0e0",
          height: "100%",
          fontFamily: '"Inter","SF Pro","Helvetica Neue",sans-serif',
          fontSize: "13px",
        },
        ".cm-content": { caretColor: "#e0e0e0", padding: "4px 0" },
        ".cm-cursor": { borderLeftColor: "#e0e0e0", borderLeftWidth: "2px" },
        "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": {
          background: "#4a9eff",
          opacity: 0.35,
        },
        ".cm-activeLine": { background: "#252525" },
        ".cm-gutters": {
          background: "#1a1a1a",
          color: "#333333",
          border: "none",
          borderRight: "1px solid #333333",
        },
        ".cm-activeLineGutter": { background: "#252525", color: "#666666" },
        ".cm-lineNumbers .cm-gutterElement": { color: "#333333" },
        ".cm-tooltip": {
          background: "#222222",
          border: "1px solid #4a9eff",
          color: "#e0e0e0",
          fontFamily: '"Inter","SF Pro","Helvetica Neue",sans-serif',
          fontSize: "12px",
        },
        ".cm-tooltip-autocomplete ul li[aria-selected]": {
          background: "#4a9eff",
          color: "#ffffff",
        },
        ".cm-scroller": { overflow: "auto" },
      },
      { dark: true },
    ),
    highlight: syntaxHighlighting(
      HighlightStyle.define([
        { tag: t.keyword, color: "#4a9eff", fontWeight: "bold" },
        { tag: t.comment, color: "#666666", fontStyle: "italic" },
        { tag: t.string, color: "#e6b450" },
        { tag: t.number, color: "#b388ff" },
        { tag: t.operator, color: "#e0e0e0" },
        { tag: t.punctuation, color: "#e0e0e0" },
        { tag: t.name, color: "#e0e0e0" },
        { tag: t.typeName, color: "#4a9eff" },
        { tag: t.function(t.name), color: "#4caf50" },
        { tag: t.special(t.string), color: "#ff8a3c" },
        { tag: t.variableName, color: "#e0e0e0" },
      ]),
    ),
  },

  light: {
    theme: EditorView.theme(
      {
        "&": {
          background: "#fafafa",
          color: "#1a1a1a",
          height: "100%",
          fontFamily: '"Inter","SF Pro","Helvetica Neue",sans-serif',
          fontSize: "13px",
        },
        ".cm-content": { caretColor: "#1a1a1a", padding: "4px 0" },
        ".cm-cursor": { borderLeftColor: "#1a1a1a", borderLeftWidth: "2px" },
        "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": {
          background: "#2563eb",
          opacity: 0.25,
        },
        ".cm-activeLine": { background: "#f0f0f0" },
        ".cm-gutters": {
          background: "#fafafa",
          color: "#cccccc",
          border: "none",
          borderRight: "1px solid #d4d4d4",
        },
        ".cm-activeLineGutter": { background: "#f0f0f0", color: "#888888" },
        ".cm-lineNumbers .cm-gutterElement": { color: "#cccccc" },
        ".cm-tooltip": {
          background: "#ffffff",
          border: "1px solid #2563eb",
          color: "#1a1a1a",
          fontFamily: '"Inter","SF Pro","Helvetica Neue",sans-serif',
          fontSize: "12px",
        },
        ".cm-tooltip-autocomplete ul li[aria-selected]": {
          background: "#2563eb",
          color: "#ffffff",
        },
        ".cm-scroller": { overflow: "auto" },
      },
      { dark: false },
    ),
    highlight: syntaxHighlighting(
      HighlightStyle.define([
        { tag: t.keyword, color: "#2563eb", fontWeight: "bold" },
        { tag: t.comment, color: "#888888", fontStyle: "italic" },
        { tag: t.string, color: "#ca8a04" },
        { tag: t.number, color: "#7c3aed" },
        { tag: t.operator, color: "#1a1a1a" },
        { tag: t.punctuation, color: "#1a1a1a" },
        { tag: t.name, color: "#1a1a1a" },
        { tag: t.typeName, color: "#0891b2" },
        { tag: t.function(t.name), color: "#16a34a" },
        { tag: t.special(t.string), color: "#ea580c" },
        { tag: t.variableName, color: "#1a1a1a" },
      ]),
    ),
  },

  catppuccin: {
    theme: EditorView.theme(
      {
        "&": {
          background: "#1e1e2e",
          color: "#cdd6f4",
          height: "100%",
          fontFamily: '"Inter","SF Pro","Helvetica Neue",sans-serif',
          fontSize: "13px",
        },
        ".cm-content": { caretColor: "#cdd6f4", padding: "4px 0" },
        ".cm-cursor": { borderLeftColor: "#cdd6f4", borderLeftWidth: "2px" },
        "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": {
          background: "#cba6f7",
          opacity: 0.3,
        },
        ".cm-activeLine": { background: "#2a2a3d" },
        ".cm-gutters": {
          background: "#1e1e2e",
          color: "#45475a",
          border: "none",
          borderRight: "1px solid #45475a",
        },
        ".cm-activeLineGutter": { background: "#2a2a3d", color: "#6c7086" },
        ".cm-lineNumbers .cm-gutterElement": { color: "#45475a" },
        ".cm-tooltip": {
          background: "#252537",
          border: "1px solid #6c7086",
          color: "#cdd6f4",
          fontFamily: '"Inter","SF Pro","Helvetica Neue",sans-serif',
          fontSize: "12px",
        },
        ".cm-tooltip-autocomplete ul li[aria-selected]": {
          background: "#cba6f7",
          color: "#1e1e2e",
        },
        ".cm-scroller": { overflow: "auto" },
      },
      { dark: true },
    ),
    highlight: syntaxHighlighting(
      HighlightStyle.define([
        { tag: t.keyword, color: "#cba6f7", fontWeight: "bold" },
        { tag: t.comment, color: "#6c7086", fontStyle: "italic" },
        { tag: t.string, color: "#f9e2af" },
        { tag: t.number, color: "#fab387" },
        { tag: t.operator, color: "#89b4fa" },
        { tag: t.punctuation, color: "#cdd6f4" },
        { tag: t.name, color: "#cdd6f4" },
        { tag: t.typeName, color: "#89b4fa" },
        { tag: t.function(t.name), color: "#a6e3a1" },
        { tag: t.special(t.string), color: "#f38ba8" },
        { tag: t.variableName, color: "#cdd6f4" },
      ]),
    ),
  },

  "ayu-dark": {
    theme: EditorView.theme(
      {
        "&": {
          background: "#0b0e14",
          color: "#b3b1ad",
          height: "100%",
          fontFamily: '"Inter","SF Pro","Helvetica Neue",sans-serif',
          fontSize: "13px",
        },
        ".cm-content": { caretColor: "#b3b1ad", padding: "4px 0" },
        ".cm-cursor": { borderLeftColor: "#b3b1ad", borderLeftWidth: "2px" },
        "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": {
          background: "#ff8a3c",
          opacity: 0.3,
        },
        ".cm-activeLine": { background: "#1a1f29" },
        ".cm-gutters": {
          background: "#0b0e14",
          color: "#363a40",
          border: "none",
          borderRight: "1px solid #363a40",
        },
        ".cm-activeLineGutter": { background: "#1a1f29", color: "#5c6166" },
        ".cm-lineNumbers .cm-gutterElement": { color: "#363a40" },
        ".cm-tooltip": {
          background: "#131721",
          border: "1px solid #5c6166",
          color: "#b3b1ad",
          fontFamily: '"Inter","SF Pro","Helvetica Neue",sans-serif',
          fontSize: "12px",
        },
        ".cm-tooltip-autocomplete ul li[aria-selected]": {
          background: "#ff8a3c",
          color: "#ffffff",
        },
        ".cm-scroller": { overflow: "auto" },
      },
      { dark: true },
    ),
    highlight: syntaxHighlighting(
      HighlightStyle.define([
        { tag: t.keyword, color: "#ff8a3c", fontWeight: "bold" },
        { tag: t.comment, color: "#5c6166", fontStyle: "italic" },
        { tag: t.string, color: "#e6b450" },
        { tag: t.number, color: "#d4bfff" },
        { tag: t.operator, color: "#6dcbfa" },
        { tag: t.punctuation, color: "#b3b1ad" },
        { tag: t.name, color: "#b3b1ad" },
        { tag: t.typeName, color: "#6dcbfa" },
        { tag: t.function(t.name), color: "#aad94c" },
        { tag: t.special(t.string), color: "#f26d78" },
        { tag: t.variableName, color: "#b3b1ad" },
      ]),
    ),
  },

  "ayu-light": {
    theme: EditorView.theme(
      {
        "&": {
          background: "#fafafa",
          color: "#5c6166",
          height: "100%",
          fontFamily: '"Inter","SF Pro","Helvetica Neue",sans-serif',
          fontSize: "13px",
        },
        ".cm-content": { caretColor: "#5c6166", padding: "4px 0" },
        ".cm-cursor": { borderLeftColor: "#5c6166", borderLeftWidth: "2px" },
        "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": {
          background: "#ff8a3c",
          opacity: 0.25,
        },
        ".cm-activeLine": { background: "#f0f0f0" },
        ".cm-gutters": {
          background: "#fafafa",
          color: "#d0d0d0",
          border: "none",
          borderRight: "1px solid #d5d5d5",
        },
        ".cm-activeLineGutter": { background: "#f0f0f0", color: "#a3a3a3" },
        ".cm-lineNumbers .cm-gutterElement": { color: "#d0d0d0" },
        ".cm-tooltip": {
          background: "#ffffff",
          border: "1px solid #a3a3a3",
          color: "#5c6166",
          fontFamily: '"Inter","SF Pro","Helvetica Neue",sans-serif',
          fontSize: "12px",
        },
        ".cm-tooltip-autocomplete ul li[aria-selected]": {
          background: "#ff8a3c",
          color: "#ffffff",
        },
        ".cm-scroller": { overflow: "auto" },
      },
      { dark: false },
    ),
    highlight: syntaxHighlighting(
      HighlightStyle.define([
        { tag: t.keyword, color: "#ff8a3c", fontWeight: "bold" },
        { tag: t.comment, color: "#a3a3a3", fontStyle: "italic" },
        { tag: t.string, color: "#f2ae49" },
        { tag: t.number, color: "#a37acc" },
        { tag: t.operator, color: "#36a3d9" },
        { tag: t.punctuation, color: "#5c6166" },
        { tag: t.name, color: "#5c6166" },
        { tag: t.typeName, color: "#36a3d9" },
        { tag: t.function(t.name), color: "#86b300" },
        { tag: t.special(t.string), color: "#f07178" },
        { tag: t.variableName, color: "#5c6166" },
      ]),
    ),
  },
};

// ── Dialect map ───────────────────────────────────────────────────────────────

const DIALECT_MAP = {
  postgres: PostgreSQL,
  mysql: MySQL,
  sqlite: SQLite,
  mssql: MSSQL,
} as const;

// ── SqlEditor component ───────────────────────────────────────────────────────

export interface SqlEditorOptions {
  initialDoc?: string;
  initialResult?: QueryResult | null;
  /** Initial result sets, one per statement (used on tab restore). */
  initialResults?: QueryResult[];
  onRowClick?: (row: RowValue[], rowIndex: number, columns: ColumnInfo[]) => void;
  /** Called just before a fresh result set replaces the current one. */
  onBeforeNewResult?: () => void;
}

export class SqlEditor {
  private container: HTMLElement;
  private view?: EditorView;
  private config?: ConnectionConfig;
  private connId?: string;
  private grid?: DataGrid;
  private resultContainer!: HTMLElement;
  private resultTabsEl!: HTMLElement;
  private statusEl!: HTMLElement;
  private errorEl!: HTMLElement;
  private warnEl!: HTMLElement;
  private lastDoc = "SELECT 1;\n";
  private lastResults: QueryResult[] = [];
  private lastRunText = "";
  private activeResultIndex = 0;
  private opts: SqlEditorOptions;
  private unsubTheme?: () => void;
  private exportButton?: ExportButton;
  private stopBtn!: HTMLButtonElement;
  private explainAnalyzeChk!: HTMLInputElement;
  private historyBtn!: HTMLButtonElement;
  private historyEl!: HTMLElement;
  private historySearchEl!: HTMLInputElement;
  private historyListEl!: HTMLElement;
  private savedBtn!: HTMLButtonElement;
  private savedEl!: HTMLElement;
  private savedListEl!: HTMLElement;
  private savedNameEl!: HTMLInputElement;
  private importBtn!: HTMLButtonElement;
  private importMenuEl!: HTMLElement;
  /** Monotonic token for the whole run — lets a cancelled run ignore stale
   *  results and a superseded run ignore an older statement's settle. */
  private runToken = 0;
  /** Monotonic per-statement request id passed to the backend so Stop can
   *  abort the in-flight statement. */
  private reqSeq = 0;
  /** Set when the user hits Stop; the run loop stops after the statement
   *  that's in flight returns. */
  private haltRun = false;
  /** True when the current run was cancelled by Stop (surfaces "Cancelled"). */
  private cancelled = false;
  /** Request id of the statement currently awaiting the backend (if any). */
  private activeRequestId: string | null = null;

  constructor(container: HTMLElement, opts: SqlEditorOptions = {}) {
    this.container = container;
    this.opts = opts;
    if (opts.initialDoc) this.lastDoc = opts.initialDoc;
    this.lastResults = opts.initialResults ?? (opts.initialResult ? [opts.initialResult] : []);
    this.buildLayout();
    this.unsubTheme = appState.theme.subscribe(() => {
      const parent = this.view?.dom.parentElement;
      if (!parent) return;
      this.buildEditor(parent, (this.config?.engine ?? "postgres") as keyof typeof DIALECT_MAP);
    });
  }

  getDoc(): string {
    return this.view ? this.view.state.doc.toString() : this.lastDoc;
  }

  getLastResult(): QueryResult | null {
    return this.lastResults[0] ?? null;
  }

  /** All result sets from the most recent run, in statement order. */
  getResults(): QueryResult[] {
    return this.lastResults;
  }

  /** The SQL text that produced the current results (may differ from the
   * live editor content if it's since been edited without re-running). */
  getLastRunText(): string {
    return this.lastRunText;
  }

  destroy() {
    this.unsubTheme?.();
    this.view?.destroy();
  }

  private buildLayout() {
    this.container.innerHTML = "";
    this.container.style.cssText =
      "display:flex;flex-direction:column;height:100%;overflow:hidden;position:relative;";

    // Toolbar
    const toolbar = document.createElement("div");
    toolbar.className = "editor-toolbar";

    const runBtn = document.createElement("button");
    runBtn.className = "btn btn-primary";
    runBtn.innerHTML = "▶ Run";
    runBtn.title = "Run query (⌘⏎)";
    runBtn.onclick = () => this.run();

    // Stop button — only relevant while a query is in flight.
    this.stopBtn = document.createElement("button");
    this.stopBtn.className = "btn";
    this.stopBtn.innerHTML = "■ Stop";
    this.stopBtn.title = "Cancel the running query";
    this.stopBtn.style.display = "none";
    this.stopBtn.onclick = () => this.cancelRun();

    // EXPLAIN button — runs `EXPLAIN [ANALYZE] <sql>` and shows the raw plan.
    const explainBtn = document.createElement("button");
    explainBtn.className = "btn";
    explainBtn.innerHTML = "EXPLAIN";
    explainBtn.title = "Show the query plan for the current statement";
    explainBtn.onclick = () => this.explain();

    this.explainAnalyzeChk = document.createElement("input");
    this.explainAnalyzeChk.type = "checkbox";
    this.explainAnalyzeChk.id = "editor-explain-analyze";
    this.explainAnalyzeChk.title = "Include execution (EXPLAIN ANALYZE)";
    const analyzeLabel = document.createElement("label");
    analyzeLabel.htmlFor = "editor-explain-analyze";
    analyzeLabel.textContent = "Analyze";
    analyzeLabel.title = "Run EXPLAIN ANALYZE (executes the statement)";
    analyzeLabel.style.cssText = "font-size:11px;color:var(--text-muted);display:flex;gap:3px;align-items:center;";

    // Query history button — opens a searchable, re-runnable panel.
    this.historyBtn = document.createElement("button");
    this.historyBtn.className = "btn";
    this.historyBtn.innerHTML = "History";
    this.historyBtn.title = "Search past queries";
    this.historyBtn.onclick = () => this.toggleHistory();

    // Saved queries / snippets button.
    this.savedBtn = document.createElement("button");
    this.savedBtn.className = "btn";
    this.savedBtn.innerHTML = "Saved";
    this.savedBtn.title = "Save / load named queries for this connection";
    this.savedBtn.onclick = () => this.toggleSaved();

    // Import button — runs a `.sql` file or imports a CSV into a table.
    this.importBtn = document.createElement("button");
    this.importBtn.className = "btn";
    this.importBtn.innerHTML = "Import";
    this.importBtn.title = "Run a .sql file, or import a CSV into a table";
    this.importBtn.onclick = () => this.toggleImportMenu();

    this.statusEl = document.createElement("span");
    this.statusEl.style.cssText =
      "font-size:11px;color:var(--text-muted);flex:1;";

    this.exportButton = createExportButton({
      formats: ["csv", "tsv", "xlsx", "json", "markdown", "html", "sql"],
      onSelect: (format) => this.exportResult(format),
    });
    this.exportButton.setDisabled(!this.hasExportableResult());

    toolbar.appendChild(runBtn);
    toolbar.appendChild(this.stopBtn);
    toolbar.appendChild(explainBtn);
    toolbar.appendChild(analyzeLabel);
    analyzeLabel.appendChild(this.explainAnalyzeChk);
    toolbar.appendChild(this.historyBtn);
    toolbar.appendChild(this.savedBtn);
    toolbar.appendChild(this.importBtn);
    toolbar.appendChild(this.statusEl);
    toolbar.appendChild(this.exportButton.element);

    // Advisory validation warning (dismissible) — shown when the local
    // parser dislikes the SQL, but the query still runs (the parser's
    // dialect coverage is incomplete: DO $$, COPY, vendor syntax, …).
    this.warnEl = document.createElement("div");
    this.warnEl.className = "warn-banner";
    this.warnEl.style.display = "none";

    // Error banner
    this.errorEl = document.createElement("div");
    this.errorEl.className = "error-banner";
    this.errorEl.style.display = "none";

    // Editor pane
    const editorPane = document.createElement("div");
    editorPane.style.cssText = "flex:1;overflow:hidden;min-height:120px;";

    // Results pane
    this.resultContainer = document.createElement("div");
    this.resultContainer.style.cssText = [
      "height:42%;",
      "border-top:1px solid var(--border-mid);",
      "overflow:hidden;",
      "display:flex;",
      "flex-direction:column;",
    ].join("");

    // Result tabs (only visible when a run produced more than one statement)
    this.resultTabsEl = document.createElement("div");
    this.resultTabsEl.className = "result-tabs";
    this.resultTabsEl.style.display = "none";

    this.container.appendChild(toolbar);
    this.container.appendChild(editorPane);
    this.container.appendChild(this.warnEl);
    this.container.appendChild(this.errorEl);
    this.container.appendChild(this.resultContainer);
    this.resultContainer.appendChild(this.resultTabsEl);
    this.buildHistoryPanel();
    this.buildSavedPanel();
    this.buildImportMenu();

    this.grid = new DataGrid({
      container: this.resultContainer,
      onHeaderClick: () => {},
      onRowClick: (row, rowIndex) => {
        this.grid?.setSelectedRow(rowIndex);
        const active = this.lastResults[this.activeResultIndex];
        this.opts.onRowClick?.(row, rowIndex, active?.columns ?? []);
      },
    });

    this.refreshResultTabs();
    if (this.lastResults.length > 0) {
      const idx = Math.min(this.activeResultIndex, this.lastResults.length - 1);
      this.showResultAtIndex(idx);
    }
    this.buildEditor(editorPane, "postgres");
  }

  private buildEditor(parent: HTMLElement, engine: keyof typeof DIALECT_MAP) {
    const savedDoc = this.view ? this.view.state.doc.toString() : this.lastDoc;
    this.view?.destroy();

    const dialect = DIALECT_MAP[engine] ?? PostgreSQL;
    const theme = themeConfigs[appState.theme.value];
    const self = this;

    const state = EditorState.create({
      doc: savedDoc,
      extensions: [
        history(),
        theme.highlight,
        sql({ dialect }),
        theme.theme,
        autocompletion(),
        keymap.of([
          ...defaultKeymap,
          ...historyKeymap,
          ...completionKeymap,
          {
            key: "Mod-Enter",
            run() {
              self.run();
              return true;
            },
          },
        ]),
      ],
    });

    this.view = new EditorView({ state, parent });
  }

  setConnection(connId: string, config: ConnectionConfig) {
    const prevEngine = this.config?.engine;
    this.connId = connId;
    this.config = config;
    if (config.engine !== prevEngine) {
      const parent = this.view?.dom.parentElement;
      if (parent)
        this.buildEditor(parent, config.engine as keyof typeof DIALECT_MAP);
    }
  }

  setSchema(tables: { name: string; columns: ColumnInfo[] }[]) {
    if (!this.view) return;
    const parent = this.view.dom.parentElement;
    if (!parent) return;

    const engine = (this.config?.engine ??
      "postgres") as keyof typeof DIALECT_MAP;
    const dialect = DIALECT_MAP[engine] ?? PostgreSQL;
    const theme = themeConfigs[appState.theme.value];
    const schema: Record<string, string[]> = {};
    for (const t of tables) schema[t.name] = t.columns.map((c) => c.name);

    this.lastDoc = this.view.state.doc.toString();
    this.view.destroy();

    const self = this;
    const state = EditorState.create({
      doc: this.lastDoc,
      extensions: [
        history(),
        theme.highlight,
        sql({ dialect, schema }),
        theme.theme,
        autocompletion(),
        keymap.of([
          ...defaultKeymap,
          ...historyKeymap,
          ...completionKeymap,
          {
            key: "Mod-Enter",
            run() {
              self.run();
              return true;
            },
          },
        ]),
      ],
    });

    this.view = new EditorView({ state, parent });
  }

  async run() {
    if (!this.connId || !this.config) {
      this.setError("No active connection. Connect first.");
      return;
    }

    const statements = this.planRunStatements();
    if (statements.length === 0) return;

    const token = ++this.runToken;
    this.haltRun = false;
    this.cancelled = false;
    this.stopBtn.style.display = "";
    this.stopBtn.disabled = false;

    this.errorEl.style.display = "none";
    this.clearWarning();
    this.setStatus("Validating…");

    const joined = statements.map((s) => s.sql.trim()).filter(Boolean).join(";\n");
    try {
      const parseErr = await ipc.validateSql(this.config, joined);
      if (token !== this.runToken) return; // superseded while validating
      if (parseErr) {
        // Advisory only — the local parser doesn't cover every dialect
        // construct, so a "parse error" here is often a false positive.
        // Surface it and keep going; a genuine problem shows up as a DB
        // error below.
        const where =
          parseErr.line != null
            ? ` (line ${parseErr.line}${parseErr.col != null ? `, col ${parseErr.col}` : ""})`
            : "";
        this.setWarning(`Possible syntax issue${where}: ${parseErr.message}`);
      }
    } catch {
      /* validation is best-effort */
    }

    this.setStatus("Running…");
    this.grid?.setLoading(true);

    const results: QueryResult[] = [];
    let firstError: string | null = null;

    for (const stmt of statements) {
      const sqlText = stmt.sql.trim();
      if (!sqlText) continue;

      const requestId = `${this.connId}:${++this.reqSeq}`;
      this.activeRequestId = requestId;
      try {
        const result = await ipc.executeQuery(this.connId, sqlText, requestId);
        this.activeRequestId = null;
        if (token !== this.runToken) return; // superseded while awaiting
        results.push(result);
        this.logToHistory(sqlText, !result.error);
        if (result.error && firstError === null) firstError = result.error;
      } catch (e) {
        this.activeRequestId = null;
        if (token !== this.runToken) return; // superseded
        const errMsg = String(e);
        if (errMsg.toLowerCase().includes("cancelled")) {
          this.cancelled = true;
          break;
        }
        this.logToHistory(sqlText, false);
        results.push({
          columns: [],
          rows: [],
          row_count: 0,
          execution_time_ms: 0,
          error: errMsg,
        });
        if (firstError === null) firstError = errMsg;
        break; // a thrown/DB error aborts the remaining statements
      }

      // Stop pressed while the previous statement completed — stop the run.
      if (this.haltRun) break;
    }
    this.activeRequestId = null;

    this.stopBtn.style.display = "none";

    if (token !== this.runToken) return; // a newer run took over

    this.lastResults = results;
    this.lastRunText = statements
      .map((s) => s.sql.trim())
      .filter(Boolean)
      .join(";\n");
    this.opts.onBeforeNewResult?.();

    this.refreshResultTabs();
    this.activeResultIndex = 0;
    if (results.length > 0) {
      this.showResultAtIndex(0);
    } else {
      this.grid?.clear();
    }

    if (this.cancelled) {
      this.setStatus("Cancelled");
      this.errorEl.style.display = "none";
    } else if (firstError) {
      this.setError(firstError);
    } else if (results.length > 0) {
      const totalMs = results.reduce((a, r) => a + (r.execution_time_ms ?? 0), 0);
      const totalRows = results.reduce(
        (a, r) => a + (r.affected_rows !== undefined ? r.affected_rows : r.row_count),
        0,
      );
      this.setStatus(
        `${results.length} statement${results.length > 1 ? "s" : ""} · ${totalRows} rows in ${totalMs}ms`,
      );
    } else {
      this.setStatus("No statements to run");
    }

    this.exportButton?.setDisabled(!this.hasExportableResult());
    this.grid?.setLoading(false);
  }

  /** The engine-appropriate raw-plan preface for `sql`. A plain `EXPLAIN`
   *  does not execute the statement; `EXPLAIN ANALYZE` does. */
  private buildExplainSql(sql: string): string {
    const engine = this.config?.engine ?? "postgres";
    const analyze = this.explainAnalyzeChk?.checked ?? false;
    switch (engine) {
      case "mysql":
        return analyze ? `EXPLAIN ANALYZE ${sql}` : `EXPLAIN ${sql}`;
      case "sqlite":
        return `EXPLAIN QUERY PLAN ${sql}`;
      case "mssql":
        // SHOWPLAN converts the statement (and following) into plan output.
        return `SET SHOWPLAN_ALL ON; ${sql}; SET SHOWPLAN_ALL OFF;`;
      case "postgres":
      default:
        return analyze ? `EXPLAIN ANALYZE ${sql}` : `EXPLAIN ${sql}`;
    }
  }

  /** Run `EXPLAIN [ANALYZE]` on the current statement and show the raw plan
   *  as the result grid (and into the result-tab set, so it's exportable). */
  private async explain() {
    if (!this.connId || !this.config) {
      this.setError("No active connection. Connect first.");
      return;
    }
    const statements = this.planRunStatements();
    if (statements.length === 0) return;
    const sqlText = statements[0]!.sql.trim();
    if (!sqlText) return;

    if (this.config.engine === "mssql") {
      // SQL Server has no `EXPLAIN` prefix; plan output requires SHOWPLAN
      // session state that our single-statement execute path doesn't surface.
      // Point users at the manual equivalent.
      this.setWarning(
        "SQL Server has no raw EXPLAIN. To see a plan, run: SET SHOWPLAN_ALL ON; <your query>; SET SHOWPLAN_ALL OFF;",
      );
      return;
    }

    const wrapped = this.buildExplainSql(sqlText);
    const token = ++this.runToken;
    this.haltRun = false;
    this.cancelled = false;
    this.stopBtn.style.display = "";
    this.stopBtn.disabled = false;

    this.errorEl.style.display = "none";
    this.clearWarning();
    this.setStatus("EXPLAIN…");
    this.grid?.setLoading(true);

    const requestId = `${this.connId}:${++this.reqSeq}`;
    this.activeRequestId = requestId;
    let result: QueryResult;
    try {
      result = await ipc.executeQuery(this.connId, wrapped, requestId);
    } catch (e) {
      this.activeRequestId = null;
      if (token !== this.runToken) return;
      const errMsg = String(e);
      if (errMsg.toLowerCase().includes("cancelled")) this.cancelled = true;
      else this.setError(errMsg);
      this.stopBtn.style.display = "none";
      this.grid?.setLoading(false);
      return;
    }
    this.activeRequestId = null;
    if (token !== this.runToken) return;

    this.stopBtn.style.display = "none";
    this.lastResults = [result];
    this.lastRunText = wrapped;
    this.opts.onBeforeNewResult?.();
    this.refreshResultTabs();
    this.activeResultIndex = 0;
    if (result.error) {
      this.setError(result.error);
      this.grid?.clear();
    } else {
      this.grid?.setData(result);
      this.setStatus(
        `Plan: ${result.row_count} rows in ${result.execution_time_ms}ms`,
      );
    }
    this.exportButton?.setDisabled(!this.hasExportableResult());
    this.grid?.setLoading(false);
  }

  /** Record one executed statement in durable history. */
  private logToHistory(sql: string, ok: boolean) {
    addHistory({
      connKey: this.connId ?? "",
      connName: this.config?.name ?? "",
      sql,
      ok,
    });
  }

  private toggleHistory() {
    const visible = this.historyEl.style.display !== "none";
    if (visible) {
      this.historyEl.style.display = "none";
      return;
    }
    this.historyEl.style.display = "flex";
    this.renderHistoryList(this.historySearchEl.value);
    this.historySearchEl.focus();
  }

  private buildHistoryPanel() {
    this.historyEl = document.createElement("div");
    this.historyEl.className = "query-history";
    this.historyEl.style.cssText = [
      "position:absolute;",
      "top:40px;right:8px;",
      "width:380px;max-width:85%;",
      "max-height:60%;",
      "background:var(--bg-surface);",
      "border:1px solid var(--border-mid);",
      "border-radius:var(--radius);",
      "box-shadow:0 8px 30px rgba(0,0,0,0.35);",
      "display:none;",
      "flex-direction:column;",
      "overflow:hidden;",
      "z-index:50;",
    ].join("");

    const head = document.createElement("div");
    head.style.cssText = "display:flex;align-items:center;gap:6px;padding:8px;border-bottom:1px solid var(--border);";

    const title = document.createElement("span");
    title.textContent = "Query History";
    title.style.cssText = "font-size:12px;font-weight:600;flex:1;color:var(--text-primary);";

    this.historySearchEl = document.createElement("input");
    this.historySearchEl.type = "text";
    this.historySearchEl.placeholder = "Search…";
    this.historySearchEl.style.cssText = "flex:1;min-width:0;";
    this.historySearchEl.addEventListener("input", () => {
      this.renderHistoryList(this.historySearchEl.value);
    });
    this.historySearchEl.addEventListener("keydown", (e) => {
      if (e.key === "Escape") this.historyEl.style.display = "none";
    });

    const clearBtn = document.createElement("button");
    clearBtn.className = "btn-icon";
    clearBtn.innerHTML = "🗑";
    clearBtn.title = "Clear history";
    clearBtn.onclick = () => {
      clearHistory();
      this.renderHistoryList("");
    };

    const closeBtn = document.createElement("button");
    closeBtn.className = "btn-icon";
    closeBtn.innerHTML = "✕";
    closeBtn.title = "Close";
    closeBtn.onclick = () => (this.historyEl.style.display = "none");

    head.appendChild(title);
    head.appendChild(this.historySearchEl);
    head.appendChild(clearBtn);
    head.appendChild(closeBtn);

    this.historyListEl = document.createElement("div");
    this.historyListEl.style.cssText = "overflow-y:auto;display:flex;flex-direction:column;";

    this.historyEl.appendChild(head);
    this.historyEl.appendChild(this.historyListEl);
    this.container.appendChild(this.historyEl);
  }

  private renderHistoryList(filter: string) {
    this.historyListEl.textContent = "";
    const entries = getHistory({
      connKey: this.connId ?? undefined,
      text: filter,
      limit: 200,
    });
    if (entries.length === 0) {
      const empty = document.createElement("div");
      empty.textContent = filter ? "No matching queries." : "No query history yet.";
      empty.style.cssText = "padding:20px;text-align:center;color:var(--text-muted);font-size:12px;";
      this.historyListEl.appendChild(empty);
      return;
    }
    for (const entry of entries) {
      const row = document.createElement("div");
      row.className = "query-history-row";
      row.style.cssText = "padding:7px 10px;border-bottom:1px solid var(--border);cursor:pointer;";

      const top = document.createElement("div");
      top.style.cssText = "display:flex;align-items:center;gap:6px;";
      const label = document.createElement("span");
      label.textContent = historyLabel(entry.sql);
      label.style.cssText = "flex:1;font-family:var(--font-mono);font-size:12px;color:var(--text-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";
      const okDot = document.createElement("span");
      okDot.textContent = entry.ok ? "✓" : "✗";
      okDot.style.cssText = `color:${entry.ok ? "var(--accent)" : "var(--danger, #e5484d)"};font-size:11px;`;
      top.appendChild(label);
      top.appendChild(okDot);

      const meta = document.createElement("div");
      const d = new Date(entry.ts);
      meta.textContent = `${entry.connName} · ${d.toLocaleTimeString()}`;
      meta.style.cssText = "font-size:10px;color:var(--text-muted);margin-top:2px;";

      row.onclick = () => {
        this.loadIntoEditor(entry.sql);
        this.historyEl.style.display = "none";
      };
      row.addEventListener("mousedown", (e) => e.preventDefault());
      row.onmouseenter = () => (row.style.background = "var(--bg-hover)");
      row.onmouseleave = () => (row.style.background = "");

      row.appendChild(top);
      row.appendChild(meta);
      this.historyListEl.appendChild(row);
    }
  }

  /** Load a SQL string into the editor (replacing its doc). */
  private loadIntoEditor(sql: string) {
    if (!this.view) return;
    this.view.dispatch({
      changes: { from: 0, to: this.view.state.doc.length, insert: sql },
    });
    this.view.focus();
  }

  /** A reasonable default snippet name from the SQL's first line. */
  private suggestName(): string {
    const doc = this.getDoc().trim();
    const line = doc.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
    return line.slice(0, 40) || "Untitled query";
  }

  private toggleSaved() {
    if (this.savedEl.style.display !== "none") {
      this.savedEl.style.display = "none";
      return;
    }
    this.savedEl.style.display = "flex";
    this.savedNameEl.value = this.suggestName();
    void this.renderSavedList();
  }

  private buildSavedPanel() {
    this.savedEl = document.createElement("div");
    this.savedEl.className = "query-history";
    this.savedEl.style.cssText = [
      "position:absolute;",
      "top:40px;right:8px;",
      "width:360px;max-width:85%;",
      "max-height:60%;",
      "background:var(--bg-surface);",
      "border:1px solid var(--border-mid);",
      "border-radius:var(--radius);",
      "box-shadow:0 8px 30px rgba(0,0,0,0.35);",
      "display:none;",
      "flex-direction:column;",
      "overflow:hidden;",
      "z-index:51;",
    ].join("");

    const head = document.createElement("div");
    head.style.cssText = "display:flex;align-items:center;gap:6px;padding:8px;border-bottom:1px solid var(--border);";
    const title = document.createElement("span");
    title.textContent = "Saved Queries";
    title.style.cssText = "font-size:12px;font-weight:600;flex:1;color:var(--text-primary);";
    const close = document.createElement("button");
    close.className = "btn-icon";
    close.innerHTML = "✕";
    close.title = "Close";
    close.onclick = () => (this.savedEl.style.display = "none");
    head.appendChild(title);
    head.appendChild(close);

    // Save-current section (name input + Save button).
    const saveRow = document.createElement("div");
    saveRow.style.cssText = "display:flex;gap:6px;padding:8px;border-bottom:1px solid var(--border);";
    this.savedNameEl = document.createElement("input");
    this.savedNameEl.type = "text";
    this.savedNameEl.placeholder = "Snippet name";
    this.savedNameEl.style.cssText = "flex:1;min-width:0;";
    const saveBtn = document.createElement("button");
    saveBtn.className = "btn btn-primary";
    saveBtn.innerHTML = "Save current";
    saveBtn.title = "Save the editor contents as a named snippet";
    saveBtn.onclick = () => this.saveCurrentQuery();
    saveRow.appendChild(this.savedNameEl);
    saveRow.appendChild(saveBtn);

    this.savedListEl = document.createElement("div");
    this.savedListEl.style.cssText = "overflow-y:auto;display:flex;flex-direction:column;";

    this.savedEl.appendChild(head);
    this.savedEl.appendChild(saveRow);
    this.savedEl.appendChild(this.savedListEl);
    this.container.appendChild(this.savedEl);
  }

  private async saveCurrentQuery() {
    if (!this.connId) {
      this.setError("No active connection. Connect first.");
      return;
    }
    const name = this.savedNameEl.value.trim();
    const sql = this.getDoc().trim();
    if (!name || !sql) {
      alert("Give the snippet a name and make sure the editor isn't empty.");
      return;
    }
    const now = Date.now();
    const draft: SavedQuery = {
      id: `${this.connId}:${name}`,
      conn_id: this.connId,
      name,
      sql,
      created_at: now,
      updated_at: now,
    };
    try {
      await ipc.saveSavedQuery(draft);
      this.savedNameEl.value = this.suggestName();
      void this.renderSavedList();
    } catch (e) {
      alert(`Save failed: ${e}`);
    }
  }

  private async renderSavedList() {
    this.savedListEl.textContent = "";
    let queries: SavedQuery[];
    try {
      queries = await ipc.loadSavedQueries();
    } catch (e) {
      const err = document.createElement("div");
      err.textContent = `Couldn't load saved queries: ${e}`;
      err.style.cssText = "padding:20px;text-align:center;color:var(--text-muted);font-size:12px;";
      this.savedListEl.appendChild(err);
      return;
    }
    queries = queries
      .filter((q) => q.conn_id === this.connId)
      .sort((a, b) => b.updated_at - a.updated_at);

    if (queries.length === 0) {
      const empty = document.createElement("div");
      empty.textContent = "No saved queries for this connection.";
      empty.style.cssText = "padding:20px;text-align:center;color:var(--text-muted);font-size:12px;";
      this.savedListEl.appendChild(empty);
      return;
    }
    for (const q of queries) {
      const row = document.createElement("div");
      row.className = "query-history-row";
      row.style.cssText = "padding:7px 10px;border-bottom:1px solid var(--border);cursor:pointer;";
      const line = document.createElement("div");
      line.textContent = q.name;
      line.style.cssText = "font-family:var(--font-mono);font-size:12px;color:var(--text-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";
      const meta = document.createElement("div");
      meta.textContent = new Date(q.updated_at).toLocaleString();
      meta.style.cssText = "font-size:10px;color:var(--text-muted);margin-top:2px;";

      row.onclick = () => {
        this.loadIntoEditor(q.sql);
        this.savedEl.style.display = "none";
      };
      row.onmouseenter = () => (row.style.background = "var(--bg-hover)");
      row.onmouseleave = () => (row.style.background = "");

      const del = document.createElement("button");
      del.className = "btn-icon";
      del.innerHTML = "🗑";
      del.title = "Delete snippet";
      del.style.cssText = "position:absolute;right:8px;top:6px;";
      del.onclick = (e) => {
        e.stopPropagation();
        void ipc.deleteSavedQuery(q.id).then(() => this.renderSavedList());
      };

      row.style.cssText += "position:relative;padding-right:34px;";
      row.appendChild(line);
      row.appendChild(meta);
      row.appendChild(del);
      this.savedListEl.appendChild(row);
    }
  }

  private toggleImportMenu() {
    const visible = this.importMenuEl.style.display !== "none";
    if (visible) {
      this.importMenuEl.style.display = "none";
      return;
    }
    this.importMenuEl.style.display = "block";
  }

  private buildImportMenu() {
    this.importMenuEl = document.createElement("div");
    this.importMenuEl.className = "query-history";
    this.importMenuEl.style.cssText = [
      "position:absolute;",
      "top:40px;right:8px;",
      "width:230px;",
      "background:var(--bg-surface);",
      "border:1px solid var(--border-mid);",
      "border-radius:var(--radius);",
      "box-shadow:0 8px 30px rgba(0,0,0,0.35);",
      "display:none;",
      "z-index:52;",
      "overflow:hidden;",
    ].join("");

    const item = (label: string, title: string, fn: () => void) => {
      const el = document.createElement("div");
      el.textContent = label;
      el.title = title;
      el.style.cssText = "padding:9px 12px;cursor:pointer;font-size:12px;color:var(--text-primary);";
      el.onmouseenter = () => (el.style.background = "var(--bg-hover)");
      el.onmouseleave = () => (el.style.background = "");
      el.onclick = () => {
        this.importMenuEl.style.display = "none";
        fn();
      };
      this.importMenuEl.appendChild(el);
    };

    item("Run .sql file", "Load a .sql file into the editor", () => this.importSqlFile());
    item("Import CSV into table…", "Map a CSV into an existing table", () => this.showCsvImportModal());

    this.container.appendChild(this.importMenuEl);
  }

  private async importSqlFile() {
    const picked = await openSqlFile();
    if (!picked) return;
    this.loadIntoEditor(picked.text);
    this.setStatus(`Loaded ${picked.path}`);
  }

  /** Modal for importing a CSV into an existing table. */
  private async showCsvImportModal() {
    if (!this.connId) {
      this.setError("No active connection. Connect first.");
      return;
    }
    const picked = await openCsvFile();
    if (!picked) return;
    const parsed = parseCsv(picked.text);
    if (parsed.headers.length === 0 || parsed.rows.length === 0) {
      alert("That CSV has no usable header row or data rows.");
      return;
    }

    // Load the connection's tables for the picker.
    let tables: { schema?: string; name: string }[];
    try {
      // Call list_tables without a schema — each driver returns its
      // default set of tables (PG public, MySQL current DB, MSSQL dbo, etc.).
      const listed = await ipc.listTables(this.connId);
      tables = listed.map((t) => ({ schema: t.schema, name: t.name }));
    } catch (e) {
      alert(`Couldn't load tables: ${e}`);
      return;
    }

    this.renderCsvImportModal(picked, parsed, tables);
  }

  private renderCsvImportModal(
    picked: { name: string; text: string },
    parsed: { headers: string[]; rows: string[][] },
    tables: { schema?: string; name: string }[],
  ) {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.style.display = "flex";

    const modal = document.createElement("div");
    modal.className = "modal";
    modal.style.cssText = "width:640px;max-width:92vw;max-height:85vh;display:flex;flex-direction:column;";

    const title = document.createElement("h2");
    title.className = "modal-title";
    title.style.cssText = "margin:0;";
    title.textContent = `Import CSV · ${picked.name}`;

    // Target table picker.
    const tableRow = document.createElement("div");
    tableRow.style.cssText = "padding:10px 16px;display:flex;gap:8px;align-items:center;";
    const tableLabel = document.createElement("label");
    tableLabel.textContent = "Into table:";
    tableLabel.style.cssText = "font-size:12px;color:var(--text-muted);";
    const tableSel = document.createElement("select");
    tableSel.style.cssText = "flex:1;min-width:0;";
    tableSel.innerHTML = tables.map((t) => `<option value="${escapeHtml(t.name)}">${escapeHtml((t.schema ? t.schema + "." : "") + t.name)}</option>`).join("");
    tableRow.appendChild(tableLabel);
    tableRow.appendChild(tableSel);

    // Preview (first few rows).
    const preview = document.createElement("div");
    preview.style.cssText = "flex:1;overflow:auto;padding:0 16px 8px;";
    const pRow = document.createElement("div");
    pRow.style.cssText = "font-size:12px;color:var(--text-muted);margin-bottom:6px;";
    pRow.textContent = `${parsed.rows.length} data row(s) · ${parsed.headers.length} column(s). Choose a target table — columns are matched by name; unmatched source columns are ignored, unmatched table columns are left NULL.`;
    preview.appendChild(pRow);
    const pTbl = document.createElement("table");
    pTbl.style.cssText = "border-collapse:collapse;font-size:11px;";
    const thead = document.createElement("thead");
    const htr = document.createElement("tr");
    for (const h of parsed.headers) {
      const th = document.createElement("th");
      th.textContent = h;
      th.style.cssText = "border:1px solid var(--border);padding:3px 6px;";
      htr.appendChild(th);
    }
    thead.appendChild(htr);
    const tbody = document.createElement("tbody");
    for (const row of parsed.rows.slice(0, 8)) {
      const tr = document.createElement("tr");
      for (const cell of row) {
        const td = document.createElement("td");
        td.textContent = cell;
        td.style.cssText = "border:1px solid var(--border);padding:3px 6px;max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    pTbl.appendChild(thead);
    pTbl.appendChild(tbody);
    preview.appendChild(pTbl);

    const foot = document.createElement("div");
    foot.className = "modal-actions";
    const cancel = document.createElement("button");
    cancel.className = "btn";
    cancel.textContent = "Cancel";
    cancel.onclick = () => overlay.remove();
    const run = document.createElement("button");
    run.className = "btn btn-primary";
    run.textContent = "Import";
    run.onclick = async () => {
      const table = tables[tableSel.selectedIndex]!;
      run.disabled = true;
      run.textContent = "Importing…";
      try {
        const target = await this.runCsvImport(table.schema, table.name, parsed);
        overlay.remove();
        this.setStatus(`Imported ${target} row(s) from ${picked.name}`);
        void this.run();
      } catch (e) {
        run.disabled = false;
        run.textContent = "Import";
        alert(`Import failed: ${e}`);
      }
    };
    foot.appendChild(cancel);
    foot.appendChild(run);

    modal.appendChild(title);
    modal.appendChild(tableRow);
    modal.appendChild(preview);
    modal.appendChild(foot);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) overlay.remove();
    });
    tableSel.focus();
  }

  /** Read the target table's columns, map CSV headers to them, and run
   *  batched multi-row INSERTs. Returns the number of rows imported. */
  private async runCsvImport(
    schema: string | undefined,
    table: string,
    parsed: { headers: string[]; rows: string[][] },
  ): Promise<number> {
    if (!this.connId) throw new Error("No active connection.");
    const [cols] = await ipc.describeTable(this.connId, schema, table);
    const colNames = cols.map((c) => c.name);
    // Map each CSV header to a matching target column (case-insensitive).
    const headerIndex = parsed.headers.map((h) => {
      const match = colNames.findIndex((c) => c.toLowerCase() === h.toLowerCase());
      return match >= 0 ? match : -1;
    });

    const usedTargets: string[] = [];
    const srcIdxOf: number[] = [];
    headerIndex.forEach((m, si) => {
      if (m >= 0) {
        usedTargets.push(colNames[m]!);
        srcIdxOf.push(si);
      }
    });
    if (usedTargets.length === 0) {
      throw new Error(
        "None of the CSV column names matched the target table's columns.\n" +
          `CSV: ${parsed.headers.join(", ")}\nTable: ${colNames.join(", ")}`,
      );
    }

    const engine = this.config?.engine ?? "postgres";
    const statements = buildInsertStatements(
      engine,
      table,
      usedTargets,
      parsed.rows,
      100,
      srcIdxOf,
    );
    let imported = 0;
    for (const stmt of statements) {
      const requestId = `${this.connId}:${++this.reqSeq}`;
      const result = await ipc.executeQuery(this.connId, stmt, requestId);
      if (result.error) throw new Error(result.error);
      imported += result.affected_rows ?? 0;
    }
    return imported;
  }

  /** Abort the in-flight statement and ask the run loop to stop. */
  private cancelRun() {
    this.stopBtn.disabled = true;
    this.haltRun = true;
    this.cancelled = true;
    this.setStatus("Stopping…");
    if (this.activeRequestId) {
      const id = this.activeRequestId;
      this.activeRequestId = null;
      void ipc.cancelQuery(id).catch(() => {});
    }
  }

  /** Decide what to run: a selection overrides everything; otherwise if the
   *  cursor is inside a statement with no multi-statement intent, run that
   *  statement; otherwise run the whole script. */
  private planRunStatements(): { sql: string }[] {
    if (!this.view) return [];
    const { state } = this.view;
    const sel = state.selection.main;
    if (sel.from !== sel.to) {
      const text = state.sliceDoc(sel.from, sel.to);
      return text.trim() ? [{ sql: text }] : [];
    }
    const full = state.doc.toString();
    const idx = statementIndexAt(full, sel.to);
    const stmts = splitStatements(full);
    if (idx >= 0 && stmts.length > 1) {
      // Single statement under cursor, but only when the script really is
      // multi-statement — running one statement of a single-statement script
      // is just running the script.
      return [{ sql: stmts[idx]!.sql }];
    }
    return stmts.map((s) => ({ sql: s.sql }));
  }

  private refreshResultTabs() {
    this.resultTabsEl.textContent = "";
    if (this.lastResults.length <= 1) {
      this.resultTabsEl.style.display = "none";
      return;
    }
    this.resultTabsEl.style.display = "";
    this.lastResults.forEach((r, i) => {
      const tab = document.createElement("button");
      tab.className = "result-tab";
      if (i === this.activeResultIndex) tab.classList.add("active");
      const label =
        r.error
          ? "error"
          : r.affected_rows !== undefined
            ? `${r.affected_rows} rows affected`
            : `${r.row_count} rows`;
      const kind = r.columns.length > 0 ? "▦" : r.affected_rows !== undefined ? "✓" : "…";
      tab.textContent = `${kind} ${i + 1} · ${label}`;
      tab.title = `Result ${i + 1}`;
      tab.onclick = () => {
        this.showResultAtIndex(i);
      };
      this.resultTabsEl.appendChild(tab);
    });
  }

  private showResultAtIndex(index: number) {
    this.activeResultIndex = index;
    const r = this.lastResults[index];
    if (!r) {
      this.grid?.clear();
      return;
    }
    // Update active tab styling
    const tabs = this.resultTabsEl.querySelectorAll<HTMLButtonElement>(".result-tab");
    tabs.forEach((t, i) => t.classList.toggle("active", i === index));
    if (r.error) {
      this.grid?.clear();
    } else {
      this.grid?.setData(r);
    }
  }

  private hasExportableResult(): boolean {
    const r = this.lastResults[this.activeResultIndex];
    return !!r && !r.error && r.columns.length > 0;
  }

  private async exportResult(format: ExportFormat) {
    if (!this.hasExportableResult()) return;
    const result = this.lastResults[this.activeResultIndex]!;
    try {
      await saveExport(
        format,
        result.columns,
        result.rows,
        `query_result.${formatMeta[format].ext}`,
        "query_result",
        this.config?.engine ?? "postgres",
      );
    } catch (e) {
      alert(`Export failed: ${e}`);
    }
  }

  private setStatus(msg: string) {
    this.statusEl.textContent = msg;
    appState.status.set(msg);
  }

  private setError(msg: string) {
    this.errorEl.textContent = msg;
    this.errorEl.style.display = "";
    this.setStatus("Error");
  }

  private setWarning(msg: string) {
    this.warnEl.textContent = "";
    const text = document.createElement("span");
    text.textContent = msg;
    const dismiss = document.createElement("button");
    dismiss.className = "warn-banner-dismiss";
    dismiss.textContent = "✕";
    dismiss.title = "Dismiss";
    dismiss.onclick = () => this.clearWarning();
    this.warnEl.append(text, dismiss);
    this.warnEl.style.display = "";
  }

  private clearWarning() {
    this.warnEl.textContent = "";
    this.warnEl.style.display = "none";
  }
}
