import React from 'react';
import { Box, Text } from 'ink';

interface SuggestionsDisplayProps {
  suggestions: Array<{ cmd: string; desc: string }>;
  activeIndex: number;
  maxVisible?: number;
}

export function SuggestionsDisplay({ suggestions, activeIndex, maxVisible = 6 }: SuggestionsDisplayProps) {
  if (suggestions.length === 0) return null;

  // Calculate scroll window
  let start = 0;
  if (suggestions.length > maxVisible) {
    start = Math.max(0, Math.min(activeIndex - Math.floor(maxVisible / 2), suggestions.length - maxVisible));
  }
  const visible = suggestions.slice(start, start + maxVisible);

  // Find max command width for alignment
  const maxCmd = Math.max(...visible.map(s => s.cmd.length));

  return (
    <Box flexDirection="column" borderStyle="single" borderColor="yellow" paddingX={1}>
      {visible.map((s, i) => {
        const realIdx = start + i;
        const isActive = realIdx === activeIndex;
        return (
          <Box key={s.cmd}>
            <Text color={isActive ? 'yellow' : 'white'} bold={isActive} inverse={isActive}>
              {isActive ? '▸ ' : '  '}{s.cmd.padEnd(maxCmd)}
            </Text>
            <Text dimColor> {s.desc}</Text>
          </Box>
        );
      })}
      {suggestions.length > maxVisible && (
        <Text dimColor>  ({suggestions.length} total)</Text>
      )}
    </Box>
  );
}
