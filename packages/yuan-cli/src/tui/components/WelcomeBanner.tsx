import React from "react";
import { Box, Text } from "ink";
import stringWidth from "string-width";
import { TOKENS } from "../lib/tokens.js";

const FOX_PIXEL_PALETTE: Record<string, string | null> = {
  ".": null,
  "O": "#f97316",
  "D": "#c2410c",
  "W": "#f8fafc",
  "N": "#1c1917",
  "T": "#fcd34d",
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

export const WELCOME_BANNER_ROWS = FOX_PIXEL_SPRITE.length + 3; // top border + sprite + bottom border + marginBottom

function PixelFoxSprite(): React.JSX.Element {
  return (
    <Box flexDirection="column">
      {FOX_PIXEL_SPRITE.map((row, rowIndex) => (
        <Box key={`fox-row-${rowIndex}`}>
          {row.split("").map((cell, colIndex) => {
            const color = FOX_PIXEL_PALETTE[cell] ?? null;
            if (!color) {
              return <Text key={`fox-px-${rowIndex}-${colIndex}`}>{"  "}</Text>;
            }
            return (
              <Text key={`fox-px-${rowIndex}-${colIndex}`} color={color}>
                {"██"}
              </Text>
            );
          })}
        </Box>
      ))}
    </Box>
  );
}

export interface WelcomeBannerProps {
  width: number;
  version: string;
  model: string;
  provider: string;
  cwd: string;
}

export function WelcomeBanner({
  width,
  version,
  model,
  provider,
  cwd,
}: WelcomeBannerProps): React.JSX.Element {
  const borderColor = "#334155";
  const B = TOKENS.box;
  const title = `YUAN v${version}`;

  return (
    <Box flexDirection="column" flexShrink={0} marginBottom={1}>
      <Text color={borderColor}>
        {B.topLeft}
        {B.horizontal.repeat(2)} {title} {B.horizontal.repeat(Math.max(0, width - stringWidth(title) - 6))}
        {B.topRight}
      </Text>

      <Box flexDirection="row">
        <Box flexDirection="column" paddingLeft={2} flexGrow={0}>
          <PixelFoxSprite />
        </Box>

        <Box flexDirection="column" paddingLeft={1} paddingRight={1}>
          {Array.from({ length: FOX_PIXEL_SPRITE.length }).map((_, i) => (
            <Text key={i} color={borderColor}>{B.vertical}</Text>
          ))}
        </Box>

        <Box flexDirection="column" flexGrow={1} paddingRight={2} justifyContent="center">
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

      <Text color={borderColor}>
        {B.bottomLeft}
        {B.horizontal.repeat(Math.max(0, width - 2))}
        {B.bottomRight}
      </Text>
    </Box>
  );
}