/**
 * AppBar — fixed top banner for YUAN TUI.
 * Always rendered above MessageList, never scrolls.
 *
 * Layout:  ╭── YUAN v1.x.x ─────────────────────╮
 *          │  [pixel fox]  │  model / dir / help  │
 *          ╰──────────────────────────────────────╯
 */

import React from "react";
import { Box, Text } from "ink";
import stringWidth from "string-width";
import { TOKENS } from "../lib/tokens.js";

/** Height in terminal rows that AppBar occupies (fox 10 + 2 borders). */
export const APP_BAR_HEIGHT = 12;

// ─── Pixel Fox ───────────────────────────────────────────────────────────────

const FOX_PIXEL_PALETTE: Record<string, string | null> = {
  ".": null,
  "O": "#f97316",   // orange body
  "D": "#c2410c",   // dark orange (ears/outline)
  "W": "#f8fafc",   // white (face/chest)
  "N": "#1c1917",   // dark (eyes/nose)
  "T": "#fcd34d",   // tan/yellow (inner ear)
};

const FOX_PIXEL_SPRITE = [
  "....DOODD..DDOOD....",
  "...DOOOTD.DTOOD....",
  "...DOOOOOOOOOOOD...",
  "..DOOOOOOOOOOOOOD..",
  "..DOOWWWWWWWWWOOD..",
  "..DOOWNNOONNWOOD...",
  "..DOOWWWWWWWWWOOD..",
  "..DOOOWWNNWWWOOOD..",
  "...DOOOOOOOOOOOD...",
  "....DDDDDDDDDDDD...",
];

function PixelFoxSprite(): React.JSX.Element {
  return (
    <Box flexDirection="column">
      {FOX_PIXEL_SPRITE.map((row, ri) => (
        <Box key={`fox-row-${ri}`}>
          {row.split("").map((cell, ci) => {
            const color = FOX_PIXEL_PALETTE[cell] ?? null;
            return color ? (
              <Text key={`fox-px-${ri}-${ci}`} color={color}>{"██"}</Text>
            ) : (
              <Text key={`fox-px-${ri}-${ci}`}>{"  "}</Text>
            );
          })}
        </Box>
      ))}
    </Box>
  );
}

// ─── AppBar ──────────────────────────────────────────────────────────────────

export interface AppBarProps {
  version: string;
  model: string;
  provider: string;
  cwd: string;
  columns: number;
}

export function AppBar({ version, model, provider, cwd, columns }: AppBarProps): React.JSX.Element {
  const B = TOKENS.box;
  const borderColor = "#334155";
  const title = `YUAN v${version}`;
  const titleStr = ` ${title} `;
  const topPad = Math.max(0, columns - stringWidth(titleStr) - 4);

  return (
    <Box flexDirection="column" flexShrink={0}>
      {/* Top border */}
      <Text color={borderColor}>
        {B.topLeft}{B.horizontal.repeat(2)}{titleStr}{B.horizontal.repeat(topPad)}{B.topRight}
      </Text>

      {/* Content: fox | divider | info */}
      <Box flexDirection="row">
        {/* Pixel fox */}
        <Box flexDirection="column" paddingLeft={2} flexGrow={0}>
          <PixelFoxSprite />
        </Box>

        {/* Vertical divider */}
        <Box flexDirection="column" paddingLeft={1} paddingRight={1}>
          {FOX_PIXEL_SPRITE.map((_, i) => (
            <Text key={i} color={borderColor}>{B.vertical}</Text>
          ))}
        </Box>

        {/* Info column */}
        <Box flexDirection="column" flexGrow={1} paddingRight={2} justifyContent="center">
          <Box height={1} />
          <Box>
            <Text dimColor>model  </Text>
            <Text color="white">{model}</Text>
          </Box>
          <Box>
            <Text dimColor>via    </Text>
            <Text dimColor>{provider}</Text>
          </Box>
          <Box>
            <Text dimColor>dir    </Text>
            <Text dimColor>{cwd}</Text>
          </Box>
          <Box height={1} />
          <Text dimColor>Type /help for commands</Text>
          <Text dimColor>yuaone.com</Text>
        </Box>
      </Box>

      {/* Bottom border */}
      <Text color={borderColor}>
        {B.bottomLeft}{B.horizontal.repeat(Math.max(0, columns - 2))}{B.bottomRight}
      </Text>
    </Box>
  );
}
