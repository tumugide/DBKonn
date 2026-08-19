import { EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { sql, PostgreSQL, MySQL, SQLite, MSSQL } from "@codemirror/lang-sql";
import { autocompletion, completionKeymap } from "@codemirror/autocomplete";
import { syntaxHighlighting, HighlightStyle } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";

import { ipc, type ConnectionConfig, type ColumnInfo, type QueryResult, type RowValue } from "../lib/ipc";
import { appState, type ThemeType } from "../lib/store";
import { DataGrid } from "./DataGrid";
import { createExportButton, type ExportButton } from "./ExportMenu";
import { saveExport, formatMeta, type ExportFormat } from "../lib/export";

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
  private statusEl!: HTMLElement;
  private errorEl!: HTMLElement;
  private lastDoc = "SELECT 1;\n";
  private lastResult: QueryResult | null = null;
  private lastRunText = "";
  private opts: SqlEditorOptions;
  private unsubTheme?: () => void;
  private exportButton?: ExportButton;

  constructor(container: HTMLElement, opts: SqlEditorOptions = {}) {
    this.container = container;
    this.opts = opts;
    if (opts.initialDoc) this.lastDoc = opts.initialDoc;
    this.lastResult = opts.initialResult ?? null;
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
    return this.lastResult;
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
      "display:flex;flex-direction:column;height:100%;overflow:hidden;";

    // Toolbar
    const toolbar = document.createElement("div");
    toolbar.className = "editor-toolbar";

    const runBtn = document.createElement("button");
    runBtn.className = "btn btn-primary";
    runBtn.innerHTML = "▶ Run";
    runBtn.title = "Run query (⌘⏎)";
    runBtn.onclick = () => this.run();

    this.statusEl = document.createElement("span");
    this.statusEl.style.cssText =
      "font-size:11px;color:var(--text-muted);flex:1;";

    this.exportButton = createExportButton({
      formats: ["csv", "tsv", "xlsx", "json", "markdown", "html", "sql"],
      onSelect: (format) => this.exportResult(format),
    });
    this.exportButton.setDisabled(!this.hasExportableResult());

    toolbar.appendChild(runBtn);
    toolbar.appendChild(this.statusEl);
    toolbar.appendChild(this.exportButton.element);

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

    this.container.appendChild(toolbar);
    this.container.appendChild(editorPane);
    this.container.appendChild(this.errorEl);
    this.container.appendChild(this.resultContainer);

    this.grid = new DataGrid({
      container: this.resultContainer,
      onHeaderClick: () => {},
      onRowClick: (row, rowIndex) => {
        this.grid?.setSelectedRow(rowIndex);
        this.opts.onRowClick?.(row, rowIndex, this.lastResult?.columns ?? []);
      },
    });
    if (this.lastResult) {
      this.grid.setData(this.lastResult);
      const label =
        this.lastResult.affected_rows !== undefined
          ? `${this.lastResult.affected_rows} rows affected`
          : `${this.lastResult.row_count} rows returned`;
      this.statusEl.textContent = `${label} in ${this.lastResult.execution_time_ms}ms`;
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

    const sqlText = this.getSelectedOrAll();
    if (!sqlText.trim()) return;

    this.errorEl.style.display = "none";
    this.setStatus("Validating…");

    try {
      const parseErr = await ipc.validateSql(this.config, sqlText);
      if (parseErr) {
        this.setError(`Parse error: ${parseErr.message}`);
        return;
      }
    } catch {
      /* validation is best-effort */
    }

    this.setStatus("Running…");

    try {
      const result = await ipc.executeQuery(this.connId, sqlText);
      this.lastResult = result;
      this.lastRunText = sqlText;
      this.opts.onBeforeNewResult?.();

      if (result.error) {
        this.setError(result.error);
        this.grid?.clear();
      } else {
        this.grid?.setData(result);
        const label =
          result.affected_rows !== undefined
            ? `${result.affected_rows} rows affected`
            : `${result.row_count} rows returned`;
        this.setStatus(`${label} in ${result.execution_time_ms}ms`);
      }
      this.exportButton?.setDisabled(!this.hasExportableResult());
    } catch (e) {
      this.setError(String(e));
      this.exportButton?.setDisabled(!this.hasExportableResult());
    }
  }

  private hasExportableResult(): boolean {
    return !!this.lastResult && !this.lastResult.error && this.lastResult.columns.length > 0;
  }

  private async exportResult(format: ExportFormat) {
    if (!this.hasExportableResult()) return;
    const result = this.lastResult!;
    try {
      await saveExport(
        format,
        result.columns,
        result.rows,
        `query_result.${formatMeta[format].ext}`,
        "query_result",
      );
    } catch (e) {
      alert(`Export failed: ${e}`);
    }
  }

  private getSelectedOrAll(): string {
    if (!this.view) return "";
    const { state } = this.view;
    const sel = state.selection.main;
    return sel.from !== sel.to
      ? state.sliceDoc(sel.from, sel.to)
      : state.doc.toString();
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
}
