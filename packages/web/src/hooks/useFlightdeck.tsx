import type { ReactNode } from 'react';
import { FlightdeckProviders } from './FlightdeckProviders.tsx';
import { useProject } from './useProject.tsx';
import { useTasks } from './useTasks.tsx';
import { useAgents } from './useAgents.tsx';
import { useChat } from './useChat.tsx';
import { useDisplay } from './useDisplay.tsx';
import type { Task, Agent, Decision, ChatMessage, ProjectStatus, ProjectSummary } from '../lib/types.ts';
import type { DisplayConfig, DisplayPreset } from '@flightdeck-ai/shared/display';

// Re-export types for backward compat
export type { StreamChunk, ToolCallState } from './useChat.tsx';

interface FlightdeckState {
  projects: ProjectSummary[];
  projectName: string | null;
  status: ProjectStatus | null;
  tasks: Task[];
  agents: Agent[];
  decisions: Decision[];
  messages: ChatMessage[];
  streamingMessages: Map<string, string>;
  streamingChunks: Map<string, import('./useChat.tsx').StreamChunk[]>;
  toolCallMap: Map<string, import('./useChat.tsx').ToolCallState>;
  agentOutputs: Map<string, string>;
  agentStreamChunks: Map<string, import('./useAgents.tsx').StreamChunk[]>;
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

/**
 * @deprecated Use specific hooks (useProject, useTasks, useAgents, useChat, useDisplay) for better performance.
 */
export function FlightdeckProvider({ projectName, children }: { projectName: string | null; children: ReactNode }) {
  return (
    <FlightdeckProviders projectName={projectName}>
      {children}
    </FlightdeckProviders>
  );
}

/**
 * @deprecated Use specific hooks (useProject, useTasks, useAgents, useChat, useDisplay) for better performance.
 * This hook re-renders on ANY state change. Prefer focused hooks.
 */
export function useFlightdeck(): FlightdeckState {
  const project = useProject();
  const tasks = useTasks();
  const agents = useAgents();
  const chat = useChat();
  const display = useDisplay();
  return {
    ...project,
    ...tasks,
    ...agents,
    ...chat,
    ...display,
  };
}
