# pi-fff-renderers

Loads [`@ff-labs/pi-fff`](https://github.com/dmtrKovalenko/fff/tree/main/packages/pi-fff) and
replaces its two tool-renderer slots with ones that match the rest of this setup.

The vendor owns `ffgrep` and `fffind`: their `execute` is native FFF search, and no Pi API exposes
another extension's registered `ToolDefinition`. So the only faithful override is to be the
extension that loads the vendor and to intercept `registerTool` on the way through. `src/index.ts`
passes the vendor a proxied `ExtensionAPI` that swaps `renderCall`/`renderResult` for the ones in
`agent/extensions/lib/tools/fff.ts` and forwards everything else — `execute`, the schemas, the
`/fff-mode`, `/fff-health` and `/fff-rescan` commands, the four flags, the lifecycle handlers and
the `@`-mention autocomplete provider — untouched.

## Why the vendor is a dependency here

`@ff-labs/pi-fff` is deliberately **not** in `agent/settings.json`'s `packages`: it would load a
second time, unwrapped, and register its tools first. It is a dependency of this package instead,
which also means:

- the version is pinned in `package.json` where the rest of them are, so `pi update --extensions`
  cannot move it, and a bump is a reviewable diff;
- the vendor ships `files: ["src"]` with no `main`/`exports`, so `@ff-labs/pi-fff/src/index.ts` is
  the entry. Pi's loader transpiles it with jiti exactly like our own sources, and its
  `@earendil-works/*` and `@sinclair/typebox` imports resolve through jiti's aliases;
- the compiler is kept out of the vendor's sources by `src/vendor.d.ts` plus a `paths` mapping,
  because they do not typecheck under our settings (extensionless relative imports, nullable
  finder fields) and they are not ours to fix.

Fff's tools and commands are attributed to this wrapper in `/extensions`. Backing out is: restore
the settings entry, delete this package.

## What the renderers change

Against the vendor's own renderers, which show the first 15 or 20 output lines and ignore
`details`:

- headers gain the arguments the vendor drops — `exclude`, `caseSensitive`, `context`, and
  `cursor` as `next page`;
- `fffind` reports a real total. `SearchResult.totalMatched` counts every match, while the text is
  capped by `limit` and sampled down to five items when the top score is scattered noise, so
  counting its lines undercounts badly. `ffgrep` has no such total — its `totalMatched` is
  documented as "always equal to items.length" and it prints every item — so its matches and files
  are counted from the shape of the text. **`totalFiles` is never a summary in either tool**: it is
  "total number of indexed files (before any filtering)", the size of the repo index. Reporting it
  as "files" would claim a two-match result touched 521 files;
- the bracketed notices the tools append — and the fuzzy-fallback notice `ffgrep` _prepends_ — are
  surfaced separately instead of sitting inside the output window.

Tool names are mode-dependent, so `FFF_RENDERERS` is keyed by every name the three `/fff-mode`
values register (`ffgrep`/`fffind`/`fff-multi-grep`, and `grep`/`find`/`multi_grep` under
`override`). A tool the vendor registers under a name that is not in that map keeps the vendor's
own renderers, and the wrapper notifies at `session_start` rather than letting a rename pass
unnoticed.

## `/fff-mode override` does not work in this setup

Not a consequence of this package, but worth knowing before reaching for that mode. Pi resolves a
tool name to its **first** registration in extension load order, and `agent/extensions/` is walked
alphabetically, so `builtin-tool-renderers.ts` claims `grep` and `find` before anything in `fff/`
can. In `override` mode FFF renames its tools to exactly those names, so Pi's own built-in
`grep`/`find` win — `execute` included — and FFF's native search is never reached. Agentflow's
search children then fail too: `resolveSearchExtension()` looks for the extension providing
`ffgrep`/`fffind`, and under `override` no extension does.

This predates the wrapper (the vendor also loaded after `agent/extensions/`, from the settings
`packages` list). The mode this setup uses is `tools-and-ui`, where the FFF tools have their own
names and nothing shadows them, and that is a decision rather than an accident: **if this setup
ever moves to `override`, the fix is to drop our renderers for the built-in `grep`/`find`** —
`builtin-tool-renderers.ts` and the two entries in `lib/tools/builtin.ts` — so the names belong to
FFF alone. The `grep`/`find` entries in `FFF_RENDERERS` are kept for that day.

## Verification

```sh
nub run --filter pi-fff-renderers test        # the proxy: both slots replaced, everything forwarded
nub run --filter pi-extension-integration-tests test   # the renderers themselves, and the goldens
```

`test/wrapper.test.ts` loads the real vendor against a stub `ExtensionAPI`, which is safe because
its factory only registers things — the native index is built later, from its own `session_start`
handler. After a change, smoke-test `/reload`, `/fff-mode` switching, cursor pagination and
`@`-mentions in a live session.

These renderers are worth offering upstream. If they land there, delete this package and restore
the vendor's own entry in `agent/settings.json`.
