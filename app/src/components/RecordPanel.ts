import type { ColumnInfo, DbEngine, RowValue } from "../lib/ipc";
import type { SelectedRecord } from "../lib/store";
import {
  buildUpdateSql,
  cloneRowValue,
  parseFieldInput,
} from "../lib/rowEdit";
import {
  fromDateTimeLocalValue,
  getTemporalKind,
  isNowValue,
  SQL_NOW_SENTINEL,
  toDateInputValue,
  toDateTimeLocalValue,
  toTimeInputValue,
} from "../lib/temporal";

export interface RecordPanelOptions {
  container: HTMLElement;
  engine: DbEngine;
  schema?: string;
  database?: string;
  table: string;
  onCommit: (sql: string) => Promise<void>;
  onDirtyChange?: (dirty: boolean) => void;
  onClose: () => void;
}

function formatDisplayValue(val: RowValue): string {
  if (val === null || val === undefined) return "";
  if (typeof val === "object") return JSON.stringify(val, null, 2);
  return String(val);
}

function esc(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function enumOptions(col: ColumnInfo, val: RowValue): string {
  const current = typeof val === "string" ? val : "";
  const values = [
    ...new Set([
      ...(current ? [current] : []),
      ...(col.enum_values ?? []),
    ]),
  ];
  return values
    .map(
      (v) =>
        `<option value="${esc(v)}" ${current === v ? "selected" : ""}>${esc(v)}</option>`,
    )
    .join("");
}

export class RecordPanel {
  private container: HTMLElement;
  private opts: RecordPanelOptions;
  private columns: ColumnInfo[] = [];
  private record: SelectedRecord | null = null;
  private errorMsg = "";

  constructor(opts: RecordPanelOptions) {
    this.opts = opts;
    this.container = opts.container;
    this.container.classList.add("record-panel-inner");
    this.renderEmpty();
  }

  setColumns(columns: ColumnInfo[]) {
    this.columns = columns;
    if (this.record) this.render();
  }

  show(record: SelectedRecord) {
    this.record = record;
    this.errorMsg = "";
    this.render();
  }

  clear() {
    this.record = null;
    this.errorMsg = "";
    this.renderEmpty();
  }

  getRecord(): SelectedRecord | null {
    return this.record;
  }

  private renderEmpty() {
    this.container.innerHTML = `
      <div class="record-panel-empty">
        <span>SELECT A ROW</span>
        <span class="record-panel-hint">Click a row in the grid to view and edit</span>
      </div>`;
  }

  private render() {
    if (!this.record) {
      this.renderEmpty();
      return;
    }

    const { draft, dirty } = this.record;
    const fields = this.columns
      .map((col, idx) => {
        const val = draft[idx] ?? null;
        const isNull = val === null;
        const isPk = col.is_primary_key;
        const temporal = getTemporalKind(col.data_type);
        const useNow = isNowValue(val);
        const typeHint =
          col.data_type +
          (col.is_primary_key ? " · PK" : "") +
          (useNow ? " · NOW()" : "");

        let inputHtml: string;
        if (col.enum_values && col.enum_values.length > 0) {
          inputHtml = `
            <select class="record-field-input" data-idx="${idx}" data-kind="enum"
              ${isPk || isNull ? "disabled" : ""}>
              ${enumOptions(col, val)}
            </select>`;
        } else if (temporal === "date") {
          inputHtml = `
            <input class="record-field-input" data-idx="${idx}" data-kind="date" type="date"
              value="${esc(toDateInputValue(val))}"
              ${isPk || isNull ? "disabled" : ""} />`;
        } else if (temporal === "timestamp") {
          inputHtml = `
            <div class="record-datetime-row" data-idx="${idx}">
              <input class="record-field-input" data-idx="${idx}" data-kind="datetime" type="datetime-local"
                step="1"
                value="${esc(toDateTimeLocalValue(val))}"
                ${isPk || isNull || useNow ? "disabled" : ""} />
              <button type="button" class="btn btn-secondary record-now-btn${useNow ? " active" : ""}"
                data-idx="${idx}" ${isPk || isNull ? "disabled" : ""}>NOW()</button>
            </div>`;
        } else if (temporal === "time") {
          inputHtml = `
            <input class="record-field-input" data-idx="${idx}" data-kind="time" type="time"
              step="1"
              value="${esc(toTimeInputValue(val))}"
              ${isPk || isNull ? "disabled" : ""} />`;
        } else if (typeof val === "boolean") {
          inputHtml = `
            <select class="record-field-input" data-idx="${idx}" data-kind="boolean" ${isPk ? "disabled" : ""}>
              <option value="true" ${val ? "selected" : ""}>true</option>
              <option value="false" ${!val ? "selected" : ""}>false</option>
            </select>`;
        } else if (typeof val === "object" && val !== null) {
          inputHtml = `
            <textarea class="record-field-input record-field-json" data-idx="${idx}"
              rows="3" ${isPk || isNull ? "disabled" : ""}>${esc(formatDisplayValue(val))}</textarea>`;
        } else {
          inputHtml = `
            <input class="record-field-input" data-idx="${idx}" type="text"
              value="${esc(formatDisplayValue(val))}"
              ${isPk || isNull ? "disabled" : ""} />`;
        }

        const nullCheck = col.nullable
          ? `<label class="record-null-check">
              <input type="checkbox" class="record-null-toggle" data-idx="${idx}"
                ${isNull ? "checked" : ""} ${isPk ? "disabled" : ""} /> NULL
            </label>`
          : "";

        return `
          <div class="record-field ${isPk ? "record-field-pk" : ""}">
            <div class="record-field-label">
              <span class="record-field-name">${esc(col.name)}</span>
              <span class="record-field-type">${esc(typeHint)}</span>
            </div>
            ${inputHtml}
            ${nullCheck}
          </div>`;
      })
      .join("");

    this.container.innerHTML = `
      <div class="record-panel-header">
        <span class="record-panel-title">RECORD VIEW</span>
        ${dirty ? '<span class="record-dirty-badge">MODIFIED</span>' : ""}
        <button class="btn-icon" id="rp-close" title="Close">X</button>
      </div>
      <div class="record-panel-toolbar">
        <button class="btn btn-primary" id="rp-commit" ${dirty ? "" : "disabled"}>[COMMIT]</button>
        <button class="btn btn-secondary" id="rp-rollback" ${dirty ? "" : "disabled"}>[ROLLBACK]</button>
      </div>
      ${this.errorMsg ? `<div class="error-banner record-panel-error">${esc(this.errorMsg)}</div>` : ""}
      <div class="record-panel-fields">${fields}</div>
    `;

    this.wireEvents();
  }

  private wireEvents() {
    document.getElementById("rp-close")?.addEventListener("click", () => {
      if (this.record?.dirty) {
        if (!confirm("Discard unsaved changes?")) return;
      }
      this.opts.onClose();
    });

    document.getElementById("rp-commit")?.addEventListener("click", () => {
      void this.handleCommit();
    });

    document.getElementById("rp-rollback")?.addEventListener("click", () => {
      this.handleRollback();
    });

    this.container.querySelectorAll(".record-field-input").forEach((el) => {
      el.addEventListener("input", () => {
        if (
          el instanceof HTMLInputElement &&
          el.dataset["kind"] === "datetime"
        ) {
          const idx = el.dataset["idx"];
          const nowBtn = this.container.querySelector<HTMLButtonElement>(
            `.record-now-btn[data-idx="${idx}"]`,
          );
          if (nowBtn?.classList.contains("active")) {
            nowBtn.classList.remove("active");
            el.disabled = false;
          }
        }
        this.syncDraftFromDom();
      });
      el.addEventListener("change", () => this.syncDraftFromDom());
    });

    this.container.querySelectorAll(".record-null-toggle").forEach((el) => {
      el.addEventListener("change", () => {
        this.syncDraftFromDom();
        this.render();
      });
    });

    this.container.querySelectorAll(".record-now-btn").forEach((el) => {
      el.addEventListener("click", () => {
        const btn = el as HTMLButtonElement;
        if (btn.disabled) return;
        const idx = btn.dataset["idx"]!;
        const input = this.container.querySelector<HTMLInputElement>(
          `.record-field-input[data-idx="${idx}"][data-kind="datetime"]`,
        );
        const activating = !btn.classList.contains("active");
        btn.classList.toggle("active", activating);
        if (input) input.disabled = activating;
        this.syncDraftFromDom();
        this.render();
      });
    });
  }

  private syncDraftFromDom() {
    if (!this.record) return;

    const draft = this.record.original.map((v) => cloneRowValue(v));
    this.columns.forEach((col, idx) => {
      const nullToggle = this.container.querySelector<HTMLInputElement>(
        `.record-null-toggle[data-idx="${idx}"]`,
      );
      const isNull = nullToggle?.checked ?? false;

      if (col.is_primary_key) {
        draft[idx] = this.record!.original[idx] ?? null;
        return;
      }

      const input = this.container.querySelector<HTMLElement>(
        `.record-field-input[data-idx="${idx}"]`,
      );
      const nowBtn = this.container.querySelector<HTMLButtonElement>(
        `.record-now-btn[data-idx="${idx}"]`,
      );
      const temporal = getTemporalKind(col.data_type);

      if (nowBtn?.classList.contains("active")) {
        draft[idx] = isNull ? null : SQL_NOW_SENTINEL;
        return;
      }

      if (!input) return;

      const original = this.record!.original[idx] ?? null;
      if (input instanceof HTMLSelectElement) {
        if (col.enum_values && col.enum_values.length > 0) {
          draft[idx] = isNull ? null : input.value;
        } else if (typeof original === "boolean") {
          draft[idx] = input.value === "true";
        } else {
          draft[idx] = isNull ? null : input.value;
        }
      } else if (input instanceof HTMLTextAreaElement) {
        draft[idx] = parseFieldInput(input.value, isNull, original);
      } else if (input instanceof HTMLInputElement) {
        if (isNull) {
          draft[idx] = null;
        } else if (temporal === "date") {
          draft[idx] = input.value;
        } else if (temporal === "timestamp") {
          draft[idx] = fromDateTimeLocalValue(input.value);
        } else if (temporal === "time") {
          draft[idx] = input.value;
        } else {
          draft[idx] = parseFieldInput(input.value, isNull, original);
        }
      }
    });

    const dirty = this.columns.some(
      (_col, idx) =>
        JSON.stringify(draft[idx]) !==
        JSON.stringify(this.record!.original[idx] ?? null),
    );

    this.record = { ...this.record, draft, dirty };
    this.opts.onDirtyChange?.(dirty);

    const commitBtn = document.getElementById("rp-commit") as HTMLButtonElement;
    const rollbackBtn = document.getElementById(
      "rp-rollback",
    ) as HTMLButtonElement;
    if (commitBtn) commitBtn.disabled = !dirty;
    if (rollbackBtn) rollbackBtn.disabled = !dirty;

    const badge = this.container.querySelector(".record-dirty-badge");
    if (dirty && !badge) {
      const title = this.container.querySelector(".record-panel-title");
      title?.insertAdjacentHTML(
        "afterend",
        '<span class="record-dirty-badge">MODIFIED</span>',
      );
    } else if (!dirty && badge) {
      badge.remove();
    }
  }

  private handleRollback() {
    if (!this.record) return;
    this.record = {
      ...this.record,
      draft: this.record.original.map((v) => cloneRowValue(v)),
      dirty: false,
    };
    this.errorMsg = "";
    this.opts.onDirtyChange?.(false);
    this.render();
  }

  private async handleCommit() {
    if (!this.record) return;

    const result = buildUpdateSql({
      engine: this.opts.engine,
      schema: this.opts.schema,
      database: this.opts.database,
      table: this.opts.table,
      columns: this.columns,
      original: this.record.original,
      draft: this.record.draft,
    });

    if ("error" in result) {
      this.errorMsg = result.error;
      this.render();
      return;
    }

    try {
      await this.opts.onCommit(result.sql);
      this.record = {
        ...this.record,
        original: this.record.draft.map((v) => cloneRowValue(v)),
        dirty: false,
      };
      this.errorMsg = "";
      this.opts.onDirtyChange?.(false);
      this.render();
    } catch (e) {
      this.errorMsg = String(e);
      this.render();
    }
  }
}
