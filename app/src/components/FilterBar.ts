import type { ColumnInfo, DbEngine } from "../lib/ipc";
import {
  compileWhereClause,
  newRule,
  OPERATORS,
  type FilterOperator,
  type FilterRule,
} from "../lib/filter";

const NULLARY_OPS: FilterOperator[] = ["IS NULL", "IS NOT NULL"];

export class FilterBar {
  private container: HTMLElement;
  private rules: FilterRule[] = [];
  private columns: ColumnInfo[] = [];
  private engine: DbEngine;
  private onApply: (where: string) => void;

  constructor(
    container: HTMLElement,
    onApply: (where: string) => void,
    engine: DbEngine,
  ) {
    this.container = container;
    this.onApply = onApply;
    this.engine = engine;
    this.render();
  }

  setEngine(engine: DbEngine) {
    this.engine = engine;
  }

  setColumns(cols: ColumnInfo[]) {
    if (cols.length === 0) return;

    const prevNames = new Set(this.columns.map((c) => c.name));
    const nextNames = new Set(cols.map((c) => c.name));
    const same =
      prevNames.size === nextNames.size &&
      [...nextNames].every((n) => prevNames.has(n));

    this.columns = cols;
    if (!same && this.rules.length > 0) {
      this.ensureValidRules();
      this.refreshColumnSelects();
    }
  }

  setRules(rules: FilterRule[]) {
    this.rules = rules;
    this.render();
  }

  clear() {
    this.rules = [];
    this.render();
    this.onApply("");
  }

  private ensureValidRules() {
    for (const rule of this.rules) {
      if (!this.columns.some((c) => c.name === rule.column) && this.columns[0]) {
        rule.column = this.columns[0].name;
      }
    }
  }

  private render() {
    this.container.innerHTML = "";

    if (this.rules.length === 0) {
      const addBtn = document.createElement("button");
      addBtn.className = "btn btn-secondary";
      addBtn.textContent = "+ Add Filter";
      addBtn.onclick = () => {
        const col = this.columns[0]?.name ?? "id";
        this.rules.push(newRule(col));
        this.render();
      };
      this.container.appendChild(addBtn);
      return;
    }

    this.ensureValidRules();

    this.rules.forEach((rule, idx) => {
      const ruleEl = document.createElement("div");
      ruleEl.className = "filter-rule";

      if (idx > 0) {
        const conjSel = document.createElement("select");
        conjSel.className = "filter-conj";
        conjSel.style.cssText = "width:60px;padding:2px 4px;";
        ["AND", "OR"].forEach((v) => {
          const opt = document.createElement("option");
          opt.value = v;
          opt.textContent = v;
          if (v === this.rules[idx - 1]!.conjunction) opt.selected = true;
          conjSel.appendChild(opt);
        });
        conjSel.onchange = () => {
          this.rules[idx - 1]!.conjunction = conjSel.value as "AND" | "OR";
        };
        this.container.appendChild(conjSel);
      }

      const colSel = document.createElement("select");
      colSel.className = "filter-col";
      colSel.style.cssText = "max-width:140px;";
      if (this.columns.length === 0) {
        const opt = document.createElement("option");
        opt.value = rule.column;
        opt.textContent = rule.column;
        opt.selected = true;
        colSel.appendChild(opt);
      } else {
        this.columns.forEach((c) => {
          const opt = document.createElement("option");
          opt.value = c.name;
          opt.textContent = c.name;
          if (c.name === rule.column) opt.selected = true;
          colSel.appendChild(opt);
        });
      }
      colSel.onchange = () => {
        rule.column = colSel.value;
      };
      ruleEl.appendChild(colSel);

      const opSel = document.createElement("select");
      opSel.className = "filter-op";
      opSel.style.cssText = "width:128px;";
      OPERATORS.forEach((op) => {
        const opt = document.createElement("option");
        opt.value = op;
        opt.textContent = op;
        if (op === rule.operator) opt.selected = true;
        opSel.appendChild(opt);
      });

      const valueInput = document.createElement("input");
      valueInput.type = "text";
      valueInput.className = "filter-value";
      valueInput.value = rule.value;
      valueInput.placeholder = "value";
      valueInput.style.cssText = "width:140px;";
      if (NULLARY_OPS.includes(rule.operator)) valueInput.style.display = "none";

      opSel.onchange = () => {
        rule.operator = opSel.value as FilterOperator;
        valueInput.style.display = NULLARY_OPS.includes(rule.operator)
          ? "none"
          : "";
      };
      ruleEl.appendChild(opSel);

      valueInput.oninput = () => {
        rule.value = valueInput.value;
      };
      ruleEl.appendChild(valueInput);

      const rmBtn = document.createElement("button");
      rmBtn.className = "btn-icon";
      rmBtn.textContent = "✕";
      rmBtn.title = "Remove filter";
      rmBtn.onclick = () => {
        this.rules.splice(idx, 1);
        this.render();
      };
      ruleEl.appendChild(rmBtn);

      this.container.appendChild(ruleEl);
    });

    const addBtn = document.createElement("button");
    addBtn.className = "btn btn-secondary";
    addBtn.textContent = "+";
    addBtn.title = "Add filter rule";
    addBtn.onclick = () => {
      const col = this.columns[0]?.name ?? "id";
      this.rules.push(newRule(col));
      this.render();
    };
    this.container.appendChild(addBtn);

    const applyBtn = document.createElement("button");
    applyBtn.className = "btn btn-primary";
    applyBtn.textContent = "[APPLY FILTER]";
    applyBtn.onclick = () => this.apply();
    this.container.appendChild(applyBtn);

    const clrBtn = document.createElement("button");
    clrBtn.className = "btn btn-secondary";
    clrBtn.textContent = "Clear";
    clrBtn.onclick = () => this.clear();
    this.container.appendChild(clrBtn);
  }

  private syncRulesFromDom() {
    this.container.querySelectorAll(".filter-rule").forEach((ruleEl, idx) => {
      const rule = this.rules[idx];
      if (!rule) return;

      const colSel = ruleEl.querySelector<HTMLSelectElement>("select.filter-col");
      const opSel = ruleEl.querySelector<HTMLSelectElement>("select.filter-op");
      const valueInput = ruleEl.querySelector<HTMLInputElement>("input.filter-value");

      if (colSel?.value) rule.column = colSel.value;
      if (opSel) rule.operator = opSel.value as FilterOperator;
      if (valueInput) rule.value = valueInput.value;
    });
  }

  private apply() {
    this.syncRulesFromDom();
    const columnTypes = new Map(
      this.columns.map((c) => [c.name, c.data_type] as const),
    );
    this.onApply(compileWhereClause(this.rules, this.engine, columnTypes));
  }

  private refreshColumnSelects() {
    this.container.querySelectorAll(".filter-rule").forEach((ruleEl, idx) => {
      const rule = this.rules[idx];
      const colSel = ruleEl.querySelector<HTMLSelectElement>("select.filter-col");
      if (!rule || !colSel) return;

      const current = rule.column;
      colSel.innerHTML = "";
      this.columns.forEach((c) => {
        const opt = document.createElement("option");
        opt.value = c.name;
        opt.textContent = c.name;
        if (c.name === current) opt.selected = true;
        colSel.appendChild(opt);
      });
      if (!colSel.value && this.columns[0]) {
        rule.column = this.columns[0].name;
        colSel.value = rule.column;
      }
    });
  }
}
