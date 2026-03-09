/**
 * Hook: input history navigation with arrow keys.
 */

import { useState, useCallback } from "react";

const MAX_HISTORY = 100;

export interface InputHistoryHook {
  /** Current input value (may be from history) */
  current: string;
  /** Add an entry to history */
  push: (entry: string) => void;
  /** Navigate up (older) — returns new value or null if at top */
  up: (currentInput: string) => string | null;
  /** Navigate down (newer) — returns new value or null if at bottom */
  down: () => string | null;
  /** Reset navigation position to bottom */
  reset: () => void;
}

export function useInputHistory(): InputHistoryHook {
  const [history, setHistory] = useState<string[]>([]);
  const [index, setIndex] = useState(-1);
  const [savedInput, setSavedInput] = useState("");

  const push = useCallback((entry: string) => {
    if (!entry.trim()) return;
    setHistory((prev) => {
      const next = [...prev, entry];
      if (next.length > MAX_HISTORY) next.shift();
      return next;
    });
    setIndex(-1);
    setSavedInput("");
  }, []);

  const up = useCallback(
    (currentInput: string) => {
      if (history.length === 0) return null;
      const newIndex = index === -1 ? history.length - 1 : Math.max(0, index - 1);
      if (index === -1) setSavedInput(currentInput);
      setIndex(newIndex);
      return history[newIndex] ?? null;
    },
    [history, index],
  );

  const down = useCallback(() => {
    if (index === -1) return null;
    const newIndex = index + 1;
    if (newIndex >= history.length) {
      setIndex(-1);
      return savedInput;
    }
    setIndex(newIndex);
    return history[newIndex] ?? null;
  }, [history, index, savedInput]);

  const reset = useCallback(() => {
    setIndex(-1);
    setSavedInput("");
  }, []);

  const current = index >= 0 && index < history.length ? history[index] : "";

  return { current, push, up, down, reset };
}
