import React from 'react';
import { Box, Text } from 'ink';
import type { Agent } from '../hooks/useFlightdeck';
import { agentStatusColor } from '../hooks/useFlightdeck';

interface Props {
  agents: Agent[];
  focused: boolean;
  selectedIndex: number;
}

export function AgentPanel({ agents, focused, selectedIndex }: Props) {
  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor={focused ? 'cyan' : 'gray'}
      width="30%"
    >
      <Box paddingX={1}>
        <Text bold color={focused ? 'cyan' : 'white'}>Agents</Text>
        <Text dimColor> ({agents.length})</Text>
      </Box>
      {agents.length === 0 ? (
        <Box paddingX={1}><Text dimColor>No agents</Text></Box>
      ) : (
        agents.map((agent, i) => {
          const selected = i === selectedIndex && focused;
          const color = agentStatusColor(agent.status);
          const statusDot = agent.status === 'active' || agent.status === 'busy' ? '●' : agent.status === 'idle' ? '◦' : '·';
          return (
            <Box key={agent.id || agent.role + i} paddingX={1} flexDirection="column">
              <Text
                color={selected ? 'black' : color as any}
                backgroundColor={selected ? 'cyan' : undefined}
                bold={selected}
              >
                {selected ? '▸' : ' '} {statusDot} {agent.role}
              </Text>
              {agent.model && (
                <Text dimColor>    {agent.model}</Text>
              )}
              {agent.currentTask && (
                <Text dimColor color="blue">    → {agent.currentTask.slice(0, 25)}</Text>
              )}
            </Box>
          );
        })
      )}
    </Box>
  );
}
