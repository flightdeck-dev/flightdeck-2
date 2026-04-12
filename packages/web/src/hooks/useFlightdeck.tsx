import { createContext, useContext, useState, useEffect, useCallback, useRef, type ReactNode } from 'react';
import { api } from '../lib/api.ts';
import { wsClient, type WsEvent } from '../lib/ws.ts';
import type { Task, Agent, Decision, ChatMessage, ProjectStatus } from '../lib/types.ts';

interface FlightdeckState {
  status: ProjectStatus | null;
  tasks: Task[];
  agents: Agent[];
  decisions: Decision[];
  messages: ChatMessage[];
  streamingMessages: Map<string, string>;
  connected: boolean;
  loading: boolean;
  sendChat: (content: string, parentId?: string, threadId?: string) => void;
  sendTaskComment: (taskId: string, content: string) => void;
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
  const streamingRef = useRef(new Map<string, string>());
  const [streamingMessages, setStreamingMessages] = useState(new Map<string, string>());

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
          setMessages(prev => [...prev, event.message]);
          // Clear streaming buffer for this message
          streamingRef.current.delete(event.message.id);
          setStreamingMessages(new Map(streamingRef.current));
          break;
        case 'chat:stream': {
          const current = streamingRef.current.get(event.message_id) ?? '';
          streamingRef.current.set(event.message_id, current + event.delta);
          setStreamingMessages(new Map(streamingRef.current));
          if (event.done) {
            // done — will get a chat:message with full content
          }
          break;
        }
        case 'task:comment':
          // Could update task activity
          break;
      }
    });

    const interval = setInterval(() => {
      setConnected(wsClient.connected);
    }, 1000);

    return () => {
      unsub();
      clearInterval(interval);
      wsClient.disconnect();
    };
  }, [fetchAll]);

  const sendChat = useCallback((content: string, parentId?: string, threadId?: string) => {
    wsClient.sendChat(content, parentId, threadId);
  }, []);

  const sendTaskComment = useCallback((taskId: string, content: string) => {
    wsClient.sendTaskComment(taskId, content);
  }, []);

  return (
    <Ctx.Provider value={{
      status, tasks, agents, decisions, messages, streamingMessages,
      connected, loading, sendChat, sendTaskComment, refresh: fetchAll,
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
