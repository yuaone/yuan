/**
 * AgentIndicator — dynamic CLI agent status indicator
 */

import React, { useState, useEffect } from "react";
import { Text } from "ink";
import { TOKENS } from "../lib/tokens.js";
import type { AgentStatus } from "../types.js";

export interface AgentIndicatorProps {
  status: AgentStatus;
  toolName?: string | null;
}

const STATUS_LABEL: Record<AgentStatus, string> = {
  idle: "idle",
  thinking: "thinking",
  streaming: "writing",
  tool_running: "running tool",
  awaiting_approval: "awaiting approval",
  error: "error",
  completed: "done",
  interrupted: "interrupted",
};

export function AgentIndicator({
  status,
  toolName,
}: AgentIndicatorProps): React.JSX.Element {
  const { frames, interval } = TOKENS.dots;

  const [frame, setFrame] = useState(0);

  useEffect(() => {
    if (
      status === "thinking" ||
      status === "streaming" ||
      status === "tool_running"
    ) {
      const timer = setInterval(() => {
        setFrame((f) => (f + 1) % frames.length);
      }, interval);

      return () => clearInterval(timer);
    }
  }, [status, frames.length, interval]);

  const label =
    status === "tool_running" && toolName
      ? `tool: ${toolName}`
      : STATUS_LABEL[status];

  const spinner =
    status === "thinking" ||
    status === "streaming" ||
    status === "tool_running"
      ? ` ${frames[frame]}`
      : "";

  let color: "gray" | "green" | "red" | "yellow" = "gray";

  if (status === "completed") color = "green";
  if (status === "error") color = "red";
  if (status === "awaiting_approval") color = "yellow";

  return (
    <Text color={color} dimColor={status === "thinking"}>
      {label}
      {spinner}
    </Text>
  );
}