import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  getAgentDir,
  getPackageDir,
  type Theme,
  type ThemeColor,
} from "@earendil-works/pi-coding-agent";
import { LIMITS } from "@dotfiles/pi-web-ui-client/wire";
import type { SnapshotTheme, ThemePalette } from "./server.js";

// Projection of Pi themes into the browser palette. These are pure helpers: they
// resolve ANSI/hex theme colors and derive the light/dark palettes the shared
// client applies through CSS custom properties.

function ansi256ToHex(index: number): string {
  const basic = [
    "#000000",
    "#800000",
    "#008000",
    "#808000",
    "#000080",
    "#800080",
    "#008080",
    "#c0c0c0",
    "#808080",
    "#ff0000",
    "#00ff00",
    "#ffff00",
    "#0000ff",
    "#ff00ff",
    "#00ffff",
    "#ffffff",
  ];
  if (index < 16) return basic[index];
  if (index < 232) {
    const cube = index - 16;
    const channel = (value: number) => (value === 0 ? 0 : 55 + value * 40);
    return `#${[Math.floor(cube / 36), Math.floor((cube % 36) / 6), cube % 6]
      .map((value) => channel(value).toString(16).padStart(2, "0"))
      .join("")}`;
  }
  const gray = Math.min(255, 8 + (index - 232) * 10)
    .toString(16)
    .padStart(2, "0");
  return `#${gray}${gray}${gray}`;
}

function ansiToHex(ansi: string, fallback: string): string {
  const rgb = ansi.match(/\x1b\[(?:38|48);2;(\d+);(\d+);(\d+)m/);
  if (rgb) {
    return `#${rgb
      .slice(1)
      .map((value) => Number(value).toString(16).padStart(2, "0"))
      .join("")}`;
  }
  const indexed = ansi.match(/\x1b\[(?:38|48);5;(\d+)m/);
  return indexed ? ansi256ToHex(Number(indexed[1])) : fallback;
}

function colorLuminance(color: string): number {
  const channels = color
    .slice(1)
    .match(/.{2}/g)!
    .map((value) => Number.parseInt(value, 16) / 255)
    .map((value) => (value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function adjustColor(color: string, factor: number): string {
  return `#${color
    .slice(1)
    .match(/.{2}/g)!
    .map((value) =>
      Math.min(255, Math.round(Number.parseInt(value, 16) * factor))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

const THEME_FOREGROUND: readonly ThemeColor[] = [
  "accent",
  "border",
  "borderAccent",
  "borderMuted",
  "success",
  "error",
  "warning",
  "muted",
  "dim",
  "text",
  "thinkingText",
  "userMessageText",
  "customMessageText",
  "customMessageLabel",
  "toolTitle",
  "toolOutput",
  "mdHeading",
  "mdLink",
  "mdLinkUrl",
  "mdCode",
  "mdCodeBlock",
  "mdCodeBlockBorder",
  "mdQuote",
  "mdQuoteBorder",
  "mdHr",
  "mdListBullet",
  "toolDiffAdded",
  "toolDiffRemoved",
  "toolDiffContext",
  "syntaxComment",
  "syntaxKeyword",
  "syntaxFunction",
  "syntaxVariable",
  "syntaxString",
  "syntaxNumber",
  "syntaxType",
  "syntaxOperator",
  "syntaxPunctuation",
  "thinkingOff",
  "thinkingMinimal",
  "thinkingLow",
  "thinkingMedium",
  "thinkingHigh",
  "thinkingXhigh",
  "thinkingMax",
  "bashMode",
];

const THEME_BACKGROUNDS = [
  "selectedBg",
  "userMessageBg",
  "customMessageBg",
  "toolPendingBg",
  "toolSuccessBg",
  "toolErrorBg",
] as const;

export function themePalette(theme: Theme, light: boolean): ThemePalette {
  const palette: ThemePalette = {};
  const base = ansiToHex(theme.getBgAnsi("userMessageBg"), light ? "#e8e8e8" : "#343541");
  const isLight = colorLuminance(base) > 0.5;
  const fallbackText = isLight ? "#1f2328" : "#e5e5e7";
  for (const name of THEME_FOREGROUND) {
    palette[name] = ansiToHex(theme.getFgAnsi(name), fallbackText);
  }
  for (const name of THEME_BACKGROUNDS) {
    palette[name] = ansiToHex(theme.getBgAnsi(name), base);
  }
  return completePalette(palette);
}

function boundPalette(palette: ThemePalette, maxProperties: number): ThemePalette {
  return Object.fromEntries(
    Object.entries(palette)
      .filter(([key]) => key.length <= LIMITS.maxThemeKeyChars)
      .slice(0, maxProperties)
      .map(([key, value]) => [key, String(value).slice(0, LIMITS.maxThemeValueChars)]),
  );
}

function completePalette(input: ThemePalette): ThemePalette {
  const palette = boundPalette(input, LIMITS.maxThemeProperties - 4);
  palette.thinkingMax ??= palette.thinkingXhigh;
  palette.hover = palette.selectedBg;
  const base = palette.userMessageBg;
  const isLight = colorLuminance(base) > 0.5;
  palette["body-bg"] = adjustColor(base, isLight ? 1.03 : 0.7);
  palette["container-bg"] = adjustColor(base, isLight ? 1 : 0.85);
  palette.colorScheme = isLight ? "light" : "dark";
  return boundPalette(palette, LIMITS.maxThemeProperties);
}

function resolveThemeValue(
  value: unknown,
  variables: Record<string, unknown>,
  visited = new Set<string>(),
): string | number {
  if (
    typeof value === "number" ||
    value === "" ||
    (typeof value === "string" && value.startsWith("#"))
  ) {
    return value;
  }
  if (typeof value !== "string" || visited.has(value) || !(value in variables)) {
    throw new Error("Invalid theme color");
  }
  visited.add(value);
  return resolveThemeValue(variables[value], variables, visited);
}

export async function themePaletteFromFile(
  name: string,
  light: boolean,
): Promise<ThemePalette | undefined> {
  const paths = [
    join(getAgentDir(), "themes", `${name}.json`),
    join(getPackageDir(), "dist", "modes", "interactive", "theme", `${name}.json`),
  ];
  for (const path of paths) {
    try {
      const json = JSON.parse(await readFile(path, "utf8")) as {
        vars?: Record<string, unknown>;
        colors?: Record<string, unknown>;
      };
      if (!json.colors) continue;
      const variables = json.vars ?? {};
      const resolved = Object.fromEntries(
        Object.entries(json.colors).map(([key, value]) => [
          key,
          resolveThemeValue(value, variables),
        ]),
      );
      const baseValue = resolved.userMessageBg;
      const base =
        typeof baseValue === "number"
          ? ansi256ToHex(baseValue)
          : baseValue || (light ? "#e8e8e8" : "#343541");
      const isLight = colorLuminance(base) > 0.5;
      const fallbackText = isLight ? "#1f2328" : "#e5e5e7";
      const palette = Object.fromEntries(
        Object.entries(resolved).map(([key, value]) => [
          key,
          typeof value === "number"
            ? ansi256ToHex(value)
            : value || (key.endsWith("Bg") ? base : fallbackText),
        ]),
      );
      return completePalette(palette);
    } catch {
      // Try the next standard theme location.
    }
  }
  return undefined;
}

export function parseAutomaticTheme(setting: string | undefined): [string, string] | undefined {
  if (!setting) return undefined;
  const names = setting.split("/").map((name) => name.trim());
  return names.length === 2 && names.every(Boolean) ? [names[0], names[1]] : undefined;
}

export type { SnapshotTheme };
