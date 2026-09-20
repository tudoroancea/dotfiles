# Pi extension event-bus listeners survive `session.reload()`

Tested with `@earendil-works/pi-coding-agent` 0.82.1.

## Expected

Listeners registered through `pi.events.on()` belong to the extension runtime that registered them. After `session.reload()` invalidates that runtime, only the replacement runtime's listener should remain.

## Actual

The old listener remains on the shared `EventBus`. Each reload adds another listener.

## Minimal reproduction

Save as `mre.mjs` in a Node project containing `@earendil-works/pi-coding-agent` 0.82.1, then run `node mre.mjs`.

```js
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  createAgentSession,
  createEventBus,
} from "@earendil-works/pi-coding-agent";

process.env.PI_OFFLINE = "1";
const root = await mkdtemp(join(tmpdir(), "pi-event-bus-reload-"));
const bus = createEventBus();
let extensionHits = 0;
let hostHits = 0;
let firstPi;

// This listener belongs to the SDK host, not to an extension runtime.
bus.on("mre:ping", () => {
  hostHits += 1;
});

const extension = {
  name: "event-bus-reload-mre",
  factory(pi) {
    firstPi ??= pi;
    pi.events.on("mre:ping", () => {
      extensionHits += 1;
    });
  },
};

try {
  const settingsManager = SettingsManager.inMemory();
  const loader = new DefaultResourceLoader({
    cwd: root,
    agentDir: root,
    settingsManager,
    eventBus: bus,
    extensionFactories: [extension],
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await loader.reload();

  const { session } = await createAgentSession({
    cwd: root,
    agentDir: root,
    resourceLoader: loader,
    settingsManager,
    sessionManager: SessionManager.inMemory(root),
    noTools: "all",
  });
  await session.bindExtensions({ mode: "json" });

  const listenersCalled = async () => {
    const beforeExtension = extensionHits;
    const beforeHost = hostHits;
    bus.emit("mre:ping", undefined);
    await new Promise((resolve) => setImmediate(resolve));
    return {
      extension: extensionHits - beforeExtension,
      host: hostHits - beforeHost,
    };
  };

  console.log("initial", await listenersCalled());
  await session.reload();
  let oldApiStale = false;
  try {
    firstPi.getCommands();
  } catch {
    oldApiStale = true;
  }
  console.log("old API stale", oldApiStale);
  console.log("after reload 1", await listenersCalled());
  await session.reload();
  console.log("after reload 2", await listenersCalled());

  session.dispose();
  console.log("after dispose", await listenersCalled());
  bus.clear();
} finally {
  await rm(root, { recursive: true, force: true });
}
```

Output:

```text
initial { extension: 1, host: 1 }
old API stale false
after reload 1 { extension: 2, host: 1 }
after reload 2 { extension: 3, host: 1 }
after dispose { extension: 3, host: 1 }
```

## Cause and proposed ownership rule

`createExtensionAPI()` currently exposes the raw shared event bus as `pi.events`. Although `EventBus.on()` returns an unsubscribe callback, Pi does not associate it with the registering extension runtime. In addition, `AgentSession.reload()` replaces the old `ExtensionRunner` without calling `ExtensionRunner.invalidate()`, so the captured pre-reload API remains active.

A suitable upstream fix is to expose an extension-scoped wrapper and complete the invalidation lifecycle:

1. wrap `pi.events.on()` and retain each returned unsubscribe callback on the loaded extension/runtime;
2. after `session_shutdown`, invalidate the old runner before `AgentSession.reload()` discards it;
3. ensure normal `AgentSession`/`AgentSessionRuntime` disposal and session-replacement paths also invalidate the discarded runner;
4. have invalidation unsubscribe only that runtime's retained listeners;
5. keep `emit()` connected to the shared bus;
6. make cleanup idempotent and safe when an extension already called the returned unsubscribe function;
7. add reload, session replacement, normal disposal, captured-stale-API, and externally supplied `EventBus` regression tests.

The fixed behavior should call one extension listener and one host listener after every reload, reject the captured old API, and call only the host listener after disposal.

This must not call `EventBusController.clear()`: the MRE's host listener—and potentially sibling runtimes—also use the externally supplied bus. Cleanup must remove only listeners registered by the invalidated extension runtime.
