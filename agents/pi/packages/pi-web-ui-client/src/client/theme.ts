// Theme application.
//
// The palette is delivered as data and applied by writing CSS custom properties
// directly onto the document element via the CSSOM. This is strict-CSP compatible
// (no injected `<style>` element and no `style-src 'unsafe-inline'`), unlike the
// previous inline stylesheet. Automatic light/dark still tracks the OS preference
// through a `matchMedia` listener rather than a CSS `@media` rule.

import { useEffect } from "preact/hooks";
import type { SnapshotTheme, ThemePalette } from "../wire/types.ts";

function applyPalette(palette: ThemePalette): void {
  const root = document.documentElement;
  if (typeof palette.colorScheme === "string") {
    root.style.setProperty("color-scheme", palette.colorScheme);
  }
  for (const [name, value] of Object.entries(palette)) {
    if (name === "colorScheme") continue;
    root.style.setProperty(`--${name}`, String(value));
  }
}

export function useTheme(theme: SnapshotTheme | undefined): void {
  useEffect(() => {
    if (!theme) return undefined;
    const { auto, light, dark } = theme;
    if (!auto) {
      applyPalette(dark);
      return undefined;
    }
    const media = matchMedia("(prefers-color-scheme: light)");
    const update = () => applyPalette(media.matches ? light : dark);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [theme]);
}
