/**
 * useMouseScroll — enables X10 mouse wheel scrolling in the TUI.
 *
 * Problem: Ink's useInput doesn't handle mouse events, and enabling mouse
 * tracking causes raw escape sequences to leak into Ink's readline → garbage
 * text in InputBox.
 *
 * Solution: Enable X10 basic mouse protocol (scroll wheel only), then
 * monkey-patch process.stdin.emit to intercept and strip mouse sequences
 * before Ink's readline processes them. Scroll events are routed to callbacks.
 *
 * X10 protocol: \x1b[M <button> <col> <row>  (3 bytes after \x1b[M)
 * Scroll up   : button byte = 96 (64 + 32 offset)
 * Scroll down : button byte = 97 (65 + 32 offset)
 */

import { useEffect, useRef } from "react";

const MOUSE_ENABLE  = "\x1b[?1000h"; // X10 basic mouse tracking
const MOUSE_DISABLE = "\x1b[?1000l";

// Button codes after the 32-offset encoding
const SCROLL_UP_BTN   = 96; // button 64 + 32
const SCROLL_DOWN_BTN = 97; // button 65 + 32

// Matches a complete X10 mouse sequence: ESC [ M + 3 bytes
const MOUSE_PATTERN = /\x1b\[M[\s\S]{3}/g;

type StdinEmit = typeof process.stdin.emit;

export function useMouseScroll(
  onScrollUp: () => void,
  onScrollDown: () => void,
): void {
  // Keep callback refs stable so the effect only runs once
  const upRef   = useRef(onScrollUp);
  const downRef = useRef(onScrollDown);
  upRef.current   = onScrollUp;
  downRef.current = onScrollDown;

  useEffect(() => {
    // Guard: only patch once even in strict-mode double-invoke
    if ((process.stdin as { _yuanMousePatched?: boolean })._yuanMousePatched) {
      return;
    }
    (process.stdin as { _yuanMousePatched?: boolean })._yuanMousePatched = true;

    process.stdout.write(MOUSE_ENABLE);

    const originalEmit = process.stdin.emit.bind(process.stdin) as StdinEmit;

    (process.stdin as { emit: StdinEmit }).emit = function (
      event: string | symbol,
      ...args: unknown[]
    ): boolean {
      if (event === "data") {
        const raw = args[0];
        const str: string =
          raw instanceof Buffer
            ? raw.toString("binary")
            : typeof raw === "string"
            ? raw
            : "";

        if (str.includes("\x1b[M")) {
          let ups   = 0;
          let downs = 0;

          const stripped = str.replace(MOUSE_PATTERN, (match) => {
            // byte index 3 = button byte
            const btn = match.charCodeAt(3);
            if (btn === SCROLL_UP_BTN)   ups++;
            else if (btn === SCROLL_DOWN_BTN) downs++;
            return ""; // remove from stream
          });

          // Fire scroll callbacks
          for (let i = 0; i < ups;   i++) upRef.current();
          for (let i = 0; i < downs; i++) downRef.current();

          // Swallow event entirely if nothing left after stripping
          if (stripped.length === 0) return true;

          // Pass stripped data onward to Ink's readline
          const newData =
            raw instanceof Buffer
              ? Buffer.from(stripped, "binary")
              : stripped;
          return originalEmit(event as string, newData);
        }
      }

      // All other events pass through unchanged
      return (originalEmit as (...a: unknown[]) => boolean)(event, ...args);
    } as StdinEmit;

    return () => {
      process.stdout.write(MOUSE_DISABLE);
      (process.stdin as { emit: StdinEmit; _yuanMousePatched?: boolean }).emit = originalEmit;
      delete (process.stdin as { _yuanMousePatched?: boolean })._yuanMousePatched;
    };
  }, []); // run once — callbacks accessed via refs
}
