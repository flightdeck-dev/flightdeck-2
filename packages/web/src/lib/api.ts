import type { Task, Agent, Decision, ChatMessage, ProjectStatus } from './types.ts';

const BASE = '';

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(`GET ${path}: ${res.status}`);
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
};
