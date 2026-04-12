import React from 'react';
import { Box, Text } from 'ink';
import type { ActivityItem } from '../hooks/useFlightdeck';

interface Props {
  items: ActivityItem[];
  focused: boolean;
  scrollOffset: number;
}

export function ActivityFeed({ items, focused, scrollOffset }: Props) {
  const maxVisible = 12;
  const end = items.length - scrollOffset;
  const start = Math.max(0, end - maxVisible);
  const visible = items.slice(start, end > 0 ? end : undefined);

  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor={focused ? 'cyan' : 'gray'}
      width="40%"
    >
      <Box paddingX={1}>
        <Text bold color={focused ? 'cyan' : 'white'}>Activity</Text>
        <Text dimColor> ({items.length})</Text>
      </Box>
      <Box flexDirection="column" flexGrow={1} paddingX={1}>
        {visible.length === 0 ? (
          <Text dimColor>Waiting for events…</Text>
        ) : (
          visible.map((item, i) => (
            <Box key={i}>
              <Text dimColor>{item.time} </Text>
              <Text color={item.color as any}>{item.icon} {item.text.slice(0, 70)}</Text>
            </Box>
          ))
        )}
      </Box>
      {items.length > maxVisible && (
        <Box paddingX={1}>
          <Text dimColor>↕ scroll with j/k</Text>
        </Box>
      )}
    </Box>
  );
}
