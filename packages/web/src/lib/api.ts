import type { Task, Agent, Decision, ChatMessage, ProjectStatus, ProjectSummary } from './types.ts';
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

function projectPath(project: string, path: string): string {
  return `/api/projects/${encodeURIComponent(project)}${path}`;
}

export const api = {
  getProjects: () => get<{ projects: ProjectSummary[] }>('/api/projects').then(r => r.projects),

  getStatus: (project: string) => get<ProjectStatus>(projectPath(project, '/status')),
  getTasks: (project: string) => get<Task[]>(projectPath(project, '/tasks')),
  getTask: (project: string, id: string) => get<Task>(projectPath(project, `/tasks/${id}`)),
  getAgents: (project: string) => get<Agent[]>(projectPath(project, '/agents')),
  getDecisions: (project: string, limit = 20) => get<Decision[]>(projectPath(project, `/decisions?limit=${limit}`)),
  getMessages: (project: string, opts?: { thread_id?: string; task_id?: string; limit?: number }) => {
    const params = new URLSearchParams();
    if (opts?.thread_id) params.set('thread_id', opts.thread_id);
    if (opts?.task_id) params.set('task_id', opts.task_id);
    if (opts?.limit) params.set('limit', String(opts.limit));
    return get<ChatMessage[]>(projectPath(project, `/messages?${params}`));
  },
  getReport: async (project: string): Promise<string> => {
    const res = await fetch(`${BASE}${projectPath(project, '/report')}`);
    if (!res.ok) return 'No report available.';
    return res.text();
  },
  getDisplayConfig: () => get<DisplayConfig>('/api/display'),
  updateDisplayConfig: (config: Partial<DisplayConfig>) => put<DisplayConfig>('/api/display', config),
  applyDisplayPreset: (preset: string) => post<DisplayConfig>(`/api/display/preset/${preset}`),
  createTask: (project: string, task: { title: string; description?: string; role?: string; priority?: number; depends_on?: string[] }) =>
    post<Task>(projectPath(project, '/tasks'), task),
  getThreads: (project: string) => get<import('./types.ts').Thread[]>(projectPath(project, '/threads')),
  getModels: () => get<Record<string, unknown>>('/api/models'),
  sendMessage: (project: string, content: string, opts?: { thread_id?: string }) =>
    post<import('./types.ts').ChatMessage>(projectPath(project, '/messages'), { content, ...opts }),
  getAgentOutput: (project: string, agentId: string, tail?: number) =>
    get<{ agentId: string; lines: string[]; totalLines: number }>(projectPath(project, `/agents/${encodeURIComponent(agentId)}/output?tail=${tail ?? 100}`)),
  sendAgentMessage: (project: string, agentId: string, message: string, urgent?: boolean) =>
    post<{ ok: boolean }>(projectPath(project, `/agents/${encodeURIComponent(agentId)}/${urgent ? 'interrupt' : 'send'}`), { message }),
  setAgentModel: (project: string, agentId: string, model: string) =>
    put<{ success: boolean }>(projectPath(project, `/agents/${encodeURIComponent(agentId)}/model`), { model }),
  getAvailableModels: (project: string) => get<Record<string, unknown>>(projectPath(project, '/models/available')),
  hibernateAgent: (project: string, agentId: string) =>
    post<{ ok: boolean }>(projectPath(project, `/agents/${encodeURIComponent(agentId)}/hibernate`)),
  wakeAgent: (project: string, agentId: string) =>
    post<Agent>(projectPath(project, `/agents/${encodeURIComponent(agentId)}/wake`)),
  retireAgent: (project: string, agentId: string) =>
    post<{ ok: boolean }>(projectPath(project, `/agents/${encodeURIComponent(agentId)}/retire`)),
  unretireAgent: (project: string, agentId: string) =>
    post<{ ok: boolean }>(projectPath(project, `/agents/${encodeURIComponent(agentId)}/unretire`)),
  terminateAgent: (project: string, agentId: string) =>
    post<{ ok: boolean }>(projectPath(project, `/agents/${encodeURIComponent(agentId)}/terminate`)),
  restartAgent: (project: string, agentId: string) =>
    post<Agent>(projectPath(project, `/agents/${encodeURIComponent(agentId)}/restart`)),
};
