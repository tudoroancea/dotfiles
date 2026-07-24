import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const assetRoot = fileURLToPath(new URL("../dist/web/", import.meta.url));

describe("production assets", () => {
  it("builds the default index and every referenced hashed asset", async () => {
    const html = await readFile(`${assetRoot}index.html`, "utf8");
    const references = Array.from(html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g), (match) =>
      match[1]!.slice(1),
    );
    expect(references.length).toBeGreaterThanOrEqual(2);
    await Promise.all(
      references.map((path) => expect(readFile(`${assetRoot}${path}`)).resolves.toBeDefined()),
    );
  });
});
