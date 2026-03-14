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
  inputTokens?: number;
  outputTokens?: number;
 updateAvailable?: {
    current: string;
    latest: string;
  } | null;
}

export function StatusBar({
  version,
  model,
  provider,
  tokensPerSec,
  isRunning,
  inputTokens = 0,
  outputTokens = 0,
  updateAvailable = null,
}: StatusBarProps): React.JSX.Element {
  const { columns, tier } = useTerminalSize();

  const left = `${TOKENS.brand.prefix} YUAN v${version}`;
  const status = isRunning ? "●" : "○";
  const tps = tokensPerSec != null ? `${tokensPerSec} tok/s` : "";
  const total = inputTokens + outputTokens;

  const meterWidth = 10;
  const filled = Math.min(meterWidth, Math.floor(total / 100));
  const meter =
    "█".repeat(filled) + "░".repeat(Math.max(0, meterWidth - filled));

  const tokenInfo =
    total > 0
      ? `▲${inputTokens} ▼${outputTokens} ${meter}`
      : "";
  const updateLabel = updateAvailable
    ? ` ↑ ${updateAvailable.current}→${updateAvailable.latest}`
    : "";

  const right =
    tier === "compact"
      ? `${status} ${model}${updateLabel}`
      : `${provider}/${model} ${tokenInfo} ${status} ${tps}${updateLabel}`;

  return (
    <Box width={columns} justifyContent="space-between">
      <Text dimColor>{left}</Text>
      <Text dimColor={!updateAvailable} color={updateAvailable ? "yellow" : undefined}>
        {right}
      </Text>
    </Box>
  );
}
