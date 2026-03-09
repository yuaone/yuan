/**
 * Hook: track terminal size and layout tier, update on resize.
 */

import { useState, useEffect } from "react";
import { getLayoutTier, type LayoutTier } from "../lib/tokens.js";

export interface TerminalSize {
  columns: number;
  rows: number;
  tier: LayoutTier;
}

export function useTerminalSize(): TerminalSize {
  const [size, setSize] = useState<TerminalSize>(() => ({
    columns: process.stdout.columns || 80,
    rows: process.stdout.rows || 24,
    tier: getLayoutTier(process.stdout.columns || 80),
  }));

  useEffect(() => {
    const onResize = () => {
      const columns = process.stdout.columns || 80;
      const rows = process.stdout.rows || 24;
      setSize({ columns, rows, tier: getLayoutTier(columns) });
    };

    process.stdout.on("resize", onResize);
    return () => {
      process.stdout.off("resize", onResize);
    };
  }, []);

  return size;
}
