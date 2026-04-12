import type { Task, Agent, Decision, ChatMessage, ProjectStatus } from './types.ts';
import type { DisplayConfig } from '@flightdeck-ai/shared/display';

const BASE = '';

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(`GET ${path}: ${res.status}`);
  return res.json();
}

async function put<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`PUT ${path}: ${res.status}`);
  return res.json();
}

async function post<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: body != null ? { 'Content-Type': 'application/json' } : {},
    body: body != null ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`POST ${path}: ${res.status}`);
  return res.json();
}

export const api = {
  getStatus: () => get<ProjectStatus>('/api/status'),
  getTasks: () => get<Task[]>('/api/tasks'),
  getTask: (id: string) => get<Task>(`/api/tasks/${id}`),
  getAgents: () => get<Agent[]>('/api/agents'),
  getDecisions: (limit = 20) => get<Decision[]>(`/api/decisions?limit=${limit}`),
  getMessages: (opts?: { thread_id?: string; task_id?: string; limit?: number }) => {
    const params = new URLSearchParams();
    if (opts?.thread_id) params.set('thread_id', opts.thread_id);
    if (opts?.task_id) params.set('task_id', opts.task_id);
    if (opts?.limit) params.set('limit', String(opts.limit));
    return get<ChatMessage[]>(`/api/messages?${params}`);
  },
  getReport: async (): Promise<string> => {
    const res = await fetch(`${BASE}/api/report`);
    if (!res.ok) return 'No report available.';
    return res.text();
  },
  getDisplayConfig: () => get<DisplayConfig>('/api/display'),
  updateDisplayConfig: (config: Partial<DisplayConfig>) => put<DisplayConfig>('/api/display', config),
  applyDisplayPreset: (preset: string) => post<DisplayConfig>(`/api/display/preset/${preset}`),
  createTask: (task: { title: string; description?: string; role?: string; priority?: number; depends_on?: string[] }) =>
    post<import('./types.ts').Task>('/api/tasks', task),
  getThreads: () => get<import('./types.ts').Thread[]>('/api/threads'),
  getModels: () => get<Record<string, unknown>>('/api/models'),
  sendMessage: (content: string, opts?: { thread_id?: string }) =>
    post<import('./types.ts').ChatMessage>('/api/messages', { content, ...opts }),
};
