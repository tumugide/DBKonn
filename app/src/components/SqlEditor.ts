import { EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { sql, PostgreSQL, MySQL, SQLite, MSSQL } from "@codemirror/lang-sql";
import { autocompletion, completionKeymap } from "@codemirror/autocomplete";
import { syntaxHighlighting, HighlightStyle } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";

import { ipc, type ConnectionConfig, type ColumnInfo } from "../lib/ipc";
import { appState } from "../lib/store";
import { DataGrid } from "./DataGrid";

// ── BIOS phosphor-green CodeMirror theme ─────────────────────────────────────

const biosEditorTheme = EditorView.theme(
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
);

const biosHighlight = syntaxHighlighting(
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
);

// ── Dialect map ───────────────────────────────────────────────────────────────

const DIALECT_MAP = {
  postgres: PostgreSQL,
  mysql: MySQL,
  sqlite: SQLite,
  mssql: MSSQL,
} as const;

// ── SqlEditor component ───────────────────────────────────────────────────────

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

  constructor(container: HTMLElement) {
    this.container = container;
    this.buildLayout();
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
    runBtn.textContent = "[RUN] CMD+ENTER";
    runBtn.onclick = () => this.run();

    this.statusEl = document.createElement("span");
    this.statusEl.style.cssText =
      "font-size:11px;color:var(--green-dim);flex:1;letter-spacing:0.05em;";

    toolbar.appendChild(runBtn);
    toolbar.appendChild(this.statusEl);

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
    });
    this.buildEditor(editorPane, "postgres");
  }

  private buildEditor(parent: HTMLElement, engine: keyof typeof DIALECT_MAP) {
    const savedDoc = this.view ? this.view.state.doc.toString() : this.lastDoc;
    this.view?.destroy();

    const dialect = DIALECT_MAP[engine] ?? PostgreSQL;
    const self = this;

    const state = EditorState.create({
      doc: savedDoc,
      extensions: [
        history(),
        biosHighlight,
        sql({ dialect }),
        biosEditorTheme,
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
    const schema: Record<string, string[]> = {};
    for (const t of tables) schema[t.name] = t.columns.map((c) => c.name);

    this.lastDoc = this.view.state.doc.toString();
    this.view.destroy();

    const self = this;
    const state = EditorState.create({
      doc: this.lastDoc,
      extensions: [
        history(),
        biosHighlight,
        sql({ dialect, schema }),
        biosEditorTheme,
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

  private async run() {
    if (!this.connId || !this.config) {
      this.setError("NO ACTIVE CONNECTION. CONNECT FIRST.");
      return;
    }

    const sqlText = this.getSelectedOrAll();
    if (!sqlText.trim()) return;

    this.errorEl.style.display = "none";
    this.setStatus("VALIDATING...");

    try {
      const parseErr = await ipc.validateSql(this.config, sqlText);
      if (parseErr) {
        this.setError(`PARSE ERROR: ${parseErr.message}`);
        return;
      }
    } catch {
      /* validation is best-effort */
    }

    this.setStatus("EXECUTING...");
    appState.sqlLoading.set(true);

    try {
      const result = await ipc.executeQuery(this.connId, sqlText);
      appState.sqlResult.set(result);

      if (result.error) {
        this.setError(result.error);
        this.grid?.clear();
      } else {
        this.grid?.setData(result);
        const label =
          result.affected_rows !== undefined
            ? `${result.affected_rows} ROWS AFFECTED`
            : `${result.row_count} ROWS RETURNED`;
        this.setStatus(`OK: ${label} IN ${result.execution_time_ms}ms`);
      }
    } catch (e) {
      this.setError(String(e));
    } finally {
      appState.sqlLoading.set(false);
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
    this.setStatus("ERROR");
    appState.sqlError.set(msg);
  }
}
