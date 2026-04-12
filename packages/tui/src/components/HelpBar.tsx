import React from 'react';
import { Box, Text } from 'ink';

interface Props {
  focusedPanel: string;
  centerTab: 'chat' | 'activity';
}

export function HelpBar({ focusedPanel, centerTab }: Props) {
  return (
    <Box paddingX={1} justifyContent="space-between">
      <Text dimColor>
        <Text bold>Tab</Text> panels  <Text bold>j/k</Text> scroll  <Text bold>Enter</Text> select  <Text bold>t</Text>asks <Text bold>c</Text>hat <Text bold>a</Text>gents  <Text bold>/</Text>cmd  <Text bold>q</Text>uit
      </Text>
      <Text dimColor>
        [{focusedPanel}] {centerTab === 'chat' ? 'Chat' : 'Activity'} (Ctrl+T toggle)
      </Text>
    </Box>
  );
}
