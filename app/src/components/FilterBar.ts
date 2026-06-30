import { compileWhereClause, newRule, OPERATORS, type FilterRule } from "../lib/filter";

export class FilterBar {
  private container: HTMLElement;
  private rules: FilterRule[] = [];
  private columns: string[] = [];
  private onChange: (where: string) => void;

  constructor(container: HTMLElement, onChange: (where: string) => void) {
    this.container = container;
    this.onChange  = onChange;
    this.render();
  }

  setColumns(cols: string[]) {
    this.columns = cols;
    this.render();
  }

  setRules(rules: FilterRule[]) {
    this.rules = rules;
    this.render();
  }

  clear() {
    this.rules = [];
    this.render();
    this.onChange("");
  }

  private render() {
    this.container.innerHTML = "";

    if (this.rules.length === 0) {
      const addBtn = document.createElement("button");
      addBtn.className = "btn btn-secondary";
      addBtn.textContent = "+ Add Filter";
      addBtn.onclick = () => {
        const col = this.columns[0] ?? "id";
        this.rules.push(newRule(col));
        this.render();
      };
      this.container.appendChild(addBtn);
      return;
    }

    this.rules.forEach((rule, idx) => {
      const ruleEl = document.createElement("div");
      ruleEl.className = "filter-rule";

      // Conjunction (AND/OR) — shown before rule except first
      if (idx > 0) {
        const conjSel = document.createElement("select");
        conjSel.style.cssText = "width:60px;padding:2px 4px;";
        ["AND","OR"].forEach(v => {
          const opt = document.createElement("option");
          opt.value = v; opt.textContent = v;
          if (v === this.rules[idx-1].conjunction) opt.selected = true;
          conjSel.appendChild(opt);
        });
        conjSel.onchange = () => {
          this.rules[idx-1].conjunction = conjSel.value as "AND"|"OR";
          this.emit();
        };
        this.container.appendChild(conjSel);
      }

      // Column selector
      const colSel = document.createElement("select");
      colSel.style.cssText = "max-width:140px;";
      this.columns.forEach(c => {
        const opt = document.createElement("option");
        opt.value = c; opt.textContent = c;
        if (c === rule.column) opt.selected = true;
        colSel.appendChild(opt);
      });
      colSel.onchange = () => { rule.column = colSel.value; this.emit(); };
      ruleEl.appendChild(colSel);

      // Operator selector
      const opSel = document.createElement("select");
      opSel.style.cssText = "width:120px;";
      OPERATORS.forEach(op => {
        const opt = document.createElement("option");
        opt.value = op; opt.textContent = op;
        if (op === rule.operator) opt.selected = true;
        opSel.appendChild(opt);
      });
      opSel.onchange = () => {
        rule.operator = opSel.value as any;
        // Show/hide value input for nullary operators
        valueInput.style.display = ["IS NULL","IS NOT NULL"].includes(rule.operator) ? "none" : "";
        this.emit();
      };
      ruleEl.appendChild(opSel);

      // Value input
      const valueInput = document.createElement("input");
      valueInput.type = "text";
      valueInput.value = rule.value;
      valueInput.placeholder = "value";
      valueInput.style.cssText = "width:140px;";
      if (["IS NULL","IS NOT NULL"].includes(rule.operator)) valueInput.style.display = "none";
      valueInput.oninput = () => { rule.value = valueInput.value; this.emit(); };
      ruleEl.appendChild(valueInput);

      // Remove button
      const rmBtn = document.createElement("button");
      rmBtn.className = "btn-icon";
      rmBtn.textContent = "✕";
      rmBtn.title = "Remove filter";
      rmBtn.onclick = () => {
        this.rules.splice(idx, 1);
        this.render();
        this.emit();
      };
      ruleEl.appendChild(rmBtn);

      this.container.appendChild(ruleEl);
    });

    // + Add button
    const addBtn = document.createElement("button");
    addBtn.className = "btn btn-secondary";
    addBtn.textContent = "+";
    addBtn.title = "Add filter rule";
    addBtn.onclick = () => {
      const col = this.columns[0] ?? "id";
      this.rules.push(newRule(col));
      this.render();
    };
    this.container.appendChild(addBtn);

    // Clear button
    const clrBtn = document.createElement("button");
    clrBtn.className = "btn btn-secondary";
    clrBtn.textContent = "Clear";
    clrBtn.onclick = () => this.clear();
    this.container.appendChild(clrBtn);
  }

  private emit() {
    this.onChange(compileWhereClause(this.rules));
  }
}
