import { createContext, useContext, useState, useEffect, useCallback, useRef, type ReactNode } from 'react';
import { api } from '../lib/api.ts';
import { MAX_MESSAGES } from '../lib/constants.ts';
import { wsClient, type WsEvent } from '../lib/ws.ts';
import type { Task, Agent, Decision, ChatMessage, ProjectStatus, ProjectSummary } from '../lib/types.ts';
import { type DisplayConfig, type DisplayPreset, DEFAULT_DISPLAY, DISPLAY_PRESETS, type ContentType } from '@flightdeck-ai/shared/display';

const STORAGE_KEY = 'flightdeck:display';
const STORAGE_VERSION = 1;
const STORAGE_VERSION_KEY = 'flightdeck:display:version';

function loadDisplayConfig(): DisplayConfig {
  try {
    const ver = localStorage.getItem(STORAGE_VERSION_KEY);
    if (ver !== String(STORAGE_VERSION)) {
      localStorage.removeItem(STORAGE_KEY);
      localStorage.setItem(STORAGE_VERSION_KEY, String(STORAGE_VERSION));
      return { ...DEFAULT_DISPLAY };
    }
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored ? JSON.parse(stored) : { ...DEFAULT_DISPLAY };
  } catch { return { ...DEFAULT_DISPLAY }; }
}

function saveDisplayConfig(config: DisplayConfig): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
    localStorage.setItem(STORAGE_VERSION_KEY, String(STORAGE_VERSION));
  } catch {}
}

export interface StreamChunk {
  content: string;
  contentType?: ContentType;
  toolName?: string;
}

export interface ToolCallState {
  toolCallId: string;
  name: string;
  input: string;
  result: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  contentType: ContentType;
}

interface FlightdeckState {
  projects: ProjectSummary[];
  projectName: string | null;
  status: ProjectStatus | null;
  tasks: Task[];
  agents: Agent[];
  decisions: Decision[];
  messages: ChatMessage[];
  streamingMessages: Map<string, string>;
  streamingChunks: Map<string, StreamChunk[]>;
  toolCallMap: Map<string, ToolCallState>;
  agentOutputs: Map<string, string>;
  agentStreamChunks: Map<string, StreamChunk[]>;
  displayConfig: DisplayConfig;
  connected: boolean;
  loading: boolean;
  sendChat: (content: string, parentId?: string, threadId?: string) => void;
  sendTaskComment: (taskId: string, content: string) => void;
  setDisplayConfig: (config: Partial<DisplayConfig>) => void;
  applyDisplayPreset: (preset: DisplayPreset) => void;
  interruptLead: () => void;
  refresh: () => void;
}

const Ctx = createContext<FlightdeckState | null>(null);

export function FlightdeckProvider({ projectName, children }: { projectName: string | null; children: ReactNode }) {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [status, setStatus] = useState<ProjectStatus | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [decisions, setDecisions] = useState<Decision[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [connected, setConnected] = useState(false);
  const [loading, setLoading] = useState(true);
  const [displayConfig, setDisplayConfigState] = useState<DisplayConfig>(loadDisplayConfig);
  const streamingRef = useRef(new Map<string, string>());
  const streamingChunksRef = useRef(new Map<string, StreamChunk[]>());
  const toolCallMapRef = useRef(new Map<string, ToolCallState>());
  const [streamingMessages, setStreamingMessages] = useState(new Map<string, string>());
  const [streamingChunks, setStreamingChunks] = useState(new Map<string, StreamChunk[]>());
  const [toolCallMap, setToolCallMap] = useState(new Map<string, ToolCallState>());
  const agentOutputsRef = useRef(new Map<string, string>());
  const [agentOutputs, setAgentOutputs] = useState(new Map<string, string>());
  const agentStreamChunksRef = useRef(new Map<string, StreamChunk[]>());
  const [agentStreamChunks, setAgentStreamChunks] = useState(new Map<string, StreamChunk[]>());
  const streamingDirtyRef = useRef(false);
  const rafRef = useRef<number | null>(null);

  const fetchProjects = useCallback(async () => {
    try {
      const p = await api.getProjects();
      setProjects(p);
    } catch { /* ignore */ }
  }, []);

  const fetchAll = useCallback(async () => {
    if (!projectName) {
      setLoading(false);
      return;
    }
    try {
      const [s, t, a, d, m] = await Promise.all([
        api.getStatus(projectName).catch(() => null),
        api.getTasks(projectName).catch(() => []),
        api.getAgents(projectName).catch(() => []),
        api.getDecisions(projectName).catch(() => []),
        api.getMessages(projectName, { limit: 100, author_types: 'user,lead,system' }).catch(() => []),
      ]);
      if (s) setStatus(s);
      setTasks(t);
      setAgents(a);
      setDecisions(d);
      setMessages(m);
      if (import.meta.env.DEV && t.length === 0) {
        console.debug('[Flightdeck] fetchAll: tasks empty for project', projectName);
      }
    } catch (err) {
      if (import.meta.env.DEV) console.warn('[Flightdeck] fetchAll error:', err);
    }
    setLoading(false);
  }, [projectName]);

  useEffect(() => {
    fetchProjects();
  }, [fetchProjects]);

  const fetchAllRef = useRef(fetchAll);
  fetchAllRef.current = fetchAll;

  useEffect(() => {
    setLoading(true);
    setStatus(null);
    setTasks([]);
    setAgents([]);
    setDecisions([]);
    setMessages([]);
    streamingRef.current.clear();
    streamingChunksRef.current.clear();
    toolCallMapRef.current.clear();
    setStreamingMessages(new Map());
    setStreamingChunks(new Map());
    setToolCallMap(new Map());
    agentOutputsRef.current.clear();
    setAgentOutputs(new Map());
    agentStreamChunksRef.current.clear();
    setAgentStreamChunks(new Map());
    fetchAll();
  }, [fetchAll]);

  useEffect(() => {
    if (!projectName) return;
    wsClient.setProject(projectName);
    wsClient.connect();

    // After connecting, push saved display config to server (server sends DEFAULT on connect)
    const unsubConn = wsClient.onConnectionChange((connected) => {
      setConnected(connected);
      if (connected) {
        // Push our saved config to override server default
        const saved = loadDisplayConfig();
        wsClient.sendDisplayConfig(saved);
      }
    });

    let ignoreFirstConfig = true; // Skip server's initial DEFAULT_DISPLAY push
    const unsub = wsClient.on((event: WsEvent) => {
      switch (event.type) {
        case 'chat:message': {
          const msg = event.message;
          // Only show user, lead, and system messages in main chat
          if (msg.authorType && msg.authorType !== 'user' && msg.authorType !== 'lead' && msg.authorType !== 'system') break;
          setMessages(prev => {
            if (prev.some(m => m.id === msg.id)) return prev;
            return [...prev.slice(-(MAX_MESSAGES - 1)), msg];
          });
          // Keep streaming chunks (tool calls, thinking) visible — just remove the raw text stream
          streamingRef.current.delete(event.message.id);
          setStreamingMessages(new Map(streamingRef.current));
          // Don't clear streamingChunks — they contain tool calls/thinking that should persist
          // Clear tool call states for completed message
          toolCallMapRef.current.clear();
          setToolCallMap(new Map());
          break;
        }
        case 'chat:stream': {
          const current = streamingRef.current.get(event.message_id) ?? '';
          streamingRef.current.set(event.message_id, current + event.delta);
          const chunks = streamingChunksRef.current.get(event.message_id) ?? [];
          chunks.push({ content: event.delta, contentType: event.content_type, toolName: event.tool_name });
          streamingChunksRef.current.set(event.message_id, chunks);
          // Merge tool call/result by toolCallId
          const ct = event.content_type;
          if (ct === 'tool_call' || ct === 'flightdeck_tool_call' || ct === 'tool_result' || ct === 'flightdeck_tool_result') {
            try {
              const parsed = JSON.parse(event.delta);
              if (parsed.toolCallId) {
                const existing = toolCallMapRef.current.get(parsed.toolCallId);
                if (ct === 'tool_call' || ct === 'flightdeck_tool_call') {
                  toolCallMapRef.current.set(parsed.toolCallId, {
                    toolCallId: parsed.toolCallId,
                    name: parsed.name || existing?.name || '',
                    input: parsed.input || existing?.input || '',
                    result: existing?.result || '',
                    status: parsed.status || 'pending',
                    contentType: ct === 'flightdeck_tool_call' ? 'flightdeck_tool_call' : 'tool_call',
                  });
                } else {
                  toolCallMapRef.current.set(parsed.toolCallId, {
                    toolCallId: parsed.toolCallId,
                    name: parsed.name || existing?.name || '',
                    input: existing?.input || '',
                    result: parsed.result || existing?.result || '',
                    status: parsed.status || 'completed',
                    contentType: existing?.contentType || (ct === 'flightdeck_tool_result' ? 'flightdeck_tool_call' : 'tool_call'),
                  });
                }
              }
            } catch {}
          }
          if (!streamingDirtyRef.current) {
            streamingDirtyRef.current = true;
            rafRef.current = requestAnimationFrame(() => {
              setStreamingMessages(new Map(streamingRef.current));
              setStreamingChunks(new Map(streamingChunksRef.current));
              setToolCallMap(new Map(toolCallMapRef.current));
              setAgentOutputs(new Map(agentOutputsRef.current));
              setAgentStreamChunks(new Map(agentStreamChunksRef.current));
              streamingDirtyRef.current = false;
            });
          }
          break;
        }
        case 'display:config':
          if (ignoreFirstConfig) {
            ignoreFirstConfig = false;
            break;
          }
          setDisplayConfigState(event.config);
          saveDisplayConfig(event.config);
          break;
        case 'task:comment':
          setMessages(prev => {
            if (prev.some(m => m.id === event.message.id)) return prev;
            return [...prev.slice(-(MAX_MESSAGES - 1)), event.message];
          });
          break;
        case 'state:update':
          // Tasks/agents changed — refetch
          fetchAllRef.current();
          break;
        case 'agent:stream': {
          const prev = agentOutputsRef.current.get(event.agentId) ?? '';
          agentOutputsRef.current.set(event.agentId, prev + event.delta);
          const prevChunks = agentStreamChunksRef.current.get(event.agentId) ?? [];
          agentStreamChunksRef.current.set(event.agentId, [...prevChunks, { content: event.delta, contentType: event.contentType ?? 'text', toolName: (event as any).toolName }]);
          if (!streamingDirtyRef.current) {
            streamingDirtyRef.current = true;
            rafRef.current = requestAnimationFrame(() => {
              setStreamingMessages(new Map(streamingRef.current));
              setStreamingChunks(new Map(streamingChunksRef.current));
              setToolCallMap(new Map(toolCallMapRef.current));
              setAgentOutputs(new Map(agentOutputsRef.current));
              setAgentStreamChunks(new Map(agentStreamChunksRef.current));
              streamingDirtyRef.current = false;
            });
          }
          break;
        }
        case 'tool:event': {
          // Convert tool:event into agent stream chunks for display
          const agentId = event.agentId;
          const prevChunks = agentStreamChunksRef.current.get(agentId) ?? [];
          if (event.status === 'running') {
            agentStreamChunksRef.current.set(agentId, [...prevChunks, {
              content: `\n🔧 ${event.toolName}(...)`,
              contentType: 'tool_call' as const,
              toolName: event.toolName,
            }]);
          } else if (event.status === 'completed') {
            const outputStr = typeof event.output === 'string' ? event.output : JSON.stringify(event.output);
            const durationStr = event.durationMs ? ` (${event.durationMs}ms)` : '';
            agentStreamChunksRef.current.set(agentId, [...prevChunks, {
              content: `\n✅ ${event.toolName}${durationStr}: ${outputStr?.slice(0, 500) ?? '(no output)'}`,
              contentType: 'tool_result' as const,
              toolName: event.toolName,
            }]);
          } else if (event.status === 'error') {
            agentStreamChunksRef.current.set(agentId, [...prevChunks, {
              content: `\n❌ ${event.toolName}: ${event.error ?? 'unknown error'}`,
              contentType: 'tool_result' as const,
              toolName: event.toolName,
            }]);
          }
          if (!streamingDirtyRef.current) {
            streamingDirtyRef.current = true;
            rafRef.current = requestAnimationFrame(() => {
              setAgentStreamChunks(new Map(agentStreamChunksRef.current));
              streamingDirtyRef.current = false;
            });
          }
          break;
        }
      }
    });

    return () => {
      unsub();
      unsubConn();
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      wsClient.disconnect();
    };
  }, []);

  const sendChat = useCallback((content: string, parentId?: string, threadId?: string) => {
    wsClient.sendChat(content, parentId, threadId);
  }, []);

  const sendTaskComment = useCallback((taskId: string, content: string) => {
    wsClient.sendTaskComment(taskId, content);
  }, []);

  const setDisplayConfig = useCallback((config: Partial<DisplayConfig>) => {
    wsClient.sendDisplayConfig(config);
    setDisplayConfigState(prev => {
      const merged = { ...prev, ...config };
      saveDisplayConfig(merged);
      return merged;
    });
  }, []);

  const applyDisplayPreset = useCallback((preset: DisplayPreset) => {
    const config = DISPLAY_PRESETS[preset];
    setDisplayConfig({ ...config });
  }, [setDisplayConfig]);

  const interruptLead = useCallback(() => {
    wsClient.interruptLead();
  }, []);

  return (
    <Ctx.Provider value={{
      projects, projectName, status, tasks, agents, decisions, messages, streamingMessages, streamingChunks, toolCallMap, agentOutputs, agentStreamChunks,
      displayConfig, connected, loading, sendChat, sendTaskComment,
      setDisplayConfig, applyDisplayPreset, interruptLead, refresh: fetchAll,
    }}>
      {children}
    </Ctx.Provider>
  );
}

export function useFlightdeck(): FlightdeckState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useFlightdeck must be inside FlightdeckProvider');
  return ctx;
}
