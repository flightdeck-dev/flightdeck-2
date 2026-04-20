import { createContext, useContext, useState, useEffect, useRef, type ReactNode } from 'react';
import useSWR from 'swr';
import { api } from '../lib/api.ts';
import { useWsEventBus } from './useWsEventBus.tsx';
import { useProject } from './useProject.tsx';
import type { Agent } from '../lib/types.ts';
import type { ContentType } from '@flightdeck-ai/shared/display';

export interface StreamChunk {
  content: string;
  contentType?: ContentType;
  toolName?: string;
}

export interface AgentContextValue {
  agents: Agent[];
  agentOutputs: Map<string, string>;
  agentStreamChunks: Map<string, StreamChunk[]>;
  dmMessages: Map<string, any[]>;
}

const AgentCtx = createContext<AgentContextValue | null>(null);

export function AgentProvider({ children }: { children: ReactNode }) {
  const [agentOutputs, setAgentOutputs] = useState(new Map<string, string>());
  const [agentStreamChunks, setAgentStreamChunks] = useState(new Map<string, StreamChunk[]>());
  const [dmMessages, setDmMessages] = useState(new Map<string, any[]>());
  const agentOutputsRef = useRef(new Map<string, string>());
  const agentStreamChunksRef = useRef(new Map<string, StreamChunk[]>());
  const dmMessagesRef = useRef(new Map<string, any[]>());
  const dirtyRef = useRef(false);
  const rafRef = useRef<number | null>(null);
  const { subscribe } = useWsEventBus();
  const { projectName } = useProject();

  const scheduleFlush = () => {
    if (!dirtyRef.current) {
      dirtyRef.current = true;
      rafRef.current = requestAnimationFrame(() => {
        setAgentOutputs(new Map(agentOutputsRef.current));
        setAgentStreamChunks(new Map(agentStreamChunksRef.current));
        dirtyRef.current = false;
      });
    }
  };

  const { data: agents = [], mutate: mutateAgents } = useSWR(
    projectName ? ['agents', projectName] : null,
    () => api.getAgents(projectName!)
  );

  // Clear streaming state when project changes
  useEffect(() => {
    agentOutputsRef.current.clear();
    agentStreamChunksRef.current.clear();
    setAgentOutputs(new Map());
    setAgentStreamChunks(new Map());
  }, [projectName]);

  useEffect(() => {
    return subscribe((event) => {
      if (event.type === 'state:update') {
        mutateAgents();
      } else if (event.type === 'agent:stream') {
        const prev = agentOutputsRef.current.get(event.agentId) ?? '';
        agentOutputsRef.current.set(event.agentId, prev + event.delta);
        const prevChunks = agentStreamChunksRef.current.get(event.agentId) ?? [];
        agentStreamChunksRef.current.set(event.agentId, [...prevChunks, { content: event.delta, contentType: event.contentType ?? 'text', toolName: (event as any).toolName }]);
        scheduleFlush();
      } else if (event.type === 'tool:event') {
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
        scheduleFlush();
      } else if (event.type === 'dm:message') {
        const channel = event.message?.channel;
        if (channel?.startsWith('dm:')) {
          const agentId = channel.slice(3);
          const prev = dmMessagesRef.current.get(agentId) ?? [];
          dmMessagesRef.current.set(agentId, [...prev, event.message]);
          setDmMessages(new Map(dmMessagesRef.current));
        }
      }
    });
  }, [subscribe, mutateAgents]);

  useEffect(() => {
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
  }, []);

  return (
    <AgentCtx.Provider value={{ agents, agentOutputs, agentStreamChunks, dmMessages }}>
      {children}
    </AgentCtx.Provider>
  );
}

export function useAgents(): AgentContextValue {
  const ctx = useContext(AgentCtx);
  if (!ctx) throw new Error('useAgents must be inside AgentProvider');
  return ctx;
}
