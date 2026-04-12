import React, { useState, useEffect, useCallback, useRef } from 'react';
import { render, Box, Text, useInput, useApp } from 'ink';
import TextInput from 'ink-text-input';
import WebSocket from 'ws';
import { parseArgs } from 'node:util';

// ── Types ──────────────────────────────────────────────────────

import type { DisplayConfig, DisplayPreset, ToolVisibility, ContentType } from '@flightdeck-ai/shared/display';
import { DEFAULT_DISPLAY, DISPLAY_PRESETS, DISPLAY_PRESET_NAMES, shouldShow, isFlightdeckTool } from '@flightdeck-ai/shared/display';

interface StatusData {
  project?: string;
  profile?: string;
  port?: number;
  connected?: boolean;
}

interface TaskCounts {
  done: number;
  running: number;
  ready: number;
  blocked: number;
  failed: number;
  total: number;
}

interface ActivityItem {
  time: string;
  icon: string;
  text: string;
  color: string;
}

interface ChatMessage {
  sender: string;
  text: string;
  time: string;
}

interface Task {
  id: string;
  title: string;
  status: string;
}

interface Agent {
  role: string;
  model?: string;
  status: string;
}

// ── Helpers ────────────────────────────────────────────────────

function timestamp(): string {
  return new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' });
}

function statusIcon(status: string): { icon: string; color: string } {
  switch (status) {
    case 'done': case 'completed': return { icon: '✅', color: 'green' };
    case 'running': case 'claimed': case 'in-progress': return { icon: '🔄', color: 'blue' };
    case 'ready': case 'pending': return { icon: '📋', color: 'white' };
    case 'blocked': return { icon: '⚠️', color: 'yellow' };
    case 'failed': return { icon: '❌', color: 'red' };
    default: return { icon: '•', color: 'white' };
  }
}

// ── WebSocket + HTTP Client ────────────────────────────────────

function useFlightdeckClient(baseUrl: string, wsUrl: string) {
  const [status, setStatus] = useState<StatusData>({ connected: false });
  const [taskCounts, setTaskCounts] = useState<TaskCounts>({ done: 0, running: 0, ready: 0, blocked: 0, failed: 0, total: 0 });
  const [activities, setActivities] = useState<ActivityItem[]>([]);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [displayConfig, setDisplayConfig] = useState<DisplayConfig>({ ...DEFAULT_DISPLAY });
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout>>();

  const addActivity = useCallback((item: ActivityItem) => {
    setActivities(prev => [...prev.slice(-100), item]);
  }, []);

  const countTasks = useCallback((tasks: Task[]) => {
    const counts: TaskCounts = { done: 0, running: 0, ready: 0, blocked: 0, failed: 0, total: tasks.length };
    for (const t of tasks) {
      if (t.status === 'done' || t.status === 'completed') counts.done++;
      else if (t.status === 'running' || t.status === 'claimed' || t.status === 'in-progress') counts.running++;
      else if (t.status === 'ready' || t.status === 'pending') counts.ready++;
      else if (t.status === 'blocked') counts.blocked++;
      else if (t.status === 'failed') counts.failed++;
    }
    return counts;
  }, []);

  const fetchInitial = useCallback(async () => {
    try {
      const [statusRes, tasksRes, messagesRes] = await Promise.all([
        fetch(`${baseUrl}/api/status`).then(r => r.json()).catch(() => ({})),
        fetch(`${baseUrl}/api/tasks`).then(r => r.json()).catch(() => []),
        fetch(`${baseUrl}/api/messages`).then(r => r.json()).catch(() => []),
      ]);
      setStatus({ ...statusRes, connected: true });
      if (Array.isArray(tasksRes)) setTaskCounts(countTasks(tasksRes));
      if (Array.isArray(messagesRes)) {
        setChatMessages(messagesRes.slice(-50).map((m: any) => ({
          sender: m.role || m.sender || 'system',
          text: m.content || m.text || '',
          time: m.timestamp ? new Date(m.timestamp).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' }) : timestamp(),
        })));
      }
    } catch { /* will retry on reconnect */ }
  }, [baseUrl, countTasks]);

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.on('open', () => {
      setStatus(prev => ({ ...prev, connected: true }));
      fetchInitial();
      addActivity({ time: timestamp(), icon: '🟢', text: 'Connected to daemon', color: 'green' });
    });

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        switch (msg.type) {
          case 'task:update':
          case 'task:created':
          case 'task:status': {
            const { icon, color } = statusIcon(msg.data?.status || '');
            addActivity({ time: timestamp(), icon, text: `${msg.data?.id?.slice(0, 8) || 'task'} "${msg.data?.title || ''}" ${msg.data?.status || ''}`, color });
            if (msg.data?.tasks) setTaskCounts(countTasks(msg.data.tasks));
            break;
          }
          case 'chat:message':
          case 'message': {
            const cm: ChatMessage = {
              sender: msg.data?.role || msg.data?.sender || 'lead',
              text: msg.data?.content || msg.data?.text || '',
              time: timestamp(),
            };
            setChatMessages(prev => [...prev.slice(-100), cm]);
            if (cm.sender !== 'user') {
              addActivity({ time: timestamp(), icon: '💬', text: `${cm.sender}: "${cm.text.slice(0, 60)}"`, color: 'cyan' });
            }
            break;
          }
          case 'status:update':
            setStatus(prev => ({ ...prev, ...msg.data }));
            break;
          case 'tasks:update':
            if (Array.isArray(msg.data)) setTaskCounts(countTasks(msg.data));
            break;
          case 'display:config': {
            if (msg.config) setDisplayConfig(prev => ({ ...prev, ...msg.config }));
            break;
          }
          case 'chat:stream': {
            const ct = msg.content_type || 'text';
            if (shouldShow(displayConfig, ct as ContentType, msg.tool_name)) {
              // Append streaming delta to chat as ephemeral activity
              addActivity({ time: timestamp(), icon: '✏️', text: `streaming: ${(msg.delta || '').slice(0, 80)}`, color: 'gray' });
            }
            break;
          }
          default:
            if (msg.type) {
              addActivity({ time: timestamp(), icon: '📡', text: `${msg.type}: ${JSON.stringify(msg.data || {}).slice(0, 80)}`, color: 'gray' });
            }
        }
      } catch { /* ignore non-JSON */ }
    });

    ws.on('close', () => {
      setStatus(prev => ({ ...prev, connected: false }));
      addActivity({ time: timestamp(), icon: '🔴', text: 'Disconnected — reconnecting...', color: 'red' });
      reconnectTimer.current = setTimeout(connect, 3000);
    });

    ws.on('error', () => {
      ws.close();
    });
  }, [wsUrl, fetchInitial, addActivity, countTasks]);

  const sendMessage = useCallback((text: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'chat:send', data: { content: text } }));
      setChatMessages(prev => [...prev.slice(-100), { sender: 'user', text, time: timestamp() }]);
    }
  }, []);

  const sendDisplayUpdate = useCallback((config: Partial<DisplayConfig>) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'display:config', config }));
    }
    setDisplayConfig(prev => ({ ...prev, ...config }));
  }, []);

  const applyPreset = useCallback((preset: DisplayPreset) => {
    sendDisplayUpdate({ ...DISPLAY_PRESETS[preset] });
  }, [sendDisplayUpdate]);

  const fetchJson = useCallback(async (path: string) => {
    try {
      return await fetch(`${baseUrl}${path}`).then(r => r.json());
    } catch { return null; }
  }, [baseUrl]);

  useEffect(() => {
    connect();
    return () => {
      clearTimeout(reconnectTimer.current);
      wsRef.current?.close();
    };
  }, [connect]);

  return { status, taskCounts, activities, chatMessages, sendMessage, fetchJson, displayConfig, sendDisplayUpdate, applyPreset };
}

// ── Components ─────────────────────────────────────────────────

function Header({ status }: { status: StatusData }) {
  const connColor = status.connected ? 'green' : 'red';
  const connText = status.connected ? '● connected' : '○ disconnected';
  return (
    <Box borderStyle="single" borderBottom={false} paddingX={1} justifyContent="space-between">
      <Text bold color="cyan">Flightdeck</Text>
      <Text>Project: <Text bold>{status.project || '—'}</Text></Text>
      <Text>Profile: <Text bold>{status.profile || '—'}</Text></Text>
      <Text>Port: <Text bold>{status.port || '—'}</Text></Text>
      <Text color={connColor}>{connText}</Text>
    </Box>
  );
}

function TaskSummary({ counts }: { counts: TaskCounts }) {
  return (
    <Box paddingX={2} marginY={0}>
      <Text>Tasks: </Text>
      <Text color="green" bold>{counts.done} done</Text>
      <Text> │ </Text>
      <Text color="blue" bold>{counts.running} running</Text>
      <Text> │ </Text>
      <Text bold>{counts.ready} ready</Text>
      <Text> │ </Text>
      <Text color="yellow" bold>{counts.blocked} blocked</Text>
      {counts.failed > 0 && <><Text> │ </Text><Text color="red" bold>{counts.failed} failed</Text></>}
    </Box>
  );
}

function ActivityFeed({ items, scrollOffset }: { items: ActivityItem[]; scrollOffset: number }) {
  const visible = items.slice(-(15 + scrollOffset), items.length - scrollOffset || undefined).slice(-15);
  return (
    <Box flexDirection="column" paddingX={2}>
      <Text bold dimColor>─── Recent Activity ───</Text>
      {visible.length === 0 && <Text dimColor>  No activity yet. Waiting for events...</Text>}
      {visible.map((item, i) => (
        <Text key={i} color={item.color as any}>
          <Text dimColor>[{item.time}]</Text> {item.icon} {item.text}
        </Text>
      ))}
    </Box>
  );
}

function ChatView({ messages }: { messages: ChatMessage[] }) {
  const visible = messages.slice(-10);
  return (
    <Box flexDirection="column" paddingX={2}>
      <Text bold dimColor>─── Chat with Lead ───</Text>
      {visible.length === 0 && <Text dimColor>  No messages yet. Type below to chat with Lead.</Text>}
      {visible.map((msg, i) => (
        <Text key={i}>
          <Text dimColor>[{msg.time}]</Text>{' '}
          <Text color={msg.sender === 'user' ? 'white' : 'cyan'} bold>[{msg.sender}]</Text>{' '}
          {msg.text}
        </Text>
      ))}
    </Box>
  );
}

function CommandOutput({ lines }: { lines: string[] }) {
  if (lines.length === 0) return null;
  return (
    <Box flexDirection="column" paddingX={2}>
      <Text bold dimColor>─── Command Output ───</Text>
      {lines.map((line, i) => <Text key={i}>{line}</Text>)}
    </Box>
  );
}

// ── Main App ───────────────────────────────────────────────────

function App({ baseUrl, wsUrl }: { baseUrl: string; wsUrl: string }) {
  const { status, taskCounts, activities, chatMessages, sendMessage, fetchJson, displayConfig, sendDisplayUpdate, applyPreset } = useFlightdeckClient(baseUrl, wsUrl);
  const [input, setInput] = useState('');
  const [scrollOffset, setScrollOffset] = useState(0);
  const [cmdOutput, setCmdOutput] = useState<string[]>([]);
  const { exit } = useApp();

  useInput((_input, key) => {
    if (key.upArrow) setScrollOffset(prev => Math.min(prev + 1, activities.length - 1));
    if (key.downArrow) setScrollOffset(prev => Math.max(prev - 1, 0));
  });

  const handleSubmit = useCallback(async (text: string) => {
    setInput('');
    setCmdOutput([]);
    if (!text.trim()) return;

    if (text.startsWith('/')) {
      const [cmd, ...args] = text.trim().split(/\s+/);
      switch (cmd) {
        case '/quit':
          exit();
          return;
        case '/help':
          setCmdOutput([
            'Commands:',
            '  /tasks    — List all tasks',
            '  /agents   — List active agents',
            '  /report   — Show daily report',
            '  /models   — Show model config',
            '  /status   — Detailed project status',
            '  /display  — Show display config',
            '  /display <preset>        — Apply preset (minimal|summary|detail|debug)',
            '  /display thinking on|off — Toggle thinking',
            '  /display tools <level>   — Set tool visibility (off|summary|detail)',
            '  /help     — This help message',
            '  /quit     — Exit (or Ctrl+C)',
          ]);
          return;
        case '/tasks': {
          const tasks = await fetchJson('/api/tasks');
          if (!tasks || !Array.isArray(tasks)) { setCmdOutput(['Failed to fetch tasks']); return; }
          setCmdOutput(tasks.length === 0 ? ['No tasks'] : tasks.map((t: Task) => {
            const { icon } = statusIcon(t.status);
            return `  ${icon} ${t.id?.slice(0, 8) || '?'} "${t.title}" — ${t.status}`;
          }));
          return;
        }
        case '/agents': {
          const agents = await fetchJson('/api/agents');
          if (!agents || !Array.isArray(agents)) { setCmdOutput(['Failed to fetch agents']); return; }
          setCmdOutput(agents.length === 0 ? ['No agents'] : agents.map((a: Agent) =>
            `  ${a.status === 'active' ? '🟢' : '⚪'} ${a.role} — ${a.model || '?'} (${a.status})`
          ));
          return;
        }
        case '/report': {
          const report = await fetchJson('/api/report');
          if (!report) { setCmdOutput(['Failed to fetch report']); return; }
          setCmdOutput([typeof report === 'string' ? report : JSON.stringify(report, null, 2)]);
          return;
        }
        case '/models': {
          const models = await fetchJson('/api/models');
          if (!models) { setCmdOutput(['Failed to fetch models']); return; }
          setCmdOutput(typeof models === 'object' && !Array.isArray(models)
            ? Object.entries(models).map(([k, v]) => `  ${k}: ${v}`)
            : [JSON.stringify(models, null, 2)]);
          return;
        }
        case '/status': {
          const s = await fetchJson('/api/status');
          if (!s) { setCmdOutput(['Failed to fetch status']); return; }
          setCmdOutput(Object.entries(s).map(([k, v]) => `  ${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`));
          return;
        }
        case '/display': {
          if (args.length === 0) {
            setCmdOutput([
              'Display Configuration:',
              `  thinking:        ${displayConfig.thinking ? 'on' : 'off'}`,
              `  toolCalls:       ${displayConfig.toolCalls}`,
              `  flightdeckTools: ${displayConfig.flightdeckTools}`,
              '',
              `Presets: ${DISPLAY_PRESET_NAMES.join(' | ')}`,
            ]);
            return;
          }
          const sub = args[0];
          if (DISPLAY_PRESET_NAMES.includes(sub as any)) {
            applyPreset(sub as DisplayPreset);
            setCmdOutput([`Applied display preset: ${sub}`]);
            return;
          }
          if (sub === 'thinking') {
            if (!args[1]) {
              setCmdOutput(['Usage: /display thinking on|off']);
              return;
            }
            const val = args[1] === 'on' || args[1] === 'true';
            sendDisplayUpdate({ thinking: val });
            setCmdOutput([`Thinking: ${val ? 'on' : 'off'}`]);
            return;
          }
          if (sub === 'tools') {
            const level = args[1] as ToolVisibility;
            if (['off', 'summary', 'detail'].includes(level)) {
              sendDisplayUpdate({ toolCalls: level });
              setCmdOutput([`Tool calls: ${level}`]);
            } else {
              setCmdOutput(['Usage: /display tools <off|summary|detail>']);
            }
            return;
          }
          if (sub === 'flightdeck-tools') {
            const level = args[1] as ToolVisibility;
            if (['off', 'summary', 'detail'].includes(level)) {
              sendDisplayUpdate({ flightdeckTools: level });
              setCmdOutput([`Flightdeck tools: ${level}`]);
            } else {
              setCmdOutput(['Usage: /display flightdeck-tools <off|summary|detail>']);
            }
            return;
          }
          setCmdOutput(['Usage: /display [preset|thinking|tools|flightdeck-tools] [value]']);
          return;
        }
        default:
          setCmdOutput([`Unknown command: ${cmd}. Type /help for available commands.`]);
          return;
      }
    }

    sendMessage(text);
  }, [exit, fetchJson, sendMessage, activities.length]);

  return (
    <Box flexDirection="column" width="100%">
      <Header status={status} />
      <TaskSummary counts={taskCounts} />
      <ActivityFeed items={activities} scrollOffset={scrollOffset} />
      <ChatView messages={chatMessages} />
      <CommandOutput lines={cmdOutput} />
      <Box borderStyle="single" borderTop={true} paddingX={1}>
        <Text color="cyan">&gt; </Text>
        <TextInput value={input} onChange={setInput} onSubmit={handleSubmit} placeholder="Type a message to Lead... │ /help /tasks /agents /report" />
      </Box>
    </Box>
  );
}

// ── CLI Entry ──────────────────────────────────────────────────

const { values } = parseArgs({
  strict: false,
  options: {
    port: { type: 'string', default: '3000' },
    url: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
});

if (values.help) {
  console.log(`
Flightdeck TUI — Terminal interface for Flightdeck daemon

Usage:
  flightdeck tui [options]
  flightdeck-tui [options]

Options:
  --port <port>   Port to connect to (default: 3000)
  --url <ws-url>  Full WebSocket URL (e.g. ws://remote:3000)
  -h, --help      Show help
`);
  process.exit(0);
}

const port = values.port || '3000';
const wsUrl = (values.url as string) || `ws://localhost:${port}`;
const baseUrl = (values.url as string) ? (values.url as string).replace(/^ws(s?):/, 'http$1:') : `http://localhost:${port}`;

render(<App baseUrl={baseUrl} wsUrl={wsUrl} />);
