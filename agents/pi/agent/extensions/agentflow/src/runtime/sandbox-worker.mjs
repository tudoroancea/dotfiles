import vm from "node:vm";
const token = process.argv[2];
let sequence = 0;
let active = 0;
const pending = new Map();
const send = (message) => process.send?.({ token, ...message });
process.on("message", async (message) => {
  if (!message || message.token !== token) return;
  if (message.type === "response") {
    const p = pending.get(message.id);
    if (p) {
      pending.delete(message.id);
      active--;
      p.resolve(message.result);
    }
    return;
  }
  if (message.type !== "init") return;
  const request = (type, payload) =>
    new Promise((resolve, reject) => {
      const id = `q${++sequence}`;
      active++;
      pending.set(id, { resolve, reject });
      send({ type: "request", id, requestType: type, payload });
    });
  const agent = (prompt, options = {}) => request("agent", { prompt, options });
  const finder = (input) => request("finder", input);
  const oracle = (input) => request("oracle", input);
  const librarian = (input) => request("librarian", input);
  const look_at = (input) => request("look_at", input);
  const delegate = (input) => request("delegate", input);
  const review = (input) => request("review", input);
  const phase = (title) => {
    send({ type: "event", eventType: "phase", value: title });
  };
  const log = (value) => {
    send({ type: "event", eventType: "log", value: String(value) });
  };
  const parallel = (thunks) => Promise.all(thunks.map((fn) => Promise.resolve().then(fn)));
  const pipeline = (items, ...stages) =>
    Promise.all(
      items.map(async (original, index) => {
        let value = original;
        for (const stage of stages) {
          value = await stage(value, original, index);
        }
        return value;
      }),
    );
  const context = vm.createContext(
    Object.assign(Object.create(null), {
      agent,
      finder,
      oracle,
      librarian,
      look_at,
      delegate,
      review,
      phase,
      log,
      parallel,
      pipeline,
      args: message.args,
      cwd: message.cwd,
      budget: Object.freeze(message.budget),
    }),
    { codeGeneration: { strings: false, wasm: false } },
  );
  try {
    const result = await new vm.Script(message.code, {
      filename: "workflow.agentflow.js",
    }).runInContext(context, { timeout: message.vmTimeoutMs });
    if (active !== 0) throw new Error(`Workflow returned with ${active} unawaited agent call(s)`);
    structuredClone(result);
    send({ type: "done", result });
  } catch (error) {
    const message =
      error && typeof error === "object" && typeof error.message === "string"
        ? error.message
        : String(error);
    send({ type: "failed", error: message });
  }
});
