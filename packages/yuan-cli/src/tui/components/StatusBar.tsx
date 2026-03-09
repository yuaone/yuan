/**
 * StatusBar — top bar showing version, model, tokens/s, status.
 */

import React from "react";
import { Box, Text } from "ink";
import { useTerminalSize } from "../hooks/useTerminalSize.js";
import { TOKENS } from "../lib/tokens.js";

export interface StatusBarProps {
  version: string;
  model: string;
  provider: string;
  tokensPerSec?: number;
  isRunning?: boolean;
}

export function StatusBar({
  version,
  model,
  provider,
  tokensPerSec,
  isRunning,
}: StatusBarProps): React.JSX.Element {
  const { columns, tier } = useTerminalSize();

  const left = `${TOKENS.brand.prefix} YUAN v${version}`;
  const status = isRunning ? "●" : "○";
  const tps = tokensPerSec != null ? `${tokensPerSec} tok/s` : "";

  const right =
    tier === "compact"
      ? `${status} ${model}`
      : `${provider}/${model} ${status} ${tps}`;

  return (
    <Box width={columns} justifyContent="space-between">
      <Text dimColor>{left}</Text>
      <Text dimColor>{right}</Text>
    </Box>
  );
}
