import React from 'react';
import { Box, Text } from 'ink';
import type { StatusData, TaskCounts } from '../hooks/useFlightdeck';
import { formatTokenCount } from '../hooks/useFlightdeck';

interface Props {
  status: StatusData;
  counts: TaskCounts;
  agentCount: number;
}

export function StatusBar({ status, counts, agentCount }: Props) {
  const conn = status.connected;
  return (
    <Box borderStyle="single" borderColor={conn ? 'cyan' : 'red'} paddingX={1} justifyContent="space-between">
      <Box gap={1}>
        <Text bold color="cyan">⬡ Flightdeck</Text>
        <Text dimColor>│</Text>
        <Text bold>{status.project || '—'}</Text>
        {status.governance && <Text dimColor>({status.governance})</Text>}
      </Box>
      <Box gap={1}>
        <Text color="green">{counts.done}✓</Text>
        <Text color="blue">{counts.running}●</Text>
        <Text>{counts.ready}○</Text>
        {counts.blocked > 0 && <Text color="yellow">{counts.blocked}⊘</Text>}
        {counts.failed > 0 && <Text color="red">{counts.failed}✗</Text>}
        <Text dimColor>│</Text>
        <Text>{agentCount} agents</Text>
        <Text dimColor>│</Text>
        <Text color={conn ? 'green' : 'red'}>{conn ? '● connected' : '○ disconnected'}</Text>
        {status.tokenUsage && (
          <>
            <Text dimColor>│</Text>
            <Text dimColor>Tokens: {formatTokenCount(status.tokenUsage.totalIn)} in / {formatTokenCount(status.tokenUsage.totalOut)} out | {status.tokenUsage.requestCount} calls</Text>
          </>
        )}
      </Box>
    </Box>
  );
}
