/**
 * Box drawing utilities for rounded-corner panels.
 */

import { TOKENS } from "./tokens.js";

const B = TOKENS.box;

/** Draw a horizontal line of given width */
export function hLine(width: number): string {
  return B.horizontal.repeat(Math.max(0, width));
}

/** Draw top border with optional title */
export function topBorder(width: number, title?: string): string {
  if (title) {
    const titleStr = ` ${title} `;
    const remaining = width - 2 - titleStr.length;
    if (remaining < 0) return B.topLeft + hLine(width - 2) + B.topRight;
    return B.topLeft + B.horizontal + titleStr + hLine(remaining - 1) + B.topRight;
  }
  return B.topLeft + hLine(width - 2) + B.topRight;
}

/** Draw bottom border */
export function bottomBorder(width: number): string {
  return B.bottomLeft + hLine(width - 2) + B.bottomRight;
}

/** Wrap a single line of content in box side borders, padded to width */
export function boxLine(content: string, width: number, contentWidth: number): string {
  const padding = Math.max(0, width - 2 - contentWidth);
  return B.vertical + content + " ".repeat(padding) + B.vertical;
}
