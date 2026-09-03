import type { ColumnInfo, QueryResult, RowValue } from "../lib/ipc";

// ── Virtual-scroll data grid ──────────────────────────────────────────────────
// Simple windowed renderer: renders only rows in viewport + buffer.
// No external dependencies.

const ROW_HEIGHT = 28; // px
const BUFFER = 10; // rows to render above/below viewport

export interface GridOptions {
  container: HTMLElement;
  onHeaderClick?: (colName: string, idx: number) => void;
  onRowClick?: (row: RowValue[], rowIndex: number) => void;
  // Fires with the full sorted set of selected row indices whenever the
  // selection changes — a plain click (exclusive single-row select),
  // Cmd/Ctrl+click (toggle), or a drag (range select).
  onSelectionChange?: (indices: number[]) => void;
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
  private multiSelect: Set<number> = new Set();
  // Drag-to-select (mousedown on a row + move across others before mouseup)
  private dragAnchor: number | null = null;
  private dragMoved = false;
  private dragBase: Set<number> = new Set();

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
    // Silent: row indices from the previous page/sort/filter no longer mean
    // anything once new rows land, but we don't want to also fire
    // onSelectionChange here — a caller that wants to keep a record open
    // across the reload restores it explicitly afterward via setSelectedRow.
    this.multiSelect.clear();
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
    this.forceRerender();
  }

  // ── Multi-selection (Cmd/Ctrl+click) ──────────────────────────────────────

  private toggleMultiSelect(idx: number) {
    if (this.multiSelect.has(idx)) this.multiSelect.delete(idx);
    else this.multiSelect.add(idx);
    this.opts.onSelectionChange?.(this.sortedSelection());
    this.forceRerender();
  }

  private sortedSelection(): number[] {
    return [...this.multiSelect].sort((a, b) => a - b);
  }

  clearSelection() {
    if (this.multiSelect.size === 0) return;
    this.multiSelect.clear();
    this.opts.onSelectionChange?.([]);
    this.forceRerender();
  }

  getSelectionData(): { columns: ColumnInfo[]; rows: RowValue[][] } | null {
    if (!this.result || this.multiSelect.size === 0) return null;
    const rows = this.sortedSelection().map((i) => this.result!.rows[i]!);
    return { columns: this.result.columns, rows };
  }

  // Bypasses the "same range" skip in renderVisible so a selection toggle
  // (which doesn't change the visible row range) still repaints immediately.
  private forceRerender() {
    this.renderStart = -1;
    this.renderEnd = -1;
    this.renderVisible();
  }

  // ── Drag-to-select ─────────────────────────────────────────────────────
  // mousedown on a row arms a drag; if the pointer moves onto another row
  // before mouseup, every row between the anchor and the current row is
  // selected (Cmd/Ctrl held at mousedown keeps the prior selection and adds
  // the dragged range to it, like Cmd+click). A plain click (no movement
  // between rows) is left for the row's own "click" listener to handle.
  private onRowMouseDown(e: MouseEvent, idx: number) {
    if (e.button !== 0) return;
    e.preventDefault();

    this.dragAnchor = idx;
    this.dragMoved = false;
    this.dragBase = e.metaKey || e.ctrlKey ? new Set(this.multiSelect) : new Set();

    const onMove = (ev: MouseEvent) => this.onDragMove(ev);
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      this.dragAnchor = null;
      // The trailing "click" on the row under the pointer (if any) consumes
      // dragMoved synchronously, before this fires. If mouseup lands outside
      // any row, no click ever consumes it — clear it next tick so it can't
      // be mistaken for a drag on some later, unrelated plain click.
      setTimeout(() => {
        this.dragMoved = false;
      }, 0);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  private onDragMove(e: MouseEvent) {
    if (this.dragAnchor === null) return;
    const rowEl = (e.target as HTMLElement | null)?.closest(
      "tr[data-row-index]",
    ) as HTMLElement | null;
    if (!rowEl) return;

    const idx = Number(rowEl.dataset["rowIndex"]);
    if (Number.isNaN(idx)) return;
    if (idx === this.dragAnchor && !this.dragMoved) return;

    this.dragMoved = true;
    const lo = Math.min(this.dragAnchor, idx);
    const hi = Math.max(this.dragAnchor, idx);
    const next = new Set(this.dragBase);
    for (let i = lo; i <= hi; i++) next.add(i);
    this.multiSelect = next;
    this.opts.onSelectionChange?.(this.sortedSelection());
    this.forceRerender();
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
    tr.dataset["rowIndex"] = String(idx);
    if (idx === this.opts.selectedRowIndex) {
      tr.classList.add("selected");
    }
    if (this.multiSelect.has(idx)) {
      tr.classList.add("multi-selected");
    }
    tr.addEventListener("mousedown", (e) => this.onRowMouseDown(e as MouseEvent, idx));
    tr.addEventListener("click", (e) => {
      const evt = e as MouseEvent;
      if (this.dragMoved) {
        // A drag just set the selection — don't also treat the trailing
        // click as a plain/cmd row select.
        this.dragMoved = false;
        return;
      }
      if (evt.metaKey || evt.ctrlKey) {
        this.toggleMultiSelect(idx);
        return;
      }
      // Plain click: select this row exclusively. This is the same
      // selection the Delete/Export bulk-action bar operates on, so a
      // single click is enough to make a record deletable — not just
      // openable in the editor panel.
      this.multiSelect = new Set([idx]);
      this.opts.onSelectionChange?.(this.sortedSelection());
      this.forceRerender();
      this.opts.onRowClick?.(row, idx);
    });
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
    this.multiSelect.clear();
    this.thead.innerHTML = "";
    this.tbody.innerHTML = "";
  }

  // Called when the owning tab body is torn down. Drops references and any
  // in-progress drag listeners so a stale grid can't keep reacting to
  // window-level mouse events after its DOM is gone.
  destroy() {
    if (this.dragAnchor !== null) {
      // A drag was mid-flight; its window listeners are anonymous, but
      // clearing the anchor makes onDragMove a no-op and the next mouseup
      // removes them.
      this.dragAnchor = null;
    }
    this.result = undefined;
    this.multiSelect.clear();
    this.container.innerHTML = "";
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
