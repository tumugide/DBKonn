import type { QueryResult, RowValue } from "../lib/ipc";

// ── Virtual-scroll data grid ──────────────────────────────────────────────────
// Simple windowed renderer: renders only rows in viewport + buffer.
// No external dependencies.

const ROW_HEIGHT = 28; // px
const BUFFER = 10; // rows to render above/below viewport

export interface GridOptions {
  container: HTMLElement;
  onHeaderClick?: (colName: string, idx: number) => void;
  onRowClick?: (row: RowValue[], rowIndex: number) => void;
  sortCol?: string;
  sortDesc?: boolean;
  selectedRowIndex?: number;
}

export class DataGrid {
  private container: HTMLElement;
  private scrollEl!: HTMLElement;
  private thead!: HTMLTableSectionElement;
  private tbody!: HTMLTableSectionElement;
  private result?: QueryResult;
  private opts: GridOptions;
  private renderStart = 0;
  private renderEnd = 0;
  private _rafPending = false;

  constructor(opts: GridOptions) {
    this.opts = opts;
    this.container = opts.container;
    this.build();
  }

  private build() {
    this.container.innerHTML = "";
    this.container.style.overflow = "hidden";
    this.container.style.display = "flex";
    this.container.style.flexDirection = "column";

    this.scrollEl = document.createElement("div");
    this.scrollEl.className = "grid-scroll";
    this.scrollEl.style.cssText = "flex:1; overflow:auto; position:relative;";

    const table = document.createElement("table");
    table.className = "data-grid";
    table.style.tableLayout = "auto";

    this.thead = document.createElement("thead");
    this.tbody = document.createElement("tbody");

    table.appendChild(this.thead);
    table.appendChild(this.tbody);
    this.scrollEl.appendChild(table);
    this.container.appendChild(this.scrollEl);

    this.scrollEl.addEventListener("scroll", () => this.scheduleRender());
  }

  setData(result: QueryResult) {
    this.result = result;
    this.scrollEl.scrollTop = 0;
    this.renderHeaders();
    this.scheduleRender(true);
  }

  updateSort(col?: string, desc?: boolean) {
    this.opts.sortCol = col;
    this.opts.sortDesc = desc;
    this.renderHeaders();
  }

  setSelectedRow(rowIndex?: number) {
    this.opts.selectedRowIndex = rowIndex;
    this.scheduleRender();
  }

  private renderHeaders() {
    this.thead.innerHTML = "";
    if (!this.result) return;
    const tr = document.createElement("tr");
    this.result.columns.forEach((col, idx) => {
      const th = document.createElement("th");
      th.textContent = col.name;
      th.title = `${col.name} (${col.data_type})`;
      if (this.opts.sortCol === col.name) {
        th.classList.add(this.opts.sortDesc ? "sort-desc" : "sort-asc");
      }
      th.addEventListener("click", () =>
        this.opts.onHeaderClick?.(col.name, idx),
      );
      tr.appendChild(th);
    });
    this.thead.appendChild(tr);
  }

  private scheduleRender(reset = false) {
    if (reset) this.renderStart = this.renderEnd = 0;
    if (this._rafPending) return;
    this._rafPending = true;
    requestAnimationFrame(() => {
      this._rafPending = false;
      this.renderVisible();
    });
  }

  private renderVisible() {
    if (!this.result) return;
    const rows = this.result.rows;
    if (rows.length === 0) {
      this.tbody.innerHTML = "";
      return;
    }

    const scrollTop = this.scrollEl.scrollTop;
    const viewHeight = this.scrollEl.clientHeight;
    const firstVisible = Math.floor(scrollTop / ROW_HEIGHT);
    const lastVisible = Math.ceil((scrollTop + viewHeight) / ROW_HEIGHT);

    const start = Math.max(0, firstVisible - BUFFER);
    const end = Math.min(rows.length, lastVisible + BUFFER);

    if (start === this.renderStart && end === this.renderEnd) return;
    this.renderStart = start;
    this.renderEnd = end;

    const topPx = start * ROW_HEIGHT;
    const bottomPx = (rows.length - end) * ROW_HEIGHT;

    // Rebuild visible rows with spacers for virtual scroll
    const fragment = document.createDocumentFragment();

    const topSpacer = document.createElement("tr");
    topSpacer.style.height = `${topPx}px`;
    fragment.appendChild(topSpacer);

    for (let i = start; i < end; i++) {
      fragment.appendChild(this.buildRow(rows[i], i));
    }

    const botSpacer = document.createElement("tr");
    botSpacer.style.height = `${bottomPx}px`;
    fragment.appendChild(botSpacer);

    this.tbody.innerHTML = "";
    this.tbody.appendChild(fragment);
  }

  private buildRow(row: RowValue[], idx: number): HTMLTableRowElement {
    const tr = document.createElement("tr");
    if (idx === this.opts.selectedRowIndex) {
      tr.classList.add("selected");
    }
    tr.addEventListener("click", () => this.opts.onRowClick?.(row, idx));
    row.forEach((val) => {
      const td = document.createElement("td");
      const { text, cls } = formatCell(val);
      td.textContent = text;
      if (cls) td.className = cls;
      tr.appendChild(td);
    });
    return tr;
  }

  clear() {
    this.result = undefined;
    this.thead.innerHTML = "";
    this.tbody.innerHTML = "";
  }
}

function formatCell(val: RowValue): { text: string; cls?: string } {
  if (val === null || val === undefined)
    return { text: "NULL", cls: "null-cell" };
  if (typeof val === "boolean")
    return {
      text: val ? "true" : "false",
      cls: val ? "bool-true" : "bool-false",
    };
  if (typeof val === "number") return { text: String(val), cls: "num-cell" };
  if (typeof val === "string") {
    if (val.startsWith("0x")) return { text: val, cls: "binary-cell" };
    return { text: val };
  }
  if (typeof val === "object") return { text: JSON.stringify(val) };
  return { text: String(val) };
}
