// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CspVirtualStyleManager, findVirtualStyleSheet } from "../src/web/csp-virtual-styles.js";

let authoredStyle: HTMLStyleElement;
let sheet: CSSStyleSheet;

function ruleText(): string[] {
  return [...sheet.cssRules].map((rule) => rule.cssText);
}

beforeEach(() => {
  authoredStyle = document.createElement("style");
  authoredStyle.textContent = ".timeline[data-virtual-list] { position: relative; }";
  document.head.append(authoredStyle);
  sheet = authoredStyle.sheet!;
});

afterEach(() => authoredStyle.remove());

describe("CSP virtual-style manager", () => {
  it("finds the opted-in authored sheet and updates only its CSSOM rules", () => {
    expect(findVirtualStyleSheet(document)).toBe(sheet);
    const manager = new CspVirtualStyleManager(sheet);

    manager.update(12_345.5, [
      { index: 4, start: 400.25 },
      { index: 5, start: 512 },
    ]);

    expect(ruleText()).toEqual(
      expect.arrayContaining([
        expect.stringContaining(`${manager.listId}"] { height: 12345.5px;`),
        expect.stringContaining('data-virtual-index="4"'),
        expect.stringContaining("translateY(400.25px)"),
        expect.stringContaining('data-virtual-index="5"'),
      ]),
    );
    expect(document.querySelectorAll("style")).toHaveLength(1);
    expect(document.querySelector("[style]")).toBeNull();
  });

  it("replaces changed rules, drops unmounted rows, and cleans up on dispose", () => {
    const baseline = sheet.cssRules.length;
    const manager = new CspVirtualStyleManager(sheet);
    manager.update(1000, [
      { index: 1, start: 100 },
      { index: 2, start: 200 },
    ]);
    expect(sheet.cssRules).toHaveLength(baseline + 3);

    manager.update(1200, [
      { index: 2, start: 225 },
      { index: 9, start: 900 },
    ]);
    expect(sheet.cssRules).toHaveLength(baseline + 3);
    expect(ruleText().join("\n")).not.toContain('data-virtual-index="1"');
    expect(ruleText().join("\n")).toContain("translateY(225px)");

    manager.dispose();
    manager.dispose();
    expect(sheet.cssRules).toHaveLength(baseline);
    expect(() => manager.update(1, [])).toThrow(/disposed/);
  });

  it("isolates concurrent timelines and disposing one preserves the other", () => {
    const baseline = sheet.cssRules.length;
    const first = new CspVirtualStyleManager(sheet);
    const second = new CspVirtualStyleManager(sheet);
    first.update(500, [{ index: 0, start: 0 }]);
    second.update(900, [{ index: 7, start: 700 }]);

    expect(first.listId).not.toBe(second.listId);
    expect(sheet.cssRules).toHaveLength(baseline + 4);
    first.dispose();
    const remaining = ruleText().join("\n");
    expect(remaining).not.toContain(first.listId);
    expect(remaining).toContain(second.listId);
    expect(sheet.cssRules).toHaveLength(baseline + 2);

    second.dispose();
    expect(sheet.cssRules).toHaveLength(baseline);
  });
});
