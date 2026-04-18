import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { Agent } from '../hooks/useFlightdeck';
import { formatTokenCount } from '../hooks/useFlightdeck';

interface Props {
  agents: Agent[];
  baseUrl: string;
  project: string;
  onClose: () => void;
}

function statusIndicator(status: string): { icon: string; color: string } {
  switch (status) {
    case 'busy': case 'active': return { icon: '◉', color: 'blue' };
    case 'idle': return { icon: '●', color: 'green' };
    case 'hibernated': return { icon: '◑', color: 'yellow' };
    case 'retired': case 'terminated': return { icon: '○', color: 'gray' };
    default: return { icon: '·', color: 'white' };
  }
}

function isActive(status: string): boolean {
  return !['retired', 'terminated'].includes(status);
}

export function AgentOverlay({ agents, baseUrl, project, onClose }: Props) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [actionMsg, setActionMsg] = useState('');

  const activeAgents = agents.filter(a => isActive(a.status));
  const retiredAgents = agents.filter(a => !isActive(a.status));
  const sorted = [...activeAgents, ...retiredAgents];

  const doAction = async (action: string) => {
    const agent = sorted[selectedIndex];
    if (!agent?.id) return;
    try {
      const res = await fetch(`${baseUrl}/api/projects/${project}/agents/${agent.id}/${action}`, { method: 'POST' });
      setActionMsg(res.ok ? `${action} ${agent.id.slice(0, 8)}: OK` : `Failed: ${res.status}`);
    } catch (e: any) {
      setActionMsg(`Error: ${e.message}`);
    }
    setTimeout(() => setActionMsg(''), 3000);
  };

  useInput((ch, key) => {
    if (key.escape) { onClose(); return; }
    if (ch === 'j' || key.downArrow) setSelectedIndex(prev => Math.min(prev + 1, sorted.length - 1));
    if (ch === 'k' || key.upArrow) setSelectedIndex(prev => Math.max(prev - 1, 0));
    if (ch === 'h') doAction('hibernate');
    if (ch === 'w') doAction('wake');
    if (ch === 'r') doAction('retire');
    if (ch === 'i') doAction('interrupt');
  });

  const activeCount = activeAgents.length;
  const retiredCount = retiredAgents.length;

  return (
    <Box flexDirection="column" width="100%" flexGrow={1}>
      <Box borderStyle="single" borderColor="cyan" paddingX={1} justifyContent="space-between">
        <Text bold color="cyan">Agents ({activeCount} active{retiredCount > 0 ? `, ${retiredCount} retired` : ''})</Text>
        <Text dimColor>[Esc] Back</Text>
      </Box>

      <Box flexDirection="column" flexGrow={1} paddingX={2} paddingY={1}>
        {sorted.length === 0 && <Text dimColor>No agents</Text>}
        {sorted.map((agent, i) => {
          const selected = i === selectedIndex;
          const { icon, color } = statusIndicator(agent.status);
          const retired = !isActive(agent.status);
          const id = (agent.id || '???').slice(0, 12);
          const tokenInfo = (agent as any).tokenUsage;

          return (
            <Box key={agent.id || i} flexDirection="column" marginBottom={1}>
              <Box gap={1}>
                <Text color={selected ? 'cyan' : undefined} bold={selected}>{selected ? '▸' : ' '}</Text>
                <Text color={color}>{icon}</Text>
                <Text bold={!retired} dimColor={retired}>{id}</Text>
                <Text dimColor={retired}>{(agent.role || '').padEnd(10)}</Text>
                <Text color={color} dimColor={retired}>{agent.status}</Text>
                {agent.currentTask && <Text color="yellow"> Task: "{agent.currentTask}"</Text>}
              </Box>
              <Box paddingLeft={4}>
                <Text dimColor>{agent.model || 'unknown model'}</Text>
                {tokenInfo && (
                  <Text dimColor>  Tokens: {formatTokenCount(tokenInfo.totalIn || 0)} in / {formatTokenCount(tokenInfo.totalOut || 0)} out</Text>
                )}
              </Box>
            </Box>
          );
        })}
      </Box>

      {actionMsg && (
        <Box paddingX={2}>
          <Text color="yellow">{actionMsg}</Text>
        </Box>
      )}

      <Box borderStyle="single" borderColor="gray" paddingX={1} justifyContent="center" gap={2}>
        <Text dimColor>j/k: navigate</Text>
        <Text dimColor>h: hibernate</Text>
        <Text dimColor>w: wake</Text>
        <Text dimColor>r: retire</Text>
        <Text dimColor>i: interrupt</Text>
        <Text dimColor>Esc: back</Text>
      </Box>
    </Box>
  );
}
