/**
 * HTTP client for the Flightdeck gateway.
 * Used by the MCP server subprocess to proxy all operations through the
 * running gateway daemon instead of accessing SQLite directly.
 */
export class GatewayClient {
  readonly baseUrl: string;
  readonly projectName: string;
  readonly agentId: string;
  readonly agentRole: string;

  constructor() {
    this.baseUrl = process.env.FLIGHTDECK_URL || 'http://localhost:18800';
    this.projectName = process.env.FLIGHTDECK_PROJECT || '';
    this.agentId = process.env.FLIGHTDECK_AGENT_ID || '';
    this.agentRole = process.env.FLIGHTDECK_AGENT_ROLE || '';
  }

  private url(path: string): string {
    return `${this.baseUrl}/api/projects/${encodeURIComponent(this.projectName)}${path}`;
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'X-Agent-Id': process.env.FLIGHTDECK_AGENT_ID || this.agentId,
      'X-Agent-Role': process.env.FLIGHTDECK_AGENT_ROLE || this.agentRole,
      ...extra,
    };
  }

  private async request<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(this.url(path), {
      method,
      headers: this.headers(),
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      let errorMsg: string;
      try {
        const json = JSON.parse(text);
        errorMsg = json.error || text;
      } catch {
        errorMsg = text || `HTTP ${res.status}`;
      }
      throw new Error(errorMsg);
    }
    const text = await res.text();
    if (!text) return undefined as T;
    return JSON.parse(text) as T;
  }

  private async get<T = unknown>(path: string, params?: Record<string, string | undefined>): Promise<T> {
    let url = this.url(path);
    if (params) {
      const searchParams = new URLSearchParams();
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined) searchParams.set(k, v);
      }
      const qs = searchParams.toString();
      if (qs) url += '?' + qs;
    }
    const res = await fetch(url, { headers: this.headers() });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      let errorMsg: string;
      try {
        const json = JSON.parse(text);
        errorMsg = json.error || text;
      } catch {
        errorMsg = text || `HTTP ${res.status}`;
      }
      throw new Error(errorMsg);
    }
    return res.json() as Promise<T>;
  }

  // ── Tasks ──

  async listTasks(params?: { specId?: string; state?: string; role?: string; assignedAgent?: string }): Promise<unknown[]> {
    return this.get('/tasks', params as Record<string, string | undefined>);
  }

  async getTask(taskId: string): Promise<unknown> {
    return this.get(`/tasks/${taskId}`);
  }

  async addTask(params: { title: string; description?: string; specId?: string; role?: string; dependsOn?: string[]; priority?: number; needsReview?: boolean }): Promise<unknown> {
    return this.request('POST', '/tasks', params);
  }

  async claimTask(taskId: string): Promise<unknown> {
    return this.request('POST', `/tasks/${taskId}/claim`);
  }

  async submitTask(taskId: string, claim?: string): Promise<unknown> {
    return this.request('POST', `/tasks/${taskId}/submit`, { claim });
  }

  async failTask(taskId: string, reason?: string): Promise<unknown> {
    return this.request('POST', `/tasks/${taskId}/fail`, { reason });
  }

  async cancelTask(taskId: string): Promise<unknown> {
    return this.request('POST', `/tasks/${taskId}/cancel`);
  }

  async pauseTask(taskId: string): Promise<unknown> {
    return this.request('POST', `/tasks/${taskId}/pause`);
  }

  async resumeTask(taskId: string): Promise<unknown> {
    return this.request('POST', `/tasks/${taskId}/resume`);
  }

  async retryTask(taskId: string): Promise<unknown> {
    return this.request('POST', `/tasks/${taskId}/retry`);
  }

  async skipTask(taskId: string): Promise<unknown> {
    return this.request('POST', `/tasks/${taskId}/skip`);
  }

  async completeTask(taskId: string): Promise<unknown> {
    return this.request('POST', `/tasks/${taskId}/complete`);
  }

  async reopenTask(taskId: string): Promise<unknown> {
    return this.request('POST', `/tasks/${taskId}/reopen`);
  }

  async reviewSubmit(taskId: string, verdict: string, comment: string): Promise<unknown> {
    return this.request('POST', `/tasks/${taskId}/review`, { verdict, comment });
  }

  async addTaskComment(taskId: string, comment: string): Promise<unknown> {
    return this.request('POST', `/tasks/${taskId}/comments`, { comment });
  }

  async declareTasks(tasks: unknown[]): Promise<unknown> {
    return this.request('POST', '/tasks/declare', { tasks });
  }

  async declareSubtasks(parentTaskId: string, tasks: unknown[]): Promise<unknown> {
    return this.request('POST', `/tasks/${parentTaskId}/subtasks`, { tasks });
  }

  async compactTask(taskId: string, summary?: string): Promise<unknown> {
    return this.request('POST', `/tasks/${taskId}/compact`, { summary });
  }

  async clearTaskStale(taskId: string): Promise<unknown> {
    return this.request('POST', `/tasks/${taskId}/clear-stale`);
  }

  async getTaskEvents(taskId: string): Promise<unknown[]> {
    return this.get(`/tasks/${taskId}/events`);
  }

  async getTaskComments(taskId: string): Promise<unknown[]> {
    return this.get(`/tasks/${taskId}/comments`);
  }

  // ── Agents ──

  async listAgents(includeRetired?: boolean): Promise<unknown[]> {
    return this.get('/agents', includeRetired ? { includeRetired: 'true' } : undefined);
  }

  async spawnAgent(params: { role: string; model?: string; runtime?: string; task?: string; cwd?: string }): Promise<unknown> {
    return this.request('POST', '/agents/spawn', params);
  }

  async terminateAgent(agentId: string): Promise<void> {
    await this.request('POST', `/agents/${agentId}/terminate`);
  }

  async restartAgent(agentId: string): Promise<unknown> {
    return this.request('POST', `/agents/${agentId}/restart`);
  }

  async interruptAgent(agentId: string, message: string): Promise<void> {
    await this.request('POST', `/agents/${agentId}/interrupt`, { message });
  }

  async sendToAgent(agentId: string, message: string): Promise<void> {
    await this.request('POST', `/agents/${agentId}/send`, { message });
  }

  async hibernateAgent(agentId: string): Promise<unknown> {
    return this.request('POST', `/agents/${agentId}/hibernate`);
  }

  async wakeAgent(agentId: string): Promise<unknown> {
    return this.request('POST', `/agents/${agentId}/wake`);
  }

  async retireAgent(agentId: string): Promise<void> {
    await this.request('POST', `/agents/${agentId}/retire`);
  }

  async getAgentOutput(agentId: string, tail = 50): Promise<unknown> {
    return this.get(`/agents/${agentId}/output`, { tail: String(tail) });
  }

  // ── Messages ──

  async sendMessage(params: { to?: string; channel?: string; taskId?: string; parentId?: string; content: string }): Promise<unknown> {
    return this.request('POST', '/messages/send', params);
  }

  async readMessages(params?: { channel?: string; since?: string }): Promise<unknown> {
    return this.get('/messages/read', params as Record<string, string | undefined>);
  }

  async listMessages(params?: { thread_id?: string; task_id?: string; limit?: number }): Promise<unknown[]> {
    return this.get('/messages', {
      thread_id: params?.thread_id,
      task_id: params?.task_id,
      limit: params?.limit?.toString(),
    });
  }

  // ── Search ──

  async search(params: { q?: string; query?: string; source?: string; authorType?: string; limit?: number; offset?: number }): Promise<unknown> {
    return this.get('/search', {
      q: params.q || params.query,
      source: params.source,
      authorType: params.authorType,
      limit: params.limit?.toString(),
      offset: params.offset?.toString(),
    });
  }

  async searchSessions(query: string, limit = 20): Promise<{ count: number; results: unknown[] }> {
    return this.get('/search/sessions', { query, limit: String(limit) });
  }

  // ── Status ──

  async getStatus(): Promise<unknown> {
    return this.get('/status');
  }

  // ── Escalation ──

  async escalate(taskId: string, reason: string): Promise<unknown> {
    return this.request('POST', '/escalate', { taskId, reason });
  }

  // ── Discussion ──

  async discuss(topic: string, invitees?: string[]): Promise<unknown> {
    return this.request('POST', '/discuss', { topic, invitees });
  }

  // ── Learnings ──

  async addLearning(params: { category: string; content: string; tags?: string[] }): Promise<unknown> {
    return this.request('POST', '/learnings', params);
  }

  async searchLearnings(query: string): Promise<unknown> {
    return this.get('/learnings/search', { query });
  }

  // ── Memory ──

  async readMemory(filename: string): Promise<{ content: string } | null> {
    try {
      return await this.get(`/memory/${encodeURIComponent(filename)}`);
    } catch {
      return null;
    }
  }

  async writeMemory(filename: string, content: string): Promise<unknown> {
    return this.request('PUT', `/memory/${encodeURIComponent(filename)}`, { content });
  }

  async appendDailyLog(entry: string): Promise<unknown> {
    return this.request('POST', '/memory/daily-log', { entry });
  }

  // ── Decisions ──

  async logDecision(params: unknown): Promise<unknown> {
    return this.request('POST', '/decisions', params);
  }

  async listDecisions(params?: { taskId?: string; type?: string; status?: string; since?: string; limit?: number }): Promise<unknown[]> {
    return this.get('/decisions', params as Record<string, string | undefined>);
  }

  // ── Timers ──

  async setTimer(params: { label: string; delayMs: number; message: string; repeat?: boolean }): Promise<unknown> {
    return this.request('POST', '/timers', params);
  }

  async cancelTimer(label: string): Promise<unknown> {
    return this.request('DELETE', `/timers/${encodeURIComponent(label)}`);
  }

  async listTimers(): Promise<unknown[]> {
    return this.get('/timers');
  }

  // ── Cron ──

  async listCronJobs(): Promise<unknown[]> {
    return this.get('/cron');
  }

  async addCronJob(params: { name: string; schedule: string; prompt: string; tz?: string; skill?: string; enabled?: boolean }): Promise<unknown> {
    return this.request('POST', '/cron', params);
  }

  async enableCronJob(jobId: string): Promise<unknown> {
    return this.request('PUT', `/cron/${jobId}/enable`);
  }

  async disableCronJob(jobId: string): Promise<unknown> {
    return this.request('PUT', `/cron/${jobId}/disable`);
  }

  async removeCronJob(jobId: string): Promise<unknown> {
    return this.request('DELETE', `/cron/${jobId}`);
  }

  async runCronJob(jobId: string): Promise<unknown> {
    return this.request('POST', `/cron/${jobId}/run`);
  }

  // ── Specs ──

  async listSpecs(): Promise<unknown[]> {
    return this.get('/specs');
  }

  async createSpec(title: string, content: string): Promise<unknown> {
    return this.request('POST', '/specs', { title, content });
  }

  async getSpecChanges(): Promise<unknown[]> {
    return this.get('/spec-changes');
  }

  // ── Roles ──

  async listRoles(): Promise<unknown[]> {
    return this.get('/roles');
  }

  async getRoleInfo(roleId: string): Promise<unknown> {
    return this.get(`/roles/${roleId}`);
  }

  // ── Models ──

  async listModels(): Promise<unknown> {
    return this.get('/models');
  }

  async getModelConfig(): Promise<unknown> {
    return this.get('/models');
  }

  async setAgentModel(agentId: string, model: string, reason?: string): Promise<unknown> {
    return this.request('PUT', `/agents/${agentId}/model`, { model, reason });
  }

  async getModelsAvailable(): Promise<unknown> {
    return this.get('/models/available');
  }

  // ── Skills ──

  async listSkills(): Promise<unknown> {
    return this.get('/skills');
  }

  async installSkill(source: string): Promise<unknown> {
    return this.request('POST', '/skills/install', { source });
  }

  // ── Suggestions ──

  async listSuggestions(params?: { spec_id?: string; status?: string }): Promise<unknown[]> {
    return this.get('/suggestions', params as Record<string, string | undefined>);
  }

  async approveSuggestion(id: string): Promise<unknown> {
    return this.request('POST', `/suggestions/${id}/approve`);
  }

  async rejectSuggestion(id: string): Promise<unknown> {
    return this.request('POST', `/suggestions/${id}/reject`);
  }

  // ── Reports ──

  async getReport(since?: string): Promise<string> {
    const res = await fetch(this.url('/report') + (since ? `?since=${since}` : ''), {
      headers: this.headers(),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.text();
  }

  // ── Cost ──

  async getCostReport(): Promise<unknown> {
    return this.get('/cost');
  }

  // ── Threads ──

  async createThread(originId: string, title?: string): Promise<unknown> {
    return this.request('POST', '/threads', { origin_id: originId, title });
  }

  async listThreads(params?: { archived?: boolean; limit?: number }): Promise<unknown[]> {
    return this.get('/threads', {
      archived: params?.archived?.toString(),
      limit: params?.limit?.toString(),
    });
  }

  // ── Tool events ──

  async notifyToolCall(data: {
    toolName: string;
    agentId: string;
    input: unknown;
    output: unknown;
    status: 'running' | 'completed' | 'error';
    durationMs?: number;
    error?: string;
  }): Promise<void> {
    try {
      await this.request('POST', '/tool-events', data);
    } catch { /* best effort */ }
  }

  // ── Isolation ──

  async getIsolationStatus(): Promise<unknown> {
    return this.get('/isolation/status');
  }

  // ── Webhook ──

  async testWebhook(): Promise<unknown> {
    return this.request('POST', '/webhook/test');
  }

  // ── Runtimes ──

  async listRuntimes(): Promise<unknown[]> {
    return this.get('/runtimes');
  }
}
