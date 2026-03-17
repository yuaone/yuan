import React, { memo } from "react";
import { Box } from "ink";
import type { AgentStreamState } from "../types.js";
import { Indicator } from "./FooterBar.js";

export interface StatusLineProps {
  agentState: AgentStreamState;
}

export const StatusLine = memo(function StatusLine({
  agentState,
}: StatusLineProps): React.JSX.Element {
  return (
    <Box height={1} flexShrink={0}>
      <Indicator agentState={agentState} />
    </Box>
  );
});