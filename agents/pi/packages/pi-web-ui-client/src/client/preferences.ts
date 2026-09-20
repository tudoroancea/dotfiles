// Display preferences (persisted to localStorage + host-scoped cookie, toggled by
// document hotkeys). These are session-UI concerns owned by the shared client.
//
// Each entry defines a boolean display toggle: its storage key, the plain single-key
// hotkey that flips it, a short label shown in the command palette, and the default
// applied on first visit. All default to hidden/collapsed per the roadmap.

import { createContext } from "preact";
import { useEffect, useState } from "preact/hooks";

export type PrefKey = "thinking" | "tools" | "timestamps" | "switches" | "systemPrompt";

export interface PrefDefinition {
  key: PrefKey;
  hotkey: string;
  label: string;
  default: boolean;
}

export type PrefState = Record<PrefKey, boolean>;

export interface PreferencesController {
  prefs: PrefState;
  toggle: (key: PrefKey) => void;
}

export const PREFS: readonly PrefDefinition[] = [
  { key: "thinking", hotkey: "t", label: "thinking", default: false },
  { key: "tools", hotkey: "e", label: "tool output", default: false },
  { key: "timestamps", hotkey: "s", label: "timestamps", default: false },
  { key: "switches", hotkey: "m", label: "model / thinking changes", default: false },
  { key: "systemPrompt", hotkey: "p", label: "system prompt", default: false },
];

function buildState(value: (pref: PrefDefinition) => boolean): PrefState {
  return Object.fromEntries(PREFS.map((pref) => [pref.key, value(pref)])) as PrefState;
}

/** True when `target` is an editable field that should keep keyboard focus. */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || /^(input|textarea|select)$/i.test(target.tagName);
}

export const PrefsContext = createContext<PreferencesController>({
  prefs: buildState((pref) => pref.default),
  toggle: () => {},
});

const storageKey = (key: PrefKey) => `web-ui.pref.${key}`;
const cookieKey = (key: PrefKey) => `pi_web_ui_${key}`;
const legacyStorageKey = (key: PrefKey) => `web-ui-simple.pref.${key}`;
const legacyCookieKey = (key: PrefKey) => `pi_web_ui_simple_${key}`;

function readPreference(key: PrefKey): boolean | undefined {
  for (const keyForCookie of [cookieKey, legacyCookieKey]) {
    const prefix = `${keyForCookie(key)}=`;
    const cookie = document.cookie
      .split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith(prefix));
    if (cookie) return cookie.slice(prefix.length) === "1";
  }
  try {
    const stored =
      localStorage.getItem(storageKey(key)) ?? localStorage.getItem(legacyStorageKey(key));
    return stored === null ? undefined : stored === "1";
  } catch {
    return undefined;
  }
}

function persistPreference(key: PrefKey, value: boolean): void {
  const stored = value ? "1" : "0";
  try {
    localStorage.setItem(storageKey(key), stored);
  } catch {
    // Persistence remains best-effort.
  }
  try {
    // Cookies are host-scoped rather than port-scoped, so this fallback carries
    // preferences across the server's ephemeral ports.
    document.cookie = `${cookieKey(key)}=${stored}; Path=/; Max-Age=31536000; SameSite=Strict`;
  } catch {
    // The same-server localStorage value still applies when cookies are blocked.
  }
}

export function usePreferences(
  blockedRef: { current: boolean } | undefined,
  beforeToggle?: (key: PrefKey) => void,
): PreferencesController {
  const [prefs, setPrefs] = useState<PrefState>(() =>
    buildState((pref) => readPreference(pref.key) ?? pref.default),
  );

  const toggle = (key: PrefKey) => {
    beforeToggle?.(key);
    setPrefs((prev) => {
      const next = { ...prev, [key]: !prev[key] };
      persistPreference(key, next[key]);
      return next;
    });
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // Transcript display dialogs keep their advertised hotkeys live. Other
      // dialogs reserve plain-key input while open.
      if (blockedRef?.current && !document.querySelector("#palette-title, #cheatsheet-title"))
        return;
      if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || event.repeat) return;
      if (isEditableTarget(event.target)) return;
      const pref = PREFS.find((p) => p.hotkey === event.key.toLowerCase());
      if (!pref) return;
      event.preventDefault();
      toggle(pref.key);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  return { prefs, toggle };
}
