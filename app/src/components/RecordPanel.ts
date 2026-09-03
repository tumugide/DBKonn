import type { ColumnInfo, DbEngine, RowValue } from "../lib/ipc";
import type { SelectedRecord } from "../lib/store";
import {
  buildUpdateSql,
  cloneRowValue,
  isTextLikeType,
  parseFieldInput,
} from "../lib/rowEdit";
import {
  extractTimezoneSuffix,
  fromDateTimeLocalValue,
  getTemporalKind,
  isNowValue,
  SQL_NOW_SENTINEL,
  toDateInputValue,
  toDateTimeLocalValue,
  toTimeInputValue,
} from "../lib/temporal";

/** True when a column's declared type is boolean-ish, regardless of the
 *  current cell value (which is `null` for a NULL boolean, so `typeof val`
 *  alone would mis-render it as a free-text box → saves the string 'true'). */
function isBooleanColumn(col: ColumnInfo): boolean {
  return /^(bool|boolean|bit|tinyint\(1\))$/i.test(col.data_type.trim());
}

export interface RecordPanelOptions {
  container: HTMLElement;
  engine: DbEngine;
  schema?: string;
  database?: string;
  table: string;
  onCommit: (sql: string) => Promise<void>;
  onDirtyChange?: (dirty: boolean) => void;
  onClose: () => void;
  /** View-only mode: no editing, no NULL toggle, no Save/Revert toolbar. */
  readOnly?: boolean;
  /** Shown as an "Edit" button in read-only mode. */
  onRequestEdit?: () => void;
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

  // Upgrades a read-only panel into an editable one targeting a specific
  // table, without losing the currently displayed row.
  enterEditMode(ctx: {
    engine: DbEngine;
    schema?: string;
    database?: string;
    table: string;
    onCommit: (sql: string) => Promise<void>;
  }) {
    this.opts.engine = ctx.engine;
    this.opts.schema = ctx.schema;
    this.opts.database = ctx.database;
    this.opts.table = ctx.table;
    this.opts.onCommit = ctx.onCommit;
    this.opts.readOnly = false;
    this.errorMsg = "";
    this.render();
  }

  private renderEmpty() {
    this.container.innerHTML = `
      <div class="record-panel-empty">
        <span>No row selected</span>
        <span class="record-panel-hint">Click a row in the grid to view and edit</span>
      </div>`;
  }

  private render() {
    if (!this.record) {
      this.renderEmpty();
      return;
    }

    const { draft, dirty } = this.record;
    const ro = this.opts.readOnly ?? false;
    const fields = this.columns
      .map((col, idx) => {
        const val = draft[idx] ?? null;
        const isNull = val === null;
        const isPk = col.is_primary_key;
        const disabled = ro || isPk || isNull;
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
              ${disabled ? "disabled" : ""}>
              ${enumOptions(col, val)}
            </select>`;
        } else if (temporal === "date") {
          inputHtml = `
            <input class="record-field-input" data-idx="${idx}" data-kind="date" type="date"
              value="${esc(toDateInputValue(val))}"
              ${disabled ? "disabled" : ""} />`;
        } else if (temporal === "timestamp") {
          inputHtml = `
            <div class="record-datetime-row" data-idx="${idx}">
              <input class="record-field-input" data-idx="${idx}" data-kind="datetime" type="datetime-local"
                step="1"
                value="${esc(toDateTimeLocalValue(val))}"
                ${disabled || useNow ? "disabled" : ""} />
              ${ro ? "" : `<button type="button" class="btn btn-secondary record-now-btn${useNow ? " active" : ""}"
                data-idx="${idx}" ${disabled ? "disabled" : ""}>NOW()</button>`}
            </div>`;
        } else if (temporal === "time") {
          inputHtml = `
            <input class="record-field-input" data-idx="${idx}" data-kind="time" type="time"
              step="1"
              value="${esc(toTimeInputValue(val))}"
              ${disabled ? "disabled" : ""} />`;
        } else if (isBooleanColumn(col) || typeof val === "boolean") {
          inputHtml = `
            <select class="record-field-input" data-idx="${idx}" data-kind="boolean" ${disabled ? "disabled" : ""}>
              <option value="true" ${val === true ? "selected" : ""}>true</option>
              <option value="false" ${val === false ? "selected" : ""}>false</option>
            </select>`;
        } else if (typeof val === "number") {
          inputHtml = `
            <input class="record-field-input" data-idx="${idx}" type="text"
              value="${esc(formatDisplayValue(val))}"
              ${disabled ? "disabled" : ""} />`;
        } else {
          // Whether a field gets a textarea is purely a function of how much
          // content it holds, not its column data type — a short JSON blob
          // gets a plain input, a long plain-text value gets a textarea.
          const text = formatDisplayValue(val);
          if (text.length > 36) {
            const isJson = typeof val === "object" && val !== null;
            inputHtml = `
              <textarea class="record-field-input record-field-text${isJson ? " record-field-json" : ""}" data-idx="${idx}"
                rows="3" ${disabled ? "disabled" : ""}>${esc(text)}</textarea>`;
          } else {
            inputHtml = `
              <input class="record-field-input" data-idx="${idx}" type="text"
                value="${esc(text)}"
                ${disabled ? "disabled" : ""} />`;
          }
        }

        const nullCheck =
          !ro && col.nullable
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
        <span class="record-panel-title">Record</span>
        ${ro ? '<span class="record-dirty-badge record-readonly-badge">Read-only</span>' : ""}
        ${!ro && dirty ? '<span class="record-dirty-badge">Modified</span>' : ""}
        ${ro && this.opts.onRequestEdit ? '<button class="btn-icon" id="rp-edit" title="Edit this row">Edit</button>' : ""}
        <button class="btn-icon" id="rp-close" title="Close">✕</button>
      </div>
      ${
        ro
          ? ""
          : `<div class="record-panel-toolbar">
        <button class="btn btn-primary" id="rp-commit" ${dirty ? "" : "disabled"}>Save</button>
        <button class="btn btn-secondary" id="rp-rollback" ${dirty ? "" : "disabled"}>Revert</button>
      </div>`
      }
      ${
        !ro && this.columns.length > 0 && !this.columns.some((c) => c.is_primary_key)
          ? `<div class="record-panel-note">No primary key on this table — edits match rows on every column value, so a save can miss (if a value changed underneath) or touch more than one row.</div>`
          : ""
      }
      ${this.errorMsg ? `<div class="error-banner record-panel-error">${esc(this.errorMsg)}</div>` : ""}
      <div class="record-panel-fields">${fields}</div>
    `;

    this.wireEvents();
  }

  private autoGrow(el: HTMLTextAreaElement) {
    el.style.height = "auto";
    el.style.height = Math.min(Math.max(el.scrollHeight, 24), 220) + "px";
  }

  private wireEvents() {
    document.getElementById("rp-edit")?.addEventListener("click", () => {
      this.opts.onRequestEdit?.();
    });

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
      const idx = Number((el as HTMLElement).dataset["idx"]);
      const onEdit = () => {
        if (
          el instanceof HTMLInputElement &&
          el.dataset["kind"] === "datetime"
        ) {
          const nowBtn = this.container.querySelector<HTMLButtonElement>(
            `.record-now-btn[data-idx="${idx}"]`,
          );
          if (nowBtn?.classList.contains("active")) {
            nowBtn.classList.remove("active");
            el.disabled = false;
          }
        }
        if (el instanceof HTMLTextAreaElement) this.autoGrow(el);
        this.syncDraftFromDom(idx);
      };
      el.addEventListener("input", onEdit);
      el.addEventListener("change", onEdit);
    });

    // Size textareas to their content on render
    this.container
      .querySelectorAll<HTMLTextAreaElement>(".record-field-text")
      .forEach((ta) => this.autoGrow(ta));

    this.container.querySelectorAll(".record-null-toggle").forEach((el) => {
      el.addEventListener("change", () => {
        this.syncDraftFromDom(Number((el as HTMLElement).dataset["idx"]));
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
        this.syncDraftFromDom(Number(idx));
        this.render();
      });
    });
  }

  // Re-reads the given field (or every field when `changedIdx` is omitted)
  // from the DOM into the draft. Crucially it starts from the *current*
  // draft, not `original` — rebuilding every field on each keystroke was
  // reformatting untouched timestamp columns through the local timezone and
  // silently marking them "Modified" with a shifted value (A9).
  // `parseFieldInput`, but never yields "" for a non-text column. Un-checking
  // NULL re-renders the field with an empty value; writing that back as
  // `col = ''` is a type error on pg/mssql and a silent 0 / epoch elsewhere
  // (A15). Keep the field at its previous value until the user types a real
  // one — Save stays disabled because nothing actually changed.
  private parseNonTextGuarded(
    raw: string,
    isNull: boolean,
    original: RowValue,
    col: ColumnInfo,
  ): RowValue {
    const parsed = parseFieldInput(raw, isNull, original);
    if (!isNull && raw === "" && parsed === "" && !isTextLikeType(col.data_type)) {
      return original ?? null;
    }
    return parsed;
  }

  private syncDraftFromDom(changedIdx?: number) {
    if (!this.record) return;

    const draft = this.record.draft.map((v) => cloneRowValue(v));
    const indices =
      changedIdx !== undefined && changedIdx >= 0
        ? [changedIdx]
        : this.columns.map((_, i) => i);

    for (const idx of indices) {
      const col = this.columns[idx];
      if (!col) continue;

      const nullToggle = this.container.querySelector<HTMLInputElement>(
        `.record-null-toggle[data-idx="${idx}"]`,
      );
      const isNull = nullToggle?.checked ?? false;

      if (col.is_primary_key) {
        draft[idx] = this.record.original[idx] ?? null;
        continue;
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
        continue;
      }

      if (!input) continue;

      const original = this.record.original[idx] ?? null;
      if (input instanceof HTMLSelectElement) {
        if (col.enum_values && col.enum_values.length > 0) {
          draft[idx] = isNull ? null : input.value;
        } else if (input.dataset["kind"] === "boolean") {
          draft[idx] = isNull ? null : input.value === "true";
        } else {
          draft[idx] = isNull ? null : input.value;
        }
      } else if (input instanceof HTMLTextAreaElement) {
        draft[idx] = this.parseNonTextGuarded(input.value, isNull, original, col);
      } else if (input instanceof HTMLInputElement) {
        if (isNull) {
          draft[idx] = null;
        } else if (temporal === "date") {
          draft[idx] = input.value;
        } else if (temporal === "timestamp") {
          // Re-attach the stored value's timezone designator so a
          // `timestamptz` is written back in its original offset, not
          // reinterpreted in the DB session's zone.
          const suffix = extractTimezoneSuffix(original);
          const rebuilt = fromDateTimeLocalValue(input.value) + suffix;
          const sameWallClock =
            String(rebuilt).replace("T", " ") ===
            String(original ?? "").replace("T", " ");
          draft[idx] = sameWallClock ? original : rebuilt;
        } else if (temporal === "time") {
          draft[idx] = input.value;
        } else {
          draft[idx] = this.parseNonTextGuarded(
            input.value,
            isNull,
            original,
            col,
          );
        }
      }
    }

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
        '<span class="record-dirty-badge">Modified</span>',
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
