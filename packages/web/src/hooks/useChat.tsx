import { createContext, useContext, useState, useEffect, useCallback, useRef, type ReactNode } from 'react';
import useSWR from 'swr';
import { api } from '../lib/api.ts';
import { MAX_MESSAGES } from '../lib/constants.ts';
import { wsClient } from '../lib/ws.ts';
import { useWsEventBus } from './useWsEventBus.tsx';
import { useProject } from './useProject.tsx';
import { useDisplay } from './useDisplay.tsx';
import type { ChatMessage } from '../lib/types.ts';
import type { ContentType } from '@flightdeck-ai/shared/display';

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

export interface ChatContextValue {
  messages: ChatMessage[];
  streamingMessages: Map<string, string>;
  streamingChunks: Map<string, StreamChunk[]>;
  toolCallMap: Map<string, ToolCallState>;
  sendChat: (content: string, parentId?: string, threadId?: string) => void;
  sendTaskComment: (taskId: string, content: string) => void;
  interruptLead: () => void;
}

const ChatCtx = createContext<ChatContextValue | null>(null);

// Request notification permission on module load
if (typeof window !== 'undefined' && 'Notification' in window && Notification.permission === 'default') {
  Notification.requestPermission();
}

export function ChatProvider({ children }: { children: ReactNode }) {
  const [wsMessages, setWsMessages] = useState<ChatMessage[]>([]);
  const [streamingMessages, setStreamingMessages] = useState(new Map<string, string>());
  const [streamingChunks, setStreamingChunks] = useState(new Map<string, StreamChunk[]>());
  const [toolCallMap, setToolCallMap] = useState(new Map<string, ToolCallState>());
  const streamingRef = useRef(new Map<string, string>());
  const streamingChunksRef = useRef(new Map<string, StreamChunk[]>());
  const toolCallMapRef = useRef(new Map<string, ToolCallState>());
  const dirtyRef = useRef(false);
  const rafRef = useRef<number | null>(null);
  const { subscribe } = useWsEventBus();
  const { projectName } = useProject();
  const { displayConfig } = useDisplay();
  const displayConfigRef = useRef(displayConfig);
  displayConfigRef.current = displayConfig;

  const scheduleFlush = () => {
    if (!dirtyRef.current) {
      dirtyRef.current = true;
      rafRef.current = requestAnimationFrame(() => {
        setStreamingMessages(new Map(streamingRef.current));
        setStreamingChunks(new Map(streamingChunksRef.current));
        setToolCallMap(new Map(toolCallMapRef.current));
        dirtyRef.current = false;
      });
    }
  };

  // SWR for initial message load
  const agentMsgVisibility = displayConfig.agentMessages ?? 'summary';
  const { data: initialMessages } = useSWR(
    projectName ? ['messages', projectName, displayConfig.flightdeckTools, agentMsgVisibility] : null,
    () => api.getMessages(projectName!, {
      limit: 100,
      author_types: displayConfig.flightdeckTools === 'detail'
        ? undefined
        : agentMsgVisibility !== 'off' ? 'user,lead,system,agent' : 'user,lead,system',
      include_agent_dms: agentMsgVisibility !== 'off',
    })
  );

  // Clear WS messages when project changes
  useEffect(() => {
    setWsMessages([]);
    streamingRef.current.clear();
    streamingChunksRef.current.clear();
    toolCallMapRef.current.clear();
    setStreamingMessages(new Map());
    setStreamingChunks(new Map());
    setToolCallMap(new Map());
  }, [projectName]);

  // Merge initial SWR data with WS-streamed messages
  const messages = (() => {
    const base = initialMessages ?? [];
    if (wsMessages.length === 0) return base;
    const ids = new Set(base.map(m => m.id));
    const newMsgs = wsMessages.filter(m => !ids.has(m.id));
    return [...base, ...newMsgs].slice(-MAX_MESSAGES);
  })();

  useEffect(() => {
    return subscribe((event) => {
      switch (event.type) {
        case 'chat:message': {
          const msg = event.message;
          const isDebugMode = displayConfigRef.current.flightdeckTools === 'detail';
          const showAgentMsgs = (displayConfigRef.current.agentMessages ?? 'summary') !== 'off';
          if (!isDebugMode && msg.authorType && msg.authorType !== 'user' && msg.authorType !== 'lead' && msg.authorType !== 'system'
              && !(showAgentMsgs && msg.authorType === 'agent')) break;
          // Browser notification when Lead replies and tab is not focused
          if (msg.authorType === 'lead' && !document.hasFocus() && 'Notification' in window && Notification.permission === 'granted') {
            new Notification('Flightdeck — Lead replied', { body: (msg.content || '').slice(0, 100) });
          }
          setWsMessages(prev => {
            if (prev.some(m => m.id === msg.id)) return prev;
            return [...prev.slice(-(MAX_MESSAGES - 1)), msg];
          });
          streamingRef.current.delete(event.message.id);
          setStreamingMessages(new Map(streamingRef.current));
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
          scheduleFlush();
          break;
        }
        case 'task:comment':
          setWsMessages(prev => {
            if (prev.some(m => m.id === event.message.id)) return prev;
            return [...prev.slice(-(MAX_MESSAGES - 1)), event.message];
          });
          break;
        case 'dm:message': {
          // Live agent↔agent DMs — shown in main chat unless turned off
          if ((displayConfigRef.current.agentMessages ?? 'summary') === 'off') break;
          // The ws payload is the persisted message row — same shape the
          // REST endpoint returns, just typed loosely on the event union
          const dm = event.message as unknown as ChatMessage;
          if (!dm?.id) break;
          setWsMessages(prev => {
            if (prev.some(m => m.id === dm.id)) return prev;
            return [...prev.slice(-(MAX_MESSAGES - 1)), dm];
          });
          break;
        }
      }
    });
  }, [subscribe]);

  useEffect(() => {
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
  }, []);

  const sendChat = useCallback((content: string, parentId?: string, threadId?: string) => {
    wsClient.sendChat(content, parentId, threadId);
  }, []);

  const sendTaskComment = useCallback((taskId: string, content: string) => {
    wsClient.sendTaskComment(taskId, content);
  }, []);

  const interruptLead = useCallback(() => {
    wsClient.interruptLead();
  }, []);

  return (
    <ChatCtx.Provider value={{ messages, streamingMessages, streamingChunks, toolCallMap, sendChat, sendTaskComment, interruptLead }}>
      {children}
    </ChatCtx.Provider>
  );
}

export function useChat(): ChatContextValue {
  const ctx = useContext(ChatCtx);
  if (!ctx) throw new Error('useChat must be inside ChatProvider');
  return ctx;
}
