/**
 * CompactBar — shows context usage and compact countdown in bottom-right area.
 *
 * Appears when context usage > warnAt (default 80%).
 * Decays from warnAt% remaining → 0%, then auto-compact triggers.
 * Positioned as a right-aligned row below the InputBox.
 *
 * Layout (when showing):
 *   [spaces]          15% until compact ▓▓▓▓▓░░░░░
 *
 * Hidden when: idle, usage < warnAt, or approval/interrupt is showing.
 */

import React from "react";
import { Box, Text } from "ink";
import { useTerminalSize } from "../hooks/useTerminalSize.js";

export interface CompactBarProps {
  /** Context usage 0–1 (e.g. 0.85 = 85% used) */
  usagePct: number;
  /** Show bar starting at this usage level (default 0.80) */
  warnAt?: number;
  /** Whether compact is in progress */
  isCompacting?: boolean;
  /** Hide bar (e.g. during approval prompt) */
  hidden?: boolean;
}

/** 10-cell progress bar: filled = remaining context, empty = used */
function makeBar(remainingPct: number): string {
  const TOTAL = 10;
  const filled = Math.round(remainingPct * TOTAL);
  const empty = TOTAL - filled;
  return "▓".repeat(Math.max(0, filled)) + "░".repeat(Math.max(0, empty));
}

export function CompactBar({
  usagePct,
  warnAt = 0.80,
  isCompacting = false,
  hidden = false,
}: CompactBarProps): React.JSX.Element | null {
  const { columns } = useTerminalSize();

  if (hidden) return null;
  if (!isCompacting && usagePct < warnAt) return null;

  const remaining = Math.max(0, Math.round((1 - usagePct) * 100));
  const bar = makeBar(1 - usagePct);

  // Color based on urgency
  let color: string;
  let label: string;
  if (isCompacting) {
    color = "#60a5fa"; // blue
    label = `compacting... ${bar}`;
  } else if (remaining <= 5) {
    color = "#f87171"; // red
    label = `${remaining}% until compact ${bar}`;
  } else if (remaining <= 12) {
    color = "#fb923c"; // orange
    label = `${remaining}% until compact ${bar}`;
  } else {
    color = "#94a3b8"; // slate/dim
    label = `${remaining}% until compact ${bar}`;
  }

  // Right-align in terminal
  const padLen = Math.max(0, columns - label.length - 1);

  return (
    <Box width={columns}>
      <Text>{" ".repeat(padLen)}</Text>
      <Text color={color}>{label}</Text>
    </Box>
  );
}
