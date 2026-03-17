/**
 * startup-banner.ts — One-shot welcome card for YUAN CLI
 *
 * Pure chalk + process.stdout.write(). No Ink, no React, no Yoga.
 * Printed once on startup; becomes part of terminal scrollback.
 */

import chalk from "chalk";
import { homedir } from "os";

// ── Public API ──────────────────────────────────────────────────

export interface BannerOptions {
  version: string;
  model: string;
  provider: string;
  cwd: string;
}

export function printStartupBanner(opts: BannerOptions): void {
  const cols = process.stdout.columns ?? 80;
  const env = detectEnv();

  if (!env.isTTY) {
    printMinimal(opts);
    return;
  }

  if (env.isAscii) {
    printAsciiFallback(opts, env.hasColor);
    return;
  }

  if (cols >= 70) {
    printFull(opts, cols, env.hasColor);
  } else if (cols >= 50) {
    printMini(opts, cols, env.hasColor);
  } else {
    printSingleLine(opts, env.hasColor);
  }
}

// ── Environment detection ───────────────────────────────────────

interface Env {
  isTTY: boolean;
  hasColor: boolean;
  isAscii: boolean;
}

function detectEnv(): Env {
  const isTTY = !!process.stdout.isTTY;
  const noColor = "NO_COLOR" in process.env;
  const isDumb = process.env.TERM === "dumb";

  return {
    isTTY,
    hasColor: isTTY && !noColor && !isDumb,
    isAscii: isDumb,
  };
}

// ── Helpers ─────────────────────────────────────────────────────

function shortenCwd(cwd: string): string {
  const home = homedir();
  if (cwd === home) return "~";
  if (cwd.startsWith(home + "/")) return "~" + cwd.slice(home.length);
  return cwd;
}

/** Visible-character length (strips ANSI escapes). */
function visLen(s: string): number {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}

/** Pad `s` to exactly `len` visible characters. */
function padR(s: string, len: number): string {
  const diff = len - visLen(s);
  return diff > 0 ? s + " ".repeat(diff) : s;
}

function write(s: string): void {
  process.stdout.write(s + "\n");
}

// ── Box-drawing tokens ──────────────────────────────────────────

const B = {
  tl: "╭",
  tr: "╮",
  bl: "╰",
  br: "╯",
  h: "─",
  v: "│",
} as const;

// ── Fox mascot pixel art ────────────────────────────────────────
//
// 8 rows x 8 cols. Each cell is 2-char wide when rendered.
// . = transparent, O = orange body, D = dark outline,
// W = white face/belly, N = black eyes/nose, T = yellow tips

const PALETTE: Record<string, string> = {
  O: "#f97316",
  D: "#c2410c",
  W: "#f8fafc",
  N: "#94a3b8",
  T: "#fcd34d",
};

const SPRITE_DATA: string[] = [
  "DTOOOTD.",
  "DOOOOOD.",
  "DONWWNOD",
  "DOWWWWOD",
  ".DOWOOD.",
  ".DOOOD..",
  "DOOOOOD.",
  ".DD..DD.",
];

function renderSpriteLine(row: string, color: boolean): string {
  let out = "";
  for (const ch of row) {
    if (ch === ".") {
      out += "  ";
    } else if (color && PALETTE[ch]) {
      out += chalk.bgHex(PALETTE[ch])("  ");
    } else {
      // no-color fallback: use character doubling
      out += ch === "D" || ch === "N" ? "##" : ch === "." ? "  " : "@@";
    }
  }
  return out;
}

// ── Banner renderers ────────────────────────────────────────────

function printMinimal(opts: BannerOptions): void {
  write(`YUAN v${opts.version} · ${opts.model}`);
}

function printSingleLine(opts: BannerOptions, color: boolean): void {
  const text = `YUAN v${opts.version} · ${opts.model}`;
  write(color ? chalk.bold(text) : text);
}

function printAsciiFallback(opts: BannerOptions, color: boolean): void {
  const dir = shortenCwd(opts.cwd);
  const lines = [
    `  /|  |\\`,
    ` (o'--'o)  YUAN v${opts.version}`,
    `  > ^^ <   ${opts.model} · ${opts.provider}`,
    ` /|    |\\  ${dir}`,
  ];

  write("");
  for (const ln of lines) {
    write(color ? chalk.hex("#f97316")(ln) : ln);
  }
  write("");
}

/**
 * Mini banner (50–69 cols): bordered text, no mascot.
 *
 * ╭── YUAN v1.0.56 ──────────────────────╮
 * │  model   gemini-2.5-flash            │
 * │  via     google                      │
 * │  dir     ~/projects                  │
 * │                                      │
 * │  Type /help for commands             │
 * ╰──────────────────────────────────────╯
 */
function printMini(opts: BannerOptions, cols: number, color: boolean): void {
  const inner = cols - 2; // inside the two border chars
  const dir = shortenCwd(opts.cwd);

  const titleText = ` YUAN v${opts.version} `;
  const titleFill = inner - 2 - titleText.length; // 2 for "──" prefix
  const topLine =
    B.tl +
    B.h.repeat(2) +
    (color ? chalk.bold(titleText) : titleText) +
    B.h.repeat(Math.max(0, titleFill)) +
    B.tr;

  const bottom = B.bl + B.h.repeat(inner) + B.br;

  // Re-format info lines with dim labels when color is available
  const formattedInfoLines = [
    formatInfoPair("model", opts.model, color),
    formatInfoPair("via", opts.provider, color),
    formatInfoPair("dir", dir, color),
    "",
    color
      ? `  Type ${chalk.bold("/help")} for commands`
      : "  Type /help for commands",
  ];

  write("");
  write(color ? chalk.dim(topLine) : topLine);
  for (const ln of formattedInfoLines) {
    write(
      (color ? chalk.dim(B.v) : B.v) +
        padR(ln, inner) +
        (color ? chalk.dim(B.v) : B.v),
    );
  }
  write(color ? chalk.dim(bottom) : bottom);
  write("");
}

/**
 * Full banner (≥70 cols): mascot left, info right, bordered.
 */
function printFull(opts: BannerOptions, cols: number, color: boolean): void {
  const inner = cols - 2; // inside border
  const dir = shortenCwd(opts.cwd);
  const dimV = color ? chalk.dim(B.v) : B.v;

  // Title bar
  const titleText = ` YUAN v${opts.version} `;
  const titleFill = inner - 2 - titleText.length;
  const topLine =
    B.tl +
    B.h.repeat(2) +
    (color ? chalk.bold(titleText) : titleText) +
    B.h.repeat(Math.max(0, titleFill)) +
    B.tr;

  const bottom = B.bl + B.h.repeat(inner) + B.br;

  // Left column: 2 pad + 16 sprite + 2 pad = 20
  const leftWidth = 20;
  // Divider: 1 char "│" + 1 space
  const divWidth = 3; // " │  "
  // Right column: remaining
  const rightWidth = inner - leftWidth - divWidth;

  // Right-side info rows (8 rows to match sprite)
  const infoRows: string[] = [
    formatInfoPair("model", opts.model, color),
    formatInfoPair("via", opts.provider, color),
    formatInfoPair("dir", dir, color),
    "",
    color
      ? `  Type ${chalk.bold("/help")} for commands`
      : "  Type /help for commands",
    "",
    "",
    "",
  ];

  // Center info vertically: sprite is 8 rows, info has content in first ~5
  // Keep them top-aligned (row 0 of sprite = row 0 of info).

  write("");
  write(color ? chalk.dim(topLine) : topLine);

  for (let i = 0; i < 8; i++) {
    const sprite = renderSpriteLine(SPRITE_DATA[i], color);
    const info = infoRows[i] ?? "";

    const leftContent = "  " + sprite + "  "; // 2+16+2 = 20
    const divider = color ? ` ${chalk.dim(B.v)} ` : ` ${B.v} `;
    const rightContent = padR(info, rightWidth);

    write(dimV + leftContent + divider + rightContent + dimV);
  }

  write(color ? chalk.dim(bottom) : bottom);
  write("");
}

function formatInfoPair(
  label: string,
  value: string,
  color: boolean,
): string {
  const padded = label.padEnd(8);
  if (color) {
    return `  ${chalk.dim(padded)}${value}`;
  }
  return `  ${padded}${value}`;
}
