import React from "react";
import { Box, Text } from "ink";
import stringWidth from "string-width";
import { TOKENS } from "../lib/tokens.js";

/* ── Mini Fox Pixel Art (4 rows: ears + face) ── */

const FOX_PIXEL_PALETTE: Record<string, string | null> = {
  ".": null,
  "O": "#f97316",
  "D": "#c2410c",
  "W": "#f8fafc",
  "N": "#1c1917",
  "T": "#fcd34d",
};

const MINI_FOX_SPRITE = [
  "...DT....TD...",
  "..DOOOOOOOOD..",
  ".DOOWWNNWWOOD.",
  ".DOOWWWWWWOD.",
  "..DOOWWWWOD..",
  "...DOOOOOD...",
];

/** Total rows occupied by the compact banner (top border + 4 sprite rows + bottom border). */
export const COMPACT_BANNER_ROWS = MINI_FOX_SPRITE.length + 2;

function MiniPixelFox(): React.JSX.Element {
  return (
    <Box flexDirection="column">
      {MINI_FOX_SPRITE.map((row, rowIndex) => (
        <Box key={`mfox-row-${rowIndex}`}>
          {row.split("").map((cell, colIndex) => {
            const color = FOX_PIXEL_PALETTE[cell] ?? null;
            if (!color) {
              return (
                <Text key={`mfox-px-${rowIndex}-${colIndex}`}>{"  "}</Text>
              );
            }
            return (
              <Text key={`mfox-px-${rowIndex}-${colIndex}`} color={color}>
                {"██"}
              </Text>
            );
          })}
        </Box>
      ))}
    </Box>
  );
}

export interface CompactBannerProps {
  width: number;
  version: string;
  model: string;
  provider: string;
  cwd: string;
}

export function CompactBanner({
  width,
  version,
  model,
  provider,
  cwd,
}: CompactBannerProps): React.JSX.Element {
  /* M7 fix: narrow terminal fallback — avoid overflow on width < 60 */
  if (width < 60) {
    return (
      <Box flexDirection="row" flexShrink={0}>
        <Text color="#f97316" bold>YUAN</Text>
        <Text dimColor>{` v${version} · ${model}`}</Text>
      </Box>
    );
  }

  const borderColor = "#334155";
  const B = TOKENS.box;
  const title = `YUAN v${version}`;

  /* Top border with title */
  const topInner = width - 2; // minus corners
  const titleDecorated = `${B.horizontal}${B.horizontal} ${title} `;
  const titleWidth = stringWidth(titleDecorated);
  const topPadding = Math.max(0, topInner - titleWidth);

  return (
    <Box flexDirection="column" flexShrink={0}>
      {/* ── top border ── */}
      <Text color={borderColor}>
        {B.topLeft}
        {titleDecorated}
        {B.horizontal.repeat(topPadding)}
        {B.topRight}
      </Text>

      {/* ── content: mini fox left | separator | info right ── */}
      <Box flexDirection="row">
        {/* left border */}
        <Box flexDirection="column">
          {MINI_FOX_SPRITE.map((_, i) => (
            <Text key={`lb-${i}`} color={borderColor}>
              {B.vertical}
            </Text>
          ))}
        </Box>

        {/* mini fox */}
        <Box flexDirection="column" paddingLeft={1} flexGrow={0} flexShrink={0}>
          <MiniPixelFox />
        </Box>

        {/* vertical separator */}
        <Box flexDirection="column" paddingLeft={1} paddingRight={1}>
          {MINI_FOX_SPRITE.map((_, i) => (
            <Text key={`sep-${i}`} color={borderColor}>
              {B.vertical}
            </Text>
          ))}
        </Box>

        {/* info section */}
        <Box
          flexDirection="column"
          flexGrow={1}
          justifyContent="center"
          paddingRight={1}
        >
          <Box>
            <Text dimColor>model </Text>
            <Text color="white">{model}</Text>
          </Box>
          <Box>
            <Text dimColor>via   </Text>
            <Text dimColor>{provider}</Text>
          </Box>
          <Box>
            <Text dimColor>dir   </Text>
            <Text dimColor>{cwd}</Text>
          </Box>
          <Text dimColor>Type /help for commands</Text>
        </Box>

        {/* right border */}
        <Box flexDirection="column">
          {MINI_FOX_SPRITE.map((_, i) => (
            <Text key={`rb-${i}`} color={borderColor}>
              {B.vertical}
            </Text>
          ))}
        </Box>
      </Box>

      {/* ── bottom border ── */}
      <Text color={borderColor}>
        {B.bottomLeft}
        {B.horizontal.repeat(Math.max(0, width - 2))}
        {B.bottomRight}
      </Text>
    </Box>
  );
}
