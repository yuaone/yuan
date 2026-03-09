/**
 * ThinkingDots — animated "·····" indicator, dim gray.
 */

import React, { useState, useEffect } from "react";
import { Text } from "ink";
import { TOKENS } from "../lib/tokens.js";

export interface ThinkingDotsProps {
  label?: string;
}

export function ThinkingDots({ label }: ThinkingDotsProps): React.JSX.Element {
  const { frames, interval } = TOKENS.dots;
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setFrame((f) => (f + 1) % frames.length);
    }, interval);
    return () => clearInterval(timer);
  }, [frames.length, interval]);

  return (
    <Text dimColor>
      {label ? `${label} ` : ""}{frames[frame]}
    </Text>
  );
}
