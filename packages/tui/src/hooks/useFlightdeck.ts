import { useState, useEffect, useCallback, useRef } from 'react';
import WebSocket from 'ws';
import type { DisplayConfig, DisplayPreset, ToolVisibility, ContentType } from '@flightdeck-ai/shared/display';
import { DEFAULT_DISPLAY, DISPLAY_PRESETS, shouldShow } from '@flightdeck-ai/shared/display';

// ── Types ──────────────────────────────────────────────────────

export interface TokenUsage {
  totalIn: number;
  totalOut: number;
  requestCount: number;
}

export interface StatusData {
  project?: string;
  profile?: string;
  port?: number;
  connected?: boolean;
  governance?: string;
  tokenUsage?: TokenUsage;
}

export interface TaskCounts {
  done: number;
  running: number;
  ready: number;
  blocked: number;
  failed: number;
  total: number;
}

export interface ActivityItem {
  time: string;
  icon: string;
  text: string;
  color: string;
}

export interface ChatMessage {
  sender: string;
  text: string;
  time: string;
}

export interface Task {
  id: string;
  title: string;
  status: string;
  assignee?: string;
  description?: string;
  priority?: string;
}

export interface Agent {
  id?: string;
  role: string;
  model?: string;
  status: string;
  currentTask?: string;
}

// ── Helpers ────────────────────────────────────────────────────

export function timestamp(): string {
  return new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' });
}

export function statusIcon(status: string): { icon: string; color: string } {
  switch (status) {
    case 'done': case 'completed': return { icon: '✓', color: 'green' };
    case 'running': case 'claimed': case 'in-progress': return { icon: '●', color: 'blue' };
    case 'ready': case 'pending': return { icon: '○', color: 'white' };
    case 'in_review': case 'review': return { icon: '◐', color: 'yellow' };
    case 'blocked': return { icon: '⊘', color: 'yellow' };
    case 'failed': return { icon: '✗', color: 'red' };
    default: return { icon: '·', color: 'white' };
  }
}

export function agentStatusColor(status: string): string {
  switch (status) {
    case 'active': case 'busy': return 'blue';
    case 'idle': return 'green';
    case 'offline': return 'gray';
    default: return 'white';
  }
}

// ── Hook ───────────────────────────────────────────────────────

export function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}

export function useFlightdeck(initialBaseUrl: string, initialWsUrl: string) {
  const [baseUrl, setBaseUrl] = useState(initialBaseUrl);
  const [wsUrl, setWsUrl] = useState(initialWsUrl);
  const [project, setProject] = useState<string>(() => {
    // Parse project name from URL: /api/projects/{name}/...
    const m = initialBaseUrl.match(/\/api\/projects\/([^/]+)/);
    return m ? m[1] : '';
  });
  const [status, setStatus] = useState<StatusData>({ connected: false });
  const [taskCounts, setTaskCounts] = useState<TaskCounts>({ done: 0, running: 0, ready: 0, blocked: 0, failed: 0, total: 0 });
  const [tasks, setTasks] = useState<Task[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [activities, setActivities] = useState<ActivityItem[]>([]);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [isLeadTyping, setIsLeadTyping] = useState(false);
  const [streamingText, setStreamingText] = useState('');
  const [displayConfig, setDisplayConfig] = useState<DisplayConfig>({ ...DEFAULT_DISPLAY });
  const [newMessageFlag, setNewMessageFlag] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout>>();
  const disconnectTimer = useRef<ReturnType<typeof setTimeout>>();
  const reconnectDelay = useRef(1000);
  const connectingRef = useRef(false);

  const addActivity = useCallback((item: ActivityItem) => {
    setActivities(prev => [...prev.slice(-200), item]);
  }, []);

  const countTasks = useCallback((taskList: Task[]) => {
    const counts: TaskCounts = { done: 0, running: 0, ready: 0, blocked: 0, failed: 0, total: taskList.length };
    for (const t of taskList) {
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
      const [statusRes, tasksRes, agentsRes, messagesRes] = await Promise.all([
        fetch(`${baseUrl}/api/status`).then(r => r.json()).catch(() => ({})),
        fetch(`${baseUrl}/api/tasks`).then(r => r.json()).catch(() => []),
        fetch(`${baseUrl}/api/agents`).then(r => r.json()).catch(() => []),
        fetch(`${baseUrl}/api/messages`).then(r => r.json()).catch(() => []),
      ]);
      setStatus({ ...statusRes, connected: true });
      if (Array.isArray(tasksRes)) {
        setTasks(tasksRes);
        setTaskCounts(countTasks(tasksRes));
      }
      if (Array.isArray(agentsRes)) setAgents(agentsRes);
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
    if (wsRef.current?.readyState === WebSocket.OPEN || connectingRef.current) return;
    connectingRef.current = true;
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.on('open', () => {
      connectingRef.current = false;
      reconnectDelay.current = 1000;
      clearTimeout(disconnectTimer.current);
      setStatus(prev => ({ ...prev, connected: true }));
      fetchInitial();
      addActivity({ time: timestamp(), icon: '▸', text: 'Connected to daemon', color: 'green' });
    });

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        switch (msg.type) {
          case 'task:update':
          case 'task:created':
          case 'task:status': {
            const { icon, color } = statusIcon(msg.data?.status || '');
            addActivity({ time: timestamp(), icon, text: `${msg.data?.id?.slice(0, 8) || 'task'} "${msg.data?.title || ''}" → ${msg.data?.status || ''}`, color });
            // Re-fetch tasks for full state
            fetch(`${baseUrl}/api/tasks`).then(r => r.json()).then(t => {
              if (Array.isArray(t)) { setTasks(t); setTaskCounts(countTasks(t)); }
            }).catch(() => {});
            break;
          }
          case 'agent:update':
          case 'agent:status': {
            fetch(`${baseUrl}/api/agents`).then(r => r.json()).then(a => {
              if (Array.isArray(a)) setAgents(a);
            }).catch(() => {});
            addActivity({ time: timestamp(), icon: '◆', text: `Agent ${msg.data?.role || '?'} → ${msg.data?.status || '?'}`, color: 'blue' });
            break;
          }
          case 'chat:message':
          case 'message': {
            setIsLeadTyping(false);
            setStreamingText('');
            const cm: ChatMessage = {
              sender: msg.data?.role || msg.data?.sender || 'lead',
              text: msg.data?.content || msg.data?.text || '',
              time: timestamp(),
            };
            setChatMessages(prev => [...prev.slice(-100), cm]);
            setNewMessageFlag(true);
            if (cm.sender !== 'user') {
              addActivity({ time: timestamp(), icon: '▪', text: `${cm.sender}: ${cm.text.slice(0, 60)}`, color: 'cyan' });
            }
            break;
          }
          case 'chat:stream': {
            setIsLeadTyping(true);
            if (msg.delta) setStreamingText(prev => prev + msg.delta);
            const ct = msg.content_type || 'text';
            if (shouldShow(displayConfig, ct as ContentType, msg.tool_name)) {
              addActivity({ time: timestamp(), icon: '…', text: `${(msg.delta || '').slice(0, 80)}`, color: 'gray' });
            }
            break;
          }
          case 'status:update':
            setStatus(prev => ({ ...prev, ...msg.data }));
            break;
          case 'tasks:update':
            if (Array.isArray(msg.data)) { setTasks(msg.data); setTaskCounts(countTasks(msg.data)); }
            break;
          case 'display:config':
            if (msg.config) setDisplayConfig(prev => ({ ...prev, ...msg.config }));
            break;
          default:
            if (msg.type) {
              addActivity({ time: timestamp(), icon: '·', text: `${msg.type}`, color: 'gray' });
            }
        }
      } catch { /* ignore non-JSON */ }
    });

    ws.on('close', () => {
      connectingRef.current = false;
      // Debounce disconnect status to avoid flashing
      clearTimeout(disconnectTimer.current);
      disconnectTimer.current = setTimeout(() => {
        setStatus(prev => ({ ...prev, connected: false }));
      }, 2000);
      addActivity({ time: timestamp(), icon: '▸', text: `Disconnected — reconnecting in ${reconnectDelay.current / 1000}s...`, color: 'red' });
      const delay = reconnectDelay.current;
      reconnectDelay.current = Math.min(delay * 2, 30000);
      reconnectTimer.current = setTimeout(connect, delay);
    });

    ws.on('error', () => {
      connectingRef.current = false;
      ws.close();
    });
  }, [wsUrl, baseUrl, fetchInitial, addActivity, countTasks, displayConfig]);

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
    try { return await fetch(`${baseUrl}${path}`).then(r => r.json()); }
    catch { return null; }
  }, [baseUrl]);

  const switchProject = useCallback((name: string) => {
    const newBase = baseUrl.replace(/\/api\/projects\/[^/]+/, `/api/projects/${name}`);
    const newWs = wsUrl.replace(/\/api\/projects\/[^/]+/, `/api/projects/${name}`);
    setBaseUrl(newBase);
    setWsUrl(newWs);
    setProject(name);
    // Force reconnect
    wsRef.current?.close();
  }, [baseUrl, wsUrl]);

  const clearNewMessage = useCallback(() => setNewMessageFlag(false), []);

  useEffect(() => {
    connect();
    return () => { clearTimeout(reconnectTimer.current); clearTimeout(disconnectTimer.current); wsRef.current?.close(); };
  }, [connect]);

  return {
    status, taskCounts, tasks, agents, activities, chatMessages,
    isLeadTyping, streamingText, newMessageFlag, clearNewMessage,
    sendMessage, fetchJson, displayConfig, sendDisplayUpdate, applyPreset,
    project, switchProject, baseUrl,
  };
}
