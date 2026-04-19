import type { Task, Agent, Decision, ChatMessage, ProjectStatus, ProjectSummary } from './types.ts';
import type { DisplayConfig } from '@flightdeck-ai/shared/display';

const BASE = '';

function camelizeKey(key: string): string {
  return key.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

function camelizeKeys(obj: unknown): unknown {
  if (Array.isArray(obj)) return obj.map(camelizeKeys);
  if (obj !== null && typeof obj === 'object' && !(obj instanceof Date)) {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      result[camelizeKey(k)] = camelizeKeys(v);
    }
    return result;
  }
  return obj;
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(`GET ${path}: ${res.status}`);
  const data = await res.json();
  return camelizeKeys(data) as T;
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
  getAgents: (project: string) => get<Agent[]>(projectPath(project, '/agents?include_retired=true')),
  getDecisions: (project: string, limit = 20) => get<Decision[]>(projectPath(project, `/decisions?limit=${limit}`)),
  getMessages: (project: string, opts?: { thread_id?: string; task_id?: string; limit?: number; author_types?: string }) => {
    const params = new URLSearchParams();
    if (opts?.thread_id) params.set('thread_id', opts.thread_id);
    if (opts?.task_id) params.set('task_id', opts.task_id);
    if (opts?.limit) params.set('limit', String(opts.limit));
    if (opts?.author_types) params.set('author_types', opts.author_types);
    return get<ChatMessage[]>(projectPath(project, `/messages?${params}`));
  },
  getReport: async (project: string): Promise<string> => {
    const res = await fetch(`${BASE}${projectPath(project, '/report')}`);
    if (!res.ok) return 'No report available.';
    return res.text();
  },
  getSpecs: async (project: string) => {
    const res = await fetch(`${BASE}${projectPath(project, '/specs')}`);
    if (!res.ok) return [];
    return res.json();
  },
  cancelSpec: async (project: string, specId: string) => {
    const res = await fetch(`${BASE}${projectPath(project, `/specs/${encodeURIComponent(specId)}/cancel`)}`, { method: 'POST' });
    if (!res.ok) throw new Error('Failed to cancel spec');
    return res.json();
  },
  getDisplayConfig: () => get<DisplayConfig>('/api/display'),
  updateDisplayConfig: (config: Partial<DisplayConfig>) => put<DisplayConfig>('/api/display', config),
  applyDisplayPreset: (preset: string) => post<DisplayConfig>(`/api/display/preset/${preset}`),
  createTask: (project: string, task: { title: string; description?: string; role?: string; priority?: number; depends_on?: string[]; needsReview?: boolean }) =>
    post<Task>(projectPath(project, '/tasks'), task),
  getThreads: (project: string) => get<import('./types.ts').Thread[]>(projectPath(project, '/threads')),
  getModels: () => get<Record<string, unknown>>('/api/models'),
  updateProjectConfig: (project: string, body: Record<string, unknown>) =>
    put<{ config: unknown }>(projectPath(project, '/config'), body),
  sendMessage: (project: string, content: string, opts?: { threadId?: string }) =>
    post<import('./types.ts').ChatMessage>(projectPath(project, '/messages'), { content, ...opts }),
  getAgentOutput: (project: string, agentId: string, tail?: number) =>
    get<{ agentId: string; lines: string[]; totalLines: number }>(projectPath(project, `/agents/${encodeURIComponent(agentId)}/output?tail=${tail ?? 100}`)),
  sendAgentMessage: (project: string, agentId: string, message: string, urgent?: boolean) =>
    post<{ ok: boolean }>(projectPath(project, `/agents/${encodeURIComponent(agentId)}/${urgent ? 'interrupt' : 'send'}`), { message }),
  setAgentModel: (project: string, agentId: string, model: string) =>
    put<{ success: boolean }>(projectPath(project, `/agents/${encodeURIComponent(agentId)}/model`), { model }),
  getAvailableModels: (project: string) => get<Record<string, unknown>>(projectPath(project, '/models/available')),
  testRuntime: (project: string, runtimeId: string) => post<{ success: boolean; installed: boolean; version?: string; message: string }>(projectPath(project, `/runtimes/${runtimeId}/test`), {}),
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
  createProject: (name: string, cwd: string, governance?: string, leadRuntime?: string, leadModel?: string) =>
    post<{ message: string }>('/api/projects', { name, cwd, ...(governance ? { governance } : {}), ...(leadRuntime ? { leadRuntime } : {}), ...(leadModel ? { leadModel } : {}) }),
  deleteProject: async (name: string): Promise<{ message: string }> => {
    const res = await fetch(`${BASE}/api/projects/${encodeURIComponent(name)}`, { method: 'DELETE' });
    if (!res.ok) throw new Error(`DELETE /api/projects/${name}: ${res.status}`);
    return res.json();
  },

  // Cron
  listCron: (project: string) => get<import('./types.ts').CronJob[]>(projectPath(project, '/cron')),
  createCron: (project: string, body: { name: string; schedule: string; prompt: string; skill?: string; enabled?: boolean; description?: string }) =>
    post<import('./types.ts').CronJob>(projectPath(project, '/cron'), { ...body, schedule: { cron: body.schedule } }),
  enableCron: (project: string, id: string) => put<{ success: boolean }>(projectPath(project, `/cron/${encodeURIComponent(id)}/enable`), {}),
  disableCron: (project: string, id: string) => put<{ success: boolean }>(projectPath(project, `/cron/${encodeURIComponent(id)}/disable`), {}),
  deleteCron: async (project: string, id: string): Promise<{ success: boolean }> => {
    const res = await fetch(`${BASE}${projectPath(project, `/cron/${encodeURIComponent(id)}`)}`, { method: 'DELETE' });
    if (!res.ok) throw new Error(`DELETE cron: ${res.status}`);
    return res.json();
  },
  runCron: (project: string, id: string) => post<{ status: string }>(projectPath(project, `/cron/${encodeURIComponent(id)}/run`)),

  // Roles
  getRoles: (project: string) => get<Array<{ id: string; name: string; description: string; icon: string; color: string; source: string; enabledModels: Array<{ runtime: string; model: string; enabled: boolean; isDefault?: boolean }>; permissions: Record<string, boolean>; instructions: string }>>(projectPath(project, '/roles')),
  updateRoleModels: (project: string, roleId: string, models: Array<{ runtime: string; model: string; enabled: boolean; isDefault?: boolean }>) =>
    put<{ success: boolean }>(projectPath(project, `/roles/${encodeURIComponent(roleId)}/models`), { models }),
  updateRolePrompt: (project: string, roleId: string, content: string) =>
    put<{ success: boolean }>(projectPath(project, `/roles/${encodeURIComponent(roleId)}/prompt`), { content }),
  createRole: (project: string, role: { id: string; name: string; description?: string; icon?: string; color?: string; instructions?: string }) =>
    post<{ success: boolean; id: string }>(projectPath(project, '/roles'), role),
  deleteRole: async (project: string, roleId: string): Promise<{ success: boolean }> => {
    const res = await fetch(`${BASE}${projectPath(project, `/roles/${encodeURIComponent(roleId)}`)}`, { method: 'DELETE' });
    if (!res.ok) throw new Error(`DELETE role: ${res.status}`);
    return res.json();
  },
  getRolePreference: (project: string) => get<{ content: string }>(projectPath(project, '/role-preference')),
  updateRolePreference: (project: string, content: string) =>
    put<{ success: boolean }>(projectPath(project, '/role-preference'), { content }),

  // Search
  search: (project: string, q: string, limit = 20) =>
    get<{
      tasks: Array<{ id: string; title: string; state: string; type: 'task' }>;
      agents: Array<{ id: string; name: string; role: string; status: string; type: 'agent' }>;
      messages: Array<{ id: string; content: string; authorType: string; authorId: string; type: 'message' }>;
    }>(projectPath(project, `/search?q=${encodeURIComponent(q)}&limit=${limit}`)),

  // Runtimes
  getRuntimes: (project: string) => get<Array<{ id: string; name: string; command: string; supportsAcp: boolean; adapter: string; supportsModelDiscovery?: boolean }>>(projectPath(project, '/runtimes')),

  // Escalations
  getEscalations: (project: string, status?: string) => {
    const params = status ? `?status=${status}` : '';
    return get<Array<{ id: number; agentId: string; title: string; description: string; priority: string; status: string; resolution: string | null; createdAt: string; resolvedAt: string | null }>>(projectPath(project, `/escalations${params}`));
  },
  resolveEscalation: (project: string, id: number, resolution: string) =>
    post<{ success: boolean }>(projectPath(project, `/escalations/${id}/resolve`), { resolution }),
};
