/**
 * The vendor's entry point, as much of it as we use.
 *
 * `@ff-labs/pi-fff` ships TypeScript sources with no `main`/`exports`, so the subpath import is
 * the entry — but pulling those sources into our program would typecheck them under our
 * settings, not theirs, and they do not pass (extensionless relative imports, nullable finder
 * fields). The `paths` mapping in `tsconfig.json` points the specifier here instead, so the
 * vendor stays an opaque factory to the compiler while jiti resolves the real file at runtime.
 */
declare module "@ff-labs/pi-fff/src/index.ts" {
  import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

  export default function fffExtension(pi: ExtensionAPI): void;
}
