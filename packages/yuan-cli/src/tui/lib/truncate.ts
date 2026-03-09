/**
 * truncate — Unicode-aware string truncation.
 * Handles wide characters (CJK), ANSI escape sequences, and emoji.
 */

// Strip ANSI escape codes for width calculation
const ANSI_RE = /\x1b\[[0-9;]*m/g;

/** Get visible width of a string (strips ANSI, counts CJK as 2) */
export function visibleWidth(str: string): number {
  const stripped = str.replace(ANSI_RE, "");
  let width = 0;
  for (const char of stripped) {
    const code = char.codePointAt(0) ?? 0;
    // CJK Unified Ideographs, CJK Compatibility, Hangul, fullwidth
    if (
      (code >= 0x1100 && code <= 0x115F) ||  // Hangul Jamo
      (code >= 0x2E80 && code <= 0x303E) ||  // CJK Radicals
      (code >= 0x3040 && code <= 0x33BF) ||  // Japanese
      (code >= 0x3400 && code <= 0x4DBF) ||  // CJK Ext A
      (code >= 0x4E00 && code <= 0x9FFF) ||  // CJK Unified
      (code >= 0xAC00 && code <= 0xD7AF) ||  // Hangul Syllables
      (code >= 0xF900 && code <= 0xFAFF) ||  // CJK Compat
      (code >= 0xFE30 && code <= 0xFE6F) ||  // CJK Compat Forms
      (code >= 0xFF01 && code <= 0xFF60) ||  // Fullwidth
      (code >= 0x20000 && code <= 0x2FA1F)   // CJK Ext B-F
    ) {
      width += 2;
    } else {
      width += 1;
    }
  }
  return width;
}

/** Truncate string to maxWidth visible chars, appending suffix if truncated */
export function truncate(str: string, maxWidth: number, suffix = "…"): string {
  if (visibleWidth(str) <= maxWidth) return str;

  const suffixWidth = visibleWidth(suffix);
  const target = maxWidth - suffixWidth;
  if (target <= 0) return suffix.slice(0, maxWidth);

  const stripped = str.replace(ANSI_RE, "");
  let width = 0;
  let i = 0;

  for (const char of stripped) {
    const code = char.codePointAt(0) ?? 0;
    const charWidth =
      (code >= 0x1100 && code <= 0x115F) ||
      (code >= 0x2E80 && code <= 0x9FFF) ||
      (code >= 0xAC00 && code <= 0xD7AF) ||
      (code >= 0xF900 && code <= 0xFAFF) ||
      (code >= 0xFE30 && code <= 0xFE6F) ||
      (code >= 0xFF01 && code <= 0xFF60) ||
      (code >= 0x20000 && code <= 0x2FA1F)
        ? 2
        : 1;

    if (width + charWidth > target) break;
    width += charWidth;
    i += char.length;
  }

  return stripped.slice(0, i) + suffix;
}

/** Pad string to exact visible width */
export function padEnd(str: string, targetWidth: number, char = " "): string {
  const current = visibleWidth(str);
  if (current >= targetWidth) return str;
  return str + char.repeat(targetWidth - current);
}
