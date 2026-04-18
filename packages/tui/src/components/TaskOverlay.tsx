import React, { useState, useMemo } from 'react';
import { Box, Text, useInput } from 'ink';
import type { Task } from '../hooks/useFlightdeck';

interface Props {
  tasks: Task[];
  onClose: () => void;
}

type TaskGroup = 'running' | 'ready' | 'pending' | 'done';

function groupOf(status: string): TaskGroup {
  if (['running', 'claimed', 'in-progress'].includes(status)) return 'running';
  if (['ready'].includes(status)) return 'ready';
  if (['done', 'completed'].includes(status)) return 'done';
  return 'pending'; // pending, blocked, failed, etc.
}

const GROUP_ORDER: TaskGroup[] = ['running', 'ready', 'pending', 'done'];
const GROUP_LABELS: Record<TaskGroup, { label: string; icon: string; color: string }> = {
  running: { label: 'Running', icon: '▶', color: 'blue' },
  ready: { label: 'Ready', icon: '●', color: 'white' },
  pending: { label: 'Pending / Blocked', icon: '⏳', color: 'yellow' },
  done: { label: 'Done', icon: '✓', color: 'green' },
};

interface FlatItem {
  type: 'header' | 'task';
  group: TaskGroup;
  task?: Task;
  label?: string;
}

function timeAgo(ts: string | undefined): string {
  if (!ts) return '';
  const diff = Date.now() - new Date(ts).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

export function TaskOverlay({ tasks, onClose }: Props) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [collapsed, setCollapsed] = useState<Set<TaskGroup>>(new Set());
  const [expandedTask, setExpandedTask] = useState<string | null>(null);

  const grouped = useMemo(() => {
    const groups: Record<TaskGroup, Task[]> = { running: [], ready: [], pending: [], done: [] };
    for (const t of tasks) groups[groupOf(t.status)].push(t);
    return groups;
  }, [tasks]);

  const flatItems = useMemo(() => {
    const items: FlatItem[] = [];
    for (const g of GROUP_ORDER) {
      const count = grouped[g].length;
      if (count === 0) continue;
      items.push({ type: 'header', group: g, label: `${GROUP_LABELS[g].icon} ${GROUP_LABELS[g].label} (${count})` });
      if (!collapsed.has(g)) {
        for (const t of grouped[g]) {
          items.push({ type: 'task', group: g, task: t });
        }
      }
    }
    return items;
  }, [grouped, collapsed]);

  useInput((ch, key) => {
    if (key.escape) { onClose(); return; }
    if (ch === 'j' || key.downArrow) setSelectedIndex(prev => Math.min(prev + 1, flatItems.length - 1));
    if (ch === 'k' || key.upArrow) setSelectedIndex(prev => Math.max(prev - 1, 0));
    if (key.return) {
      const item = flatItems[selectedIndex];
      if (!item) return;
      if (item.type === 'header') {
        setCollapsed(prev => {
          const next = new Set(prev);
          next.has(item.group) ? next.delete(item.group) : next.add(item.group);
          return next;
        });
      } else if (item.task) {
        setExpandedTask(prev => prev === item.task!.id ? null : item.task!.id);
      }
    }
  });

  return (
    <Box flexDirection="column" width="100%" flexGrow={1}>
      <Box borderStyle="single" borderColor="cyan" paddingX={1} justifyContent="space-between">
        <Text bold color="cyan">Tasks ({tasks.length} total)</Text>
        <Text dimColor>[Esc] Back</Text>
      </Box>

      <Box flexDirection="column" flexGrow={1} paddingX={2} paddingY={1}>
        {flatItems.length === 0 && <Text dimColor>No tasks</Text>}
        {flatItems.map((item, i) => {
          const selected = i === selectedIndex;
          if (item.type === 'header') {
            const info = GROUP_LABELS[item.group];
            const isCollapsed = collapsed.has(item.group);
            return (
              <Box key={`h-${item.group}`} marginTop={i > 0 ? 1 : 0}>
                <Text color={selected ? 'cyan' : undefined} bold={selected}>{selected ? '▸' : ' '}</Text>
                <Text bold color={info.color}> {item.label} {isCollapsed ? '▸' : '▾'}</Text>
              </Box>
            );
          }

          const t = item.task!;
          const isDone = item.group === 'done';
          const expanded = expandedTask === t.id;

          return (
            <Box key={t.id} flexDirection="column">
              <Box gap={1}>
                <Text color={selected ? 'cyan' : undefined} bold={selected}>{selected ? '▸' : ' '}</Text>
                <Text dimColor={isDone}>{isDone ? '  ✓' : '  ○'} {t.title || t.id}</Text>
                {t.assignee && <Text color="blue">{t.assignee}</Text>}
                {isDone && <Text dimColor>{timeAgo((t as any).completedAt || (t as any).updatedAt)}</Text>}
                {t.priority && <Text color="yellow">[{t.priority}]</Text>}
              </Box>
              {expanded && t.description && (
                <Box paddingLeft={6} marginBottom={1}>
                  <Text dimColor wrap="wrap">{t.description}</Text>
                </Box>
              )}
            </Box>
          );
        })}
      </Box>

      <Box borderStyle="single" borderColor="gray" paddingX={1} justifyContent="center" gap={2}>
        <Text dimColor>j/k: navigate</Text>
        <Text dimColor>Enter: expand/collapse</Text>
        <Text dimColor>Esc: back</Text>
      </Box>
    </Box>
  );
}
