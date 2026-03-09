/**
 * useKeyHandler — global key dispatch for Ctrl+O expand, Ctrl+C exit.
 * Note: Esc interrupt is handled by InputBox to avoid double-firing.
 */

import { useCallback } from "react";
import { useInput } from "ink";

export interface KeyHandlerOptions {
  onInterrupt?: () => void;
  onToggleExpand?: () => void;
  onExit?: () => void;
  isRunning?: boolean;
}

export function useKeyHandler({
  onToggleExpand,
  onExit,
}: KeyHandlerOptions): void {
  useInput(
    useCallback(
      (input: string, key: { ctrl?: boolean }) => {
        // Ctrl+O → toggle expand/collapse
        if (key.ctrl && input === "o" && onToggleExpand) {
          onToggleExpand();
          return;
        }

        // Ctrl+C → clean exit
        if (key.ctrl && input === "c" && onExit) {
          onExit();
        }
      },
      [onToggleExpand, onExit],
    ),
  );
}
