/**
 * useMouseScroll — stable mouse wheel scrolling for Ink TUI.
 *
 * Handles:
 * - X10 mouse protocol: ESC [ M + 3 bytes
 * - SGR mouse protocol: ESC [ < btn ; col ; row M/m
 *
 * Key fixes:
 * - Buffers partial mouse sequences across stdin chunks
 * - Prevents raw mouse escape codes from leaking into Ink/readline
 * - Avoids swallowing normal ESC / non-mouse input
 */

import { useEffect, useRef } from "react";

const MOUSE_ENABLE = "\x1b[?1000h\x1b[?1006h";
const MOUSE_DISABLE = "\x1b[?1006l\x1b[?1000l";

// X10 button byte values already include the +32 offset
const SCROLL_UP_BTN = 96; // 64 + 32
const SCROLL_DOWN_BTN = 97; // 65 + 32

type StdinEmit = typeof process.stdin.emit;

type ParsedMouseChunk = {
  clean: string;
  ups: number;
  downs: number;
  tail: string;
};

function isPotentialMouseTail(text: string): boolean {
  return (
    text === "\x1b[M" ||
    text === "\x1b[<" ||
    /^\x1b\[<\d*;?\d*;?\d*$/.test(text)
  );
}

function parseMouseChunk(input: string): ParsedMouseChunk {
  let clean = "";
  let ups = 0;
  let downs = 0;
  let i = 0;

  while (i < input.length) {
    // X10: ESC [ M + 3 bytes
    if (input.startsWith("\x1b[M", i)) {
      if (i + 6 > input.length) {
        break; // incomplete X10 packet
      }

      const btn = input.charCodeAt(i + 3);
      if (btn === SCROLL_UP_BTN) ups++;
      else if (btn === SCROLL_DOWN_BTN) downs++;

      i += 6;
      continue;
    }

    // SGR: ESC [ < btn ; col ; row M/m
    if (input.startsWith("\x1b[<", i)) {
      const rest = input.slice(i);
      const match = rest.match(/^\x1b\[<(\d+);(\d+);(\d+)([Mm])/);

      if (match) {
        const btn = Number.parseInt(match[1], 10);
        if (btn === 64) ups++;
        else if (btn === 65) downs++;

        i += match[0].length;
        continue;
      }

      if (isPotentialMouseTail(rest)) {
        break; // incomplete SGR packet
      }
    }

    // Strip orphaned SGR fragments: "[<digits;digits;digitsM/m" without ESC prefix
    // This happens when ESC is consumed by Ink/readline and only the tail arrives
    if (input[i] === "[" && i + 1 < input.length && input[i + 1] === "<") {
      const rest = input.slice(i);
      const orphanMatch = rest.match(/^\[<(\d+);(\d+);(\d+)([Mm])/);
      if (orphanMatch) {
        const btn = Number.parseInt(orphanMatch[1], 10);
        if (btn === 64) ups++;
        else if (btn === 65) downs++;
        i += orphanMatch[0].length;
        continue;
      }
      // Potential incomplete orphan — check if it looks like start of mouse seq
      if (/^\[<\d*;?\d*;?\d*$/.test(rest)) {
        break; // incomplete, save as tail
      }
    }

    clean += input[i];
    i++;
  }

  return {
    clean,
    ups,
    downs,
    tail: input.slice(i),
  };
}

export function useMouseScroll(
  onScrollUp: () => void,
  onScrollDown: () => void,
): void {
  const upRef = useRef(onScrollUp);
  const downRef = useRef(onScrollDown);

  upRef.current = onScrollUp;
  downRef.current = onScrollDown;

  useEffect(() => {
    const stdin = process.stdin as typeof process.stdin & {
      _yuanMousePatched?: boolean;
    };

    if (stdin._yuanMousePatched) return;
    stdin._yuanMousePatched = true;

    let pendingTail = "";

    const disableMouse = () => {
      try {
        process.stdout.write(MOUSE_DISABLE);
      } catch {
        // ignore
      }
    };

    process.stdout.write(MOUSE_ENABLE);

    const handleExit = () => disableMouse();
    const handleSigint = () => disableMouse();
    const handleSigterm = () => disableMouse();
    const handleCrash = () => disableMouse();

    process.once("exit", handleExit);
    process.once("SIGINT", handleSigint);
    process.once("SIGTERM", handleSigterm);
    process.once("uncaughtException", handleCrash);

    const originalEmit = process.stdin.emit.bind(process.stdin) as StdinEmit;

    stdin.emit = function patchedEmit(
      event: string | symbol,
      ...args: unknown[]
    ): boolean {
      if (event !== "data") {
        return (originalEmit as (...a: unknown[]) => boolean)(event, ...args);
      }

      const raw = args[0];
      const str =
        raw instanceof Buffer
          ? raw.toString("binary")
          : typeof raw === "string"
            ? raw
            : "";

      const hasMouseCandidate =
        pendingTail.length > 0 ||
        str.includes("\x1b[M") ||
        str.includes("\x1b[<");

      if (!hasMouseCandidate) {
        return (originalEmit as (...a: unknown[]) => boolean)(event, ...args);
      }

      const combined = pendingTail + str;
      const parsed = parseMouseChunk(combined);
      pendingTail = parsed.tail;

      for (let i = 0; i < parsed.ups; i++) upRef.current();
      for (let i = 0; i < parsed.downs; i++) downRef.current();

      // only mouse data / incomplete mouse prefix
      if (parsed.clean.length === 0) {
        return true;
      }

      const newData =
        raw instanceof Buffer
          ? Buffer.from(parsed.clean, "binary")
          : parsed.clean;

      return originalEmit(event, newData);
    } as StdinEmit;

    return () => {
      disableMouse();

      process.removeListener("exit", handleExit);
      process.removeListener("SIGINT", handleSigint);
      process.removeListener("SIGTERM", handleSigterm);
      process.removeListener("uncaughtException", handleCrash);

      stdin.emit = originalEmit;
      delete stdin._yuanMousePatched;
    };
  }, []);
}