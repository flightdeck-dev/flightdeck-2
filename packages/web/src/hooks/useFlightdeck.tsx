import { createContext, useContext, useState, useEffect, useCallback, useRef, type ReactNode } from 'react';
import { api } from '../lib/api.ts';
import { wsClient, type WsEvent } from '../lib/ws.ts';
import type { Task, Agent, Decision, ChatMessage, ProjectStatus } from '../lib/types.ts';
import { type DisplayConfig, type DisplayPreset, DEFAULT_DISPLAY, DISPLAY_PRESETS, type ContentType } from '@flightdeck-ai/shared/display';

export interface StreamChunk {
  content: string;
  contentType?: ContentType;
  toolName?: string;
}

interface FlightdeckState {
  status: ProjectStatus | null;
  tasks: Task[];
  agents: Agent[];
  decisions: Decision[];
  messages: ChatMessage[];
  streamingMessages: Map<string, string>;
  streamingChunks: Map<string, StreamChunk[]>;
  displayConfig: DisplayConfig;
  connected: boolean;
  loading: boolean;
  sendChat: (content: string, parentId?: string, threadId?: string) => void;
  sendTaskComment: (taskId: string, content: string) => void;
  setDisplayConfig: (config: Partial<DisplayConfig>) => void;
  applyDisplayPreset: (preset: DisplayPreset) => void;
  refresh: () => void;
}

const Ctx = createContext<FlightdeckState | null>(null);

export function FlightdeckProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<ProjectStatus | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [decisions, setDecisions] = useState<Decision[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [connected, setConnected] = useState(false);
  const [loading, setLoading] = useState(true);
  const [displayConfig, setDisplayConfigState] = useState<DisplayConfig>(() => {
    try {
      const stored = localStorage.getItem('flightdeck:display');
      return stored ? JSON.parse(stored) : { ...DEFAULT_DISPLAY };
    } catch { return { ...DEFAULT_DISPLAY }; }
  });
  const streamingRef = useRef(new Map<string, string>());
  const streamingChunksRef = useRef(new Map<string, StreamChunk[]>());
  const [streamingMessages, setStreamingMessages] = useState(new Map<string, string>());
  const [streamingChunks, setStreamingChunks] = useState(new Map<string, StreamChunk[]>());
  const streamingDirtyRef = useRef(false);
  const rafRef = useRef<number | null>(null);

  const fetchAll = useCallback(async () => {
    try {
      const [s, t, a, d, m] = await Promise.all([
        api.getStatus().catch(() => null),
        api.getTasks().catch(() => []),
        api.getAgents().catch(() => []),
        api.getDecisions().catch(() => []),
        api.getMessages({ limit: 100 }).catch(() => []),
      ]);
      if (s) setStatus(s);
      setTasks(t);
      setAgents(a);
      setDecisions(d);
      setMessages(m);
    } catch { /* server not running — use empty state */ }
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchAll();
    wsClient.connect();

    const unsub = wsClient.on((event: WsEvent) => {
      switch (event.type) {
        case 'chat:message':
          setMessages(prev => {
            if (prev.some(m => m.id === event.message.id)) return prev;
            return [...prev.slice(-499), event.message];
          });
          // Clear streaming buffer for this message
          streamingRef.current.delete(event.message.id);
          setStreamingMessages(new Map(streamingRef.current));
          streamingChunksRef.current.delete(event.message.id);
          setStreamingChunks(new Map(streamingChunksRef.current));
          break;
        case 'chat:stream': {
          const current = streamingRef.current.get(event.message_id) ?? '';
          streamingRef.current.set(event.message_id, current + event.delta);
          // Track chunks with metadata
          const chunks = streamingChunksRef.current.get(event.message_id) ?? [];
          chunks.push({ content: event.delta, contentType: event.content_type, toolName: event.tool_name });
          streamingChunksRef.current.set(event.message_id, chunks);
          // Throttle streaming state updates
          if (!streamingDirtyRef.current) {
            streamingDirtyRef.current = true;
            rafRef.current = requestAnimationFrame(() => {
              setStreamingMessages(new Map(streamingRef.current));
              setStreamingChunks(new Map(streamingChunksRef.current));
              streamingDirtyRef.current = false;
            });
          }
          if (event.done) {
            // done — will get a chat:message with full content
          }
          break;
        }
        case 'display:config':
          setDisplayConfigState(event.config);
          localStorage.setItem('flightdeck:display', JSON.stringify(event.config));
          break;
        case 'task:comment':
          // Could update task activity
          break;
      }
    });

    const unsubConn = wsClient.onConnectionChange(setConnected);

    return () => {
      unsub();
      unsubConn();
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      wsClient.disconnect();
    };
  }, [fetchAll]);

  const sendChat = useCallback((content: string, parentId?: string, threadId?: string) => {
    wsClient.sendChat(content, parentId, threadId);
  }, []);

  const sendTaskComment = useCallback((taskId: string, content: string) => {
    wsClient.sendTaskComment(taskId, content);
  }, []);

  const setDisplayConfig = useCallback((config: Partial<DisplayConfig>) => {
    wsClient.sendDisplayConfig(config);
    // Optimistically update local state
    setDisplayConfigState(prev => {
      const merged = { ...prev, ...config };
      localStorage.setItem('flightdeck:display', JSON.stringify(merged));
      return merged;
    });
  }, []);

  const applyDisplayPreset = useCallback((preset: DisplayPreset) => {
    const config = DISPLAY_PRESETS[preset];
    setDisplayConfig({ ...config });
  }, [setDisplayConfig]);

  return (
    <Ctx.Provider value={{
      status, tasks, agents, decisions, messages, streamingMessages, streamingChunks,
      displayConfig, connected, loading, sendChat, sendTaskComment,
      setDisplayConfig, applyDisplayPreset, refresh: fetchAll,
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
