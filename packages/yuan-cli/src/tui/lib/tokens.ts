/**
 * YUAN TUI Design Tokens
 * Monochrome gray + white palette. Professional, quiet, fast.
 */

export const TOKENS = {
  brand: {
    prefix: "●",
    name: "yuan",
    prompt: ">",
    userPrefix: "●",
  },

  color: {
    primary: "white",
    secondary: "gray",
    accent: "white",
    success: "green",
    error: "red",
    warning: "yellow",
    diffAdd: "green",
    diffDel: "red",
    muted: "dim",
  },

  spinner: {
    frames: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as readonly string[],
    interval: 80,
    style: "dim" as const,
  },

  dots: {
    frames: ["·", "··", "···", "····", "·····"] as readonly string[],
    interval: 150,
    style: "dim" as const,
  },

  box: {
    topLeft: "╭",
    topRight: "╮",
    bottomLeft: "╰",
    bottomRight: "╯",
    horizontal: "─",
    vertical: "│",
    style: "dim" as const,
  },

  tree: {
    branch: "├─",
    last: "└─",
    pipe: "│ ",
    style: "dim" as const,
  },

  layout: {
    compact: 80,
    normal: 120,
    padding: 2,
  },
} as const;

export type LayoutTier = "compact" | "normal" | "wide";

export function getLayoutTier(columns: number): LayoutTier {
  if (columns < TOKENS.layout.compact) return "compact";
  if (columns < TOKENS.layout.normal) return "normal";
  return "wide";
}
