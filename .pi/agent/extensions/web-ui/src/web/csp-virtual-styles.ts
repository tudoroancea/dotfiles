const STYLESHEET_MARKER_SELECTOR = ".timeline[data-virtual-list]";

export interface VirtualStyleItem {
  index: number;
  start: number;
}

interface ManagedRule {
  rule: CSSRule;
  value: number;
}

let nextListId = 0;

function cssRules(sheet: CSSStyleSheet): CSSRuleList | undefined {
  try {
    return sheet.cssRules;
  } catch {
    // Cross-origin sheets expose a CSSStyleSheet but deny CSSOM access.
    return undefined;
  }
}

function hasMarker(sheet: CSSStyleSheet): boolean {
  const rules = cssRules(sheet);
  if (!rules) return false;
  return [...rules].some(
    (rule) => "selectorText" in rule && rule.selectorText === STYLESHEET_MARKER_SELECTOR,
  );
}

/** Find the authored stylesheet that explicitly opts into virtual CSSOM rules. */
export function findVirtualStyleSheet(document: Document): CSSStyleSheet {
  for (const sheet of document.styleSheets) {
    if (hasMarker(sheet)) return sheet;
  }
  throw new Error(`Missing CSP virtual-style marker ${STYLESHEET_MARKER_SELECTOR}`);
}

function deleteRule(sheet: CSSStyleSheet, rule: CSSRule): void {
  const rules = cssRules(sheet);
  if (!rules) return;
  const index = [...rules].indexOf(rule);
  if (index >= 0) sheet.deleteRule(index);
}

function finitePixels(value: number): number {
  if (!Number.isFinite(value) || value < 0)
    throw new RangeError("Virtual positions must be finite");
  return Math.round(value * 100) / 100;
}

/**
 * Owns the dynamic rules for one virtual list. Rules are inserted into the
 * already-authorized authored stylesheet, never into a style element or an
 * element's inline declaration. Each manager has an isolated selector scope.
 */
export class CspVirtualStyleManager {
  readonly listId = `timeline-${++nextListId}`;
  private totalRule: ManagedRule | undefined;
  private readonly rowRules = new Map<number, ManagedRule>();
  private disposed = false;

  constructor(private readonly sheet?: CSSStyleSheet) {}

  update(totalSize: number, items: readonly VirtualStyleItem[]): void {
    if (this.disposed) throw new Error("Cannot update a disposed virtual-style manager");

    const total = finitePixels(totalSize);
    // Component tests intentionally mount without loading the application CSS.
    // A real document has a parser-blocking external stylesheet before scripts.
    if (!this.sheet) return;
    if (this.totalRule?.value !== total) {
      if (this.totalRule) deleteRule(this.sheet, this.totalRule.rule);
      const index = this.sheet.insertRule(
        `.timeline[data-virtual-list="${this.listId}"]{height:${total}px}`,
        this.sheet.cssRules.length,
      );
      this.totalRule = { rule: this.sheet.cssRules[index]!, value: total };
    }

    const mounted = new Set<number>();
    for (const item of items) {
      if (!Number.isInteger(item.index) || item.index < 0) {
        throw new RangeError("Virtual row indexes must be non-negative integers");
      }
      if (mounted.has(item.index)) throw new Error(`Duplicate virtual row index ${item.index}`);
      mounted.add(item.index);
      const start = finitePixels(item.start);
      const current = this.rowRules.get(item.index);
      if (current?.value === start) continue;
      if (current) deleteRule(this.sheet, current.rule);
      const index = this.sheet.insertRule(
        `.timeline[data-virtual-list="${this.listId}"] > .timeline__row[data-virtual-index="${item.index}"]{transform:translateY(${start}px)}`,
        this.sheet.cssRules.length,
      );
      this.rowRules.set(item.index, { rule: this.sheet.cssRules[index]!, value: start });
    }

    for (const [index, managed] of this.rowRules) {
      if (mounted.has(index)) continue;
      deleteRule(this.sheet, managed.rule);
      this.rowRules.delete(index);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (!this.sheet) return;
    if (this.totalRule) deleteRule(this.sheet, this.totalRule.rule);
    this.totalRule = undefined;
    for (const managed of this.rowRules.values()) deleteRule(this.sheet, managed.rule);
    this.rowRules.clear();
  }
}

export function createCspVirtualStyleManager(document: Document): CspVirtualStyleManager {
  if (document.styleSheets.length === 0) return new CspVirtualStyleManager();
  return new CspVirtualStyleManager(findVirtualStyleSheet(document));
}
