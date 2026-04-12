import React from 'react';
import { Box, Text } from 'ink';
import type { Task } from '../hooks/useFlightdeck';
import { statusIcon } from '../hooks/useFlightdeck';

interface Props {
  tasks: Task[];
  selectedIndex: number;
  scrollOffset: number;
  focused: boolean;
  maxHeight: number;
}

export function TaskList({ tasks, selectedIndex, scrollOffset, focused, maxHeight }: Props) {
  const visibleCount = Math.max(maxHeight - 3, 5); // header + border overhead
  const start = scrollOffset;
  const visible = tasks.slice(start, start + visibleCount);

  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor={focused ? 'cyan' : 'gray'}
      width="30%"
      height="100%"
    >
      <Box paddingX={1}>
        <Text bold color={focused ? 'cyan' : 'white'}>Tasks</Text>
        <Text dimColor> ({tasks.length})</Text>
      </Box>
      {tasks.length === 0 ? (
        <Box paddingX={1}><Text dimColor>No tasks</Text></Box>
      ) : (
        visible.map((task, i) => {
          const realIndex = start + i;
          const selected = realIndex === selectedIndex;
          const { icon, color } = statusIcon(task.status);
          return (
            <Box key={task.id} paddingX={1}>
              <Text
                color={selected && focused ? 'black' : color as any}
                backgroundColor={selected && focused ? 'cyan' : undefined}
                bold={selected}
              >
                {selected && focused ? '▸' : ' '} {icon} {task.title?.slice(0, 30) || task.id.slice(0, 8)}
              </Text>
            </Box>
          );
        })
      )}
      {tasks.length > visibleCount && (
        <Box paddingX={1}>
          <Text dimColor>↕ {start + 1}-{Math.min(start + visibleCount, tasks.length)}/{tasks.length}</Text>
        </Box>
      )}
    </Box>
  );
}
