/**
 * WelcomeBanner — fixed top banner with mascot and version info.
 * Rendered above the message list, never scrolls.
 * Styled like Claude Code's pig banner: dim gray mascot + info beside it.
 */

import React from "react";
import { Box, Text } from "ink";

export interface WelcomeBannerProps {
  version: string;
}

export function WelcomeBanner({ version }: WelcomeBannerProps): React.JSX.Element {
  return (
    <Box flexDirection="row" marginBottom={1} flexShrink={0} paddingLeft={2}>
      {/* Fox mascot — dim gray */}
      <Box flexDirection="column" marginRight={3}>
        <Text dimColor>{"  /\\_/\\"}</Text>
        <Text dimColor>{" ( o.o )"}</Text>
        <Text dimColor>{"  > w <"}</Text>
        <Text dimColor>{" /|   |\\"}</Text>
        <Text dimColor>{"(_|   |_)"}</Text>
      </Box>

      {/* Info text beside mascot */}
      <Box flexDirection="column" justifyContent="center">
        <Text bold color="white">YUAN </Text>
        <Text dimColor>v{version}  Autonomous Coding Agent</Text>
        <Text dimColor> </Text>
        <Text dimColor>Type /help for commands</Text>
        <Text dimColor>yuaone.com</Text>
      </Box>
    </Box>
  );
}
