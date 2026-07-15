import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { transformWorkflowScript, validateWorkflowScript } from "../src/runtime/workflow-parser.ts";

describe("workflow parser", () => {
  const valid = `export const meta = { name: "review_auth", description: "Review auth", phases: [{ title: "Inspect" }] }\nphase("Inspect")\nconst result = await agent("inspect", { label: "scout" })\nreturn { result }`;

  it("extracts static metadata and wraps top-level return", async () => {
    expect(validateWorkflowScript(valid).name).toBe("review_auth");
    const context = vm.createContext({ phase() {}, agent: async () => "ok" });
    await expect(
      new vm.Script(transformWorkflowScript(valid)).runInContext(context),
    ).resolves.toEqual({ result: "ok" });
  });

  it("accepts semantic child helpers without a raw agent call", () => {
    const script = `export const meta = { name: "semantic", description: "Semantic" }\nreturn await look_at({ path: "screen.png", objective: "inspect" })`;
    expect(validateWorkflowScript(script).name).toBe("semantic");
  });

  it("only transforms the parsed meta export, not matching strings or comments", async () => {
    const script = `const example = "export const meta = string content"
// export const meta = comment content
export /* metadata */ const meta = { name: "safe_transform", description: "Safe" }
const result = await agent(example)
return { result, example }`;
    validateWorkflowScript(script);
    const context = vm.createContext({ agent: async (prompt: string) => prompt });
    await expect(
      new vm.Script(transformWorkflowScript(script)).runInContext(context),
    ).resolves.toEqual({
      result: "export const meta = string content",
      example: "export const meta = string content",
    });
  });

  it.each([
    [`export const meta = { name: "x", description: "x" }; return 1`, "child helper"],
    [
      `import fs from "node:fs"; export const meta = { name: "x", description: "x" }; agent("x")`,
      "Imports",
    ],
    [`export const meta = { name: "x", description: "x" }; Date.now(); agent("x")`, "Date.now"],
    [`export const meta = { name: "bad-name", description: "x" }; agent("x")`, "snake_case"],
  ])("rejects unsafe or malformed scripts", (script, message) => {
    expect(() => validateWorkflowScript(script)).toThrow(message);
  });
});
