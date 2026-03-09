/**
 * Spinner — braille dot animation (gray, dim).
 */

import React, { useState, useEffect } from "react";
import { Text } from "ink";
import { TOKENS } from "../lib/tokens.js";

export interface SpinnerProps {
  label?: string;
}

export function Spinner({ label }: SpinnerProps): React.JSX.Element {
  const { frames, interval } = TOKENS.spinner;
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setFrame((f) => (f + 1) % frames.length);
    }, interval);
    return () => clearInterval(timer);
  }, [frames.length, interval]);

  return (
    <Text dimColor>
      {frames[frame]}{label ? ` ${label}` : ""}
    </Text>
  );
}
