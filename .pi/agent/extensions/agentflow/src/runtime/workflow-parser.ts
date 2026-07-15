import { parse } from "acorn";
import { simple } from "acorn-walk";

export interface WorkflowMeta {
  name: string;
  description: string;
  phases: Array<{ title: string }>;
}

function literal(node: any): unknown {
  if (node?.type === "Literal") return node.value;
  if (node?.type === "ArrayExpression") return node.elements.map(literal);
  if (node?.type === "ObjectExpression") {
    const value: Record<string, unknown> = {};
    for (const property of node.properties) {
      if (property.type !== "Property" || property.computed || property.kind !== "init")
        throw new Error("meta must contain only plain properties");
      const key = property.key.type === "Identifier" ? property.key.name : property.key.value;
      value[String(key)] = literal(property.value);
    }
    return value;
  }
  throw new Error("meta must be a static literal object");
}

export function validateWorkflowScript(script: string): WorkflowMeta {
  const ast = parse(script, {
    ecmaVersion: "latest",
    sourceType: "module",
    allowAwaitOutsideFunction: true,
    allowReturnOutsideFunction: true,
  }) as any;
  let meta: WorkflowMeta | undefined;
  let childCalls = 0;
  for (const statement of ast.body) {
    if (statement.type === "ImportDeclaration" || statement.type === "ExportAllDeclaration")
      throw new Error("Imports and re-exports are not allowed");
    if (statement.type !== "ExportNamedDeclaration") continue;
    const declaration = statement.declaration;
    if (
      declaration?.type !== "VariableDeclaration" ||
      declaration.kind !== "const" ||
      declaration.declarations.length !== 1 ||
      declaration.declarations[0]?.id?.name !== "meta"
    )
      throw new Error("Only `export const meta = ...` is allowed");
    meta = literal(declaration.declarations[0].init) as WorkflowMeta;
  }
  simple(ast, {
    ImportExpression() {
      throw new Error("Dynamic import is not allowed");
    },
    Identifier(node: any) {
      if (["require", "eval", "Function", "global", "globalThis", "module"].includes(node.name))
        throw new Error(`${node.name} is not allowed`);
    },
    CallExpression(node: any) {
      if (
        node.callee?.type === "Identifier" &&
        ["agent", "finder", "oracle", "librarian", "delegate", "review"].includes(node.callee.name)
      )
        childCalls += 1;
      if (
        node.callee?.type === "MemberExpression" &&
        !node.callee.computed &&
        node.callee.object?.name === "Date" &&
        node.callee.property?.name === "now"
      )
        throw new Error("Date.now() is not allowed");
      if (
        node.callee?.type === "MemberExpression" &&
        !node.callee.computed &&
        node.callee.object?.name === "Math" &&
        node.callee.property?.name === "random"
      )
        throw new Error("Math.random() is not allowed");
    },
    NewExpression(node: any) {
      if (node.callee?.type === "Identifier" && node.callee.name === "Date")
        throw new Error("new Date() is not allowed");
    },
  } as any);
  if (!meta || typeof meta.name !== "string" || !/^[a-z][a-z0-9_]*$/.test(meta.name))
    throw new Error("meta.name must be a non-empty snake_case name");
  if (typeof meta.description !== "string" || !meta.description.trim())
    throw new Error("meta.description is required");
  if (
    meta.phases !== undefined &&
    (!Array.isArray(meta.phases) ||
      meta.phases.some((phase) => !phase || typeof phase.title !== "string" || !phase.title.trim()))
  )
    throw new Error("meta.phases must contain titled phase objects");
  if (childCalls === 0) throw new Error("Workflow must call at least one child helper");
  return { ...meta, phases: meta.phases ?? [] };
}

export function transformWorkflowScript(script: string): string {
  const ast = parse(script, {
    ecmaVersion: "latest",
    sourceType: "module",
    allowAwaitOutsideFunction: true,
    allowReturnOutsideFunction: true,
  }) as any;
  const statement = ast.body.find(
    (candidate: any) =>
      candidate.type === "ExportNamedDeclaration" &&
      candidate.declaration?.type === "VariableDeclaration" &&
      candidate.declaration.kind === "const" &&
      candidate.declaration.declarations.length === 1 &&
      candidate.declaration.declarations[0]?.id?.name === "meta",
  );
  if (!statement) throw new Error("Required `export const meta = ...` header not found");

  // Remove the export prefix using parser offsets rather than text matching, so
  // strings and comments that happen to mention the header remain untouched.
  const declaration = statement.declaration;
  const transformed =
    script.slice(0, statement.start) +
    script.slice(declaration.start, statement.end) +
    script.slice(statement.end);
  return `(async () => {\n${transformed}\n})()`;
}
