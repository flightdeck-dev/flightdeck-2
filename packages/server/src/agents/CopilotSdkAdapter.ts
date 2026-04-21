/**
 * CopilotSdkAdapter — Spawns Copilot agents using @github/copilot-sdk.
 *
 * Instead of going through ACP (copilot --acp --stdio) and relying on
 * MCP server subprocesses for tools, this adapter:
 * 1. Uses CopilotClient to manage the CLI server lifecycle
 * 2. Injects flightdeck tools directly as session tools
 * 3. Tool handlers call the gateway HTTP API
 * 4. System prompt injected via systemMessage config
 *
 * This eliminates the MCP subprocess entirely for Copilot agents.
 */

import { CopilotClient, type CopilotSession, approveAll } from '@github/copilot-sdk';
import type { SessionConfig, SessionEvent, Tool } from '@github/copilot-sdk';
import type { AgentId, AgentRole, AgentRuntime } from '@flightdeck-ai/shared';
import { agentId as makeAgentId } from '@flightdeck-ai/shared';
import { getToolsForRole } from '../mcp/toolPermissions.js';
import { AgentAdapter, type SpawnOptions as BaseSpawnOptions, type SteerMessage, type AgentMetadata } from './AgentAdapter.js';

export interface CopilotSdkAdapterOptions {
  gatewayUrl?: string;
  defaultModel?: string;
  onUsage?: (agentId: string, usage: {
    model: string;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    cost: number;
    durationMs: number;
  }) => void;
  onContextWindow?: (agentId: string, info: {
    currentTokens: number;
    tokenLimit: number;
    messagesLength: number;
  }) => void;
}

export interface CopilotAgentSession {
  id: string;
  agentId: AgentId;
  role: AgentRole;
  session: CopilotSession;
  status: 'initializing' | 'active' | 'idle' | 'ended';
  output: string;
  startedAt: Date;
  lastActivityAt: Date;
  projectName?: string;
  cwd: string;
  model?: string;
}

export class CopilotSdkAdapter extends AgentAdapter {
  readonly runtime: AgentRuntime = 'acp';
  private client: CopilotClient | null = null;
  private sessions = new Map<string, CopilotAgentSession>();
  private gatewayUrl: string;
  private defaultModel?: string;
  private usageCallback: CopilotSdkAdapterOptions['onUsage'];
  onModelResolved: ((agentId: string, model: string) => void) | null = null;
  private contextWindowCallback: CopilotSdkAdapterOptions['onContextWindow'];

  /** Callback fired when a session ends. */
  onSessionEnd: ((sessionId: string, session: CopilotAgentSession) => void) | null = null;
  /** Callback fired when a session's prompt turn completes. */
  onSessionTurnStart: ((sessionId: string, agentId: string) => void) | null = null;
  onSessionTurnEnd: ((sessionId: string, agentId: string) => void) | null = null;
  /** Callback fired on any output. */
  onOutput: ((agentId: string, event: SessionEvent) => void) | null = null;

  constructor(options?: CopilotSdkAdapterOptions) {
    super();
    this.gatewayUrl = options?.gatewayUrl ?? process.env.FLIGHTDECK_URL ?? 'http://localhost:18800';
    this.defaultModel = options?.defaultModel;
    this.usageCallback = options?.onUsage;
    this.contextWindowCallback = options?.onContextWindow;
  }

  private async ensureClient(): Promise<CopilotClient> {
    if (!this.client) {
      this.client = new CopilotClient();
      await this.client.start();
    }
    return this.client;
  }

  /**
   * Build flightdeck tools that call the gateway HTTP API.
   */
  private buildTools(agentId: string, role: AgentRole, projectName?: string): Tool<any>[] {
    const baseUrl = `${this.gatewayUrl}/api/projects/${encodeURIComponent(projectName ?? 'default')}`;
    const headers = {
      'Content-Type': 'application/json',
      'X-Agent-Id': agentId,
      'X-Agent-Role': role,
    };

    const httpPost = async (path: string, body?: Record<string, unknown>) => {
      const res = await fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers,
        body: body ? JSON.stringify(body) : undefined,
      });
      return res.json();
    };

    const httpGet = async (path: string, params?: Record<string, string>) => {
      const url = new URL(`${baseUrl}${path}`);
      if (params) Object.entries(params).forEach(([k, v]) => { if (v) url.searchParams.set(k, v); });
      const res = await fetch(url.toString(), { headers });
      return res.json();
    };

    const httpPut = async (path: string, body?: Record<string, unknown>) => {
      const res = await fetch(`${baseUrl}${path}`, {
        method: 'PUT',
        headers,
        body: body ? JSON.stringify(body) : undefined,
      });
      return res.json();
    };

    const tools: Tool<any>[] = [];

    // Task tools
    tools.push({
      name: 'flightdeck_task_list',
      description: 'List tasks in the project. Optionally filter by state.',
      parameters: {
        type: 'object',
        properties: {
          state: { type: 'string', description: 'Filter by state (ready/running/in_review/done/failed)' },
        },
      },
      handler: async (args: { state?: string }) => {
        const params: Record<string, string> = {};
        if (args.state) params.state = args.state;
        return JSON.stringify(await httpGet('/tasks', params));
      },
      skipPermission: true,
    });

    tools.push({
      name: 'flightdeck_task_claim',
      description: 'Claim a ready task to work on.',
      parameters: {
        type: 'object',
        properties: { taskId: { type: 'string', description: 'Task ID to claim' } },
        required: ['taskId'],
      },
      handler: async (args: { taskId: string }) => {
        return JSON.stringify(await httpPost(`/tasks/${encodeURIComponent(args.taskId)}/claim`));
      },
      skipPermission: true,
    });

    tools.push({
      name: 'flightdeck_task_submit',
      description: 'Submit completed work for a task. REQUIRED after completing work.',
      parameters: {
        type: 'object',
        properties: {
          taskId: { type: 'string', description: 'Task ID' },
          claim: { type: 'string', description: 'Summary of what you did' },
        },
        required: ['taskId'],
      },
      handler: async (args: { taskId: string; claim?: string }) => {
        return JSON.stringify(await httpPost(`/tasks/${encodeURIComponent(args.taskId)}/submit`, { claim: args.claim }));
      },
      skipPermission: true,
    });

    tools.push({
      name: 'flightdeck_review_submit',
      description: 'Submit a review verdict for a task in review.',
      parameters: {
        type: 'object',
        properties: {
          taskId: { type: 'string', description: 'Task ID being reviewed' },
          verdict: { type: 'string', enum: ['approve', 'request_changes'], description: 'Review verdict' },
          comment: { type: 'string', description: 'Review feedback' },
        },
        required: ['taskId', 'verdict', 'comment'],
      },
      handler: async (args: { taskId: string; verdict: string; comment: string }) => {
        return JSON.stringify(await httpPost(`/tasks/${encodeURIComponent(args.taskId)}/review`, args));
      },
      skipPermission: true,
    });

    tools.push({
      name: 'flightdeck_task_comment',
      description: 'Add a comment to a task.',
      parameters: {
        type: 'object',
        properties: {
          taskId: { type: 'string', description: 'Task ID' },
          comment: { type: 'string', description: 'Comment text' },
        },
        required: ['taskId', 'comment'],
      },
      handler: async (args: { taskId: string; comment: string }) => {
        return JSON.stringify(await httpPost(`/tasks/${encodeURIComponent(args.taskId)}/comments`, { message: args.comment }));
      },
      skipPermission: true,
    });

    tools.push({
      name: 'flightdeck_escalate',
      description: 'Escalate an issue to the lead agent.',
      parameters: {
        type: 'object',
        properties: {
          taskId: { type: 'string', description: 'Related task ID' },
          reason: { type: 'string', description: 'Why you are escalating' },
        },
        required: ['reason'],
      },
      handler: async (args: { taskId?: string; reason: string }) => {
        return JSON.stringify(await httpPost('/escalate', args));
      },
      skipPermission: true,
    });

    tools.push({
      name: 'flightdeck_send',
      description: 'Send a message to another agent or channel.',
      parameters: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'Target agent ID' },
          channel: { type: 'string', description: 'Channel name (alternative to to)' },
          content: { type: 'string', description: 'Message content' },
        },
        required: ['content'],
      },
      handler: async (args: { to?: string; channel?: string; content: string }) => {
        return JSON.stringify(await httpPost('/messages/send', args));
      },
      skipPermission: true,
    });

    tools.push({
      name: 'flightdeck_search',
      description: 'Search across tasks, agents, messages, and memory.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' },
          source: { type: 'string', description: 'Filter: all/chat/memory/session' },
        },
        required: ['query'],
      },
      handler: async (args: { query: string; source?: string }) => {
        return JSON.stringify(await httpGet('/search', { q: args.query, source: args.source ?? '' }));
      },
      skipPermission: true,
    });

    tools.push({
      name: 'flightdeck_status',
      description: 'Get project status overview.',
      parameters: { type: 'object', properties: {} },
      handler: async () => {
        return JSON.stringify(await httpGet('/status'));
      },
      skipPermission: true,
    });

    // --- Additional tools based on role ---

    // Task management (worker + lead)
    tools.push({
      name: 'flightdeck_task_get',
      description: 'Get details of a specific task.',
      parameters: { type: 'object', properties: { taskId: { type: 'string' } }, required: ['taskId'] },
      handler: async (args: { taskId: string }) => JSON.stringify(await httpGet(`/tasks/${encodeURIComponent(args.taskId)}`)),
      skipPermission: true,
    });

    tools.push({
      name: 'flightdeck_task_fail',
      description: 'Report a task as failed.',
      parameters: { type: 'object', properties: { taskId: { type: 'string' }, reason: { type: 'string' } }, required: ['taskId'] },
      handler: async (args: { taskId: string; reason?: string }) => JSON.stringify(await httpPost(`/tasks/${encodeURIComponent(args.taskId)}/fail`, { reason: args.reason })),
      skipPermission: true,
    });

    // Memory (worker + lead)
    tools.push({
      name: 'flightdeck_memory_read',
      description: 'Read a project memory file.',
      parameters: { type: 'object', properties: { filename: { type: 'string', description: 'File path relative to memory/' } }, required: ['filename'] },
      handler: async (args: { filename: string }) => JSON.stringify(await httpGet(`/memory/${encodeURIComponent(args.filename)}`)),
      skipPermission: true,
    });

    tools.push({
      name: 'flightdeck_memory_write',
      description: 'Write to a project memory file.',
      parameters: { type: 'object', properties: { filename: { type: 'string' }, content: { type: 'string' } }, required: ['filename', 'content'] },
      handler: async (args: { filename: string; content: string }) => JSON.stringify(await httpPut(`/memory/${encodeURIComponent(args.filename)}`, { content: args.content })),
      skipPermission: true,
    });

    // Learnings
    tools.push({
      name: 'flightdeck_learning_add',
      description: 'Record a reusable learning or pattern.',
      parameters: { type: 'object', properties: { content: { type: 'string', description: 'The learning to record' }, tags: { type: 'string', description: 'Comma-separated tags' } }, required: ['content'] },
      handler: async (args: { content: string; tags?: string }) => JSON.stringify(await httpPost('/learnings', { content: args.content, tags: args.tags?.split(',').map((t: string) => t.trim()) })),
      skipPermission: true,
    });

    tools.push({
      name: 'flightdeck_learning_search',
      description: 'Search recorded learnings.',
      parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
      handler: async (args: { query: string }) => JSON.stringify(await httpGet('/learnings/search', { query: args.query })),
      skipPermission: true,
    });

    // Lead-only tools
    if (role === 'lead' || role === 'planner') {
      tools.push({
        name: 'flightdeck_task_add',
        description: 'Create a new task.',
        parameters: { type: 'object', properties: { title: { type: 'string' }, description: { type: 'string' }, role: { type: 'string' }, priority: { type: 'number' }, needsReview: { type: 'boolean' }, notifyLead: { type: 'boolean', description: 'If true, notify Lead when this task completes' } }, required: ['title'] },
        handler: async (args: any) => JSON.stringify(await httpPost('/tasks', args)),
        skipPermission: true,
      });

      tools.push({
        name: 'flightdeck_declare_tasks',
        description: 'Declare multiple tasks at once with dependencies.',
        parameters: { type: 'object', properties: { tasks: { type: 'array', items: { type: 'object' } } }, required: ['tasks'] },
        handler: async (args: { tasks: any[] }) => JSON.stringify(await httpPost('/tasks/declare', args)),
        skipPermission: true,
      });

      tools.push({
        name: 'flightdeck_agent_spawn',
        description: 'Spawn a new agent.',
        parameters: { type: 'object', properties: { role: { type: 'string' }, model: { type: 'string' }, runtime: { type: 'string' } }, required: ['role'] },
        handler: async (args: any) => JSON.stringify(await httpPost('/agents/spawn', args)),
        skipPermission: true,
      });

      tools.push({
        name: 'flightdeck_agent_list',
        description: 'List all agents.',
        parameters: { type: 'object', properties: {} },
        handler: async () => JSON.stringify(await httpGet('/agents')),
        skipPermission: true,
      });

      tools.push({
        name: 'flightdeck_agent_terminate',
        description: 'Terminate an agent.',
        parameters: { type: 'object', properties: { agentId: { type: 'string' } }, required: ['agentId'] },
        handler: async (args: { agentId: string }) => JSON.stringify(await httpPost(`/agents/${encodeURIComponent(args.agentId)}/terminate`)),
        skipPermission: true,
      });

      tools.push({
        name: 'flightdeck_task_complete',
        description: 'Complete a task (in_review → done).',
        parameters: { type: 'object', properties: { taskId: { type: 'string' } }, required: ['taskId'] },
        handler: async (args: { taskId: string }) => JSON.stringify(await httpPost(`/tasks/${encodeURIComponent(args.taskId)}/complete`)),
        skipPermission: true,
      });

      tools.push({
        name: 'flightdeck_task_pause',
        description: 'Pause a running task.',
        parameters: { type: 'object', properties: { taskId: { type: 'string' } }, required: ['taskId'] },
        handler: async (args: { taskId: string }) => JSON.stringify(await httpPost(`/tasks/${encodeURIComponent(args.taskId)}/pause`)),
        skipPermission: true,
      });

      tools.push({
        name: 'flightdeck_task_resume',
        description: 'Resume a paused task.',
        parameters: { type: 'object', properties: { taskId: { type: 'string' } }, required: ['taskId'] },
        handler: async (args: { taskId: string }) => JSON.stringify(await httpPost(`/tasks/${encodeURIComponent(args.taskId)}/resume`)),
        skipPermission: true,
      });


      tools.push({
        name: 'flightdeck_decision_log',
        description: 'Log a decision.',
        parameters: { type: 'object', properties: { taskId: { type: 'string' }, type: { type: 'string' }, title: { type: 'string' }, rationale: { type: 'string' } }, required: ['title', 'rationale'] },
        handler: async (args: any) => JSON.stringify(await httpPost('/decisions', args)),
        skipPermission: true,
      });

      tools.push({
        name: 'flightdeck_spec_create',
        description: 'Create a spec from requirements.',
        parameters: { type: 'object', properties: { title: { type: 'string' }, content: { type: 'string' } }, required: ['title', 'content'] },
        handler: async (args: { title: string; content: string }) => JSON.stringify(await httpPost('/specs', args)),
        skipPermission: true,
      });

      tools.push({
        name: 'flightdeck_task_cancel',
        description: 'Cancel a task.',
        parameters: { type: 'object', properties: { taskId: { type: 'string' }, reason: { type: 'string' } }, required: ['taskId'] },
        handler: async (args: { taskId: string; reason?: string }) => JSON.stringify(await httpPost(`/tasks/${encodeURIComponent(args.taskId)}/cancel`, { reason: args.reason })),
        skipPermission: true,
      });

      tools.push({
        name: 'flightdeck_task_skip',
        description: 'Skip a task.',
        parameters: { type: 'object', properties: { taskId: { type: 'string' }, reason: { type: 'string' } }, required: ['taskId'] },
        handler: async (args: { taskId: string; reason?: string }) => JSON.stringify(await httpPost(`/tasks/${encodeURIComponent(args.taskId)}/skip`, { reason: args.reason })),
        skipPermission: true,
      });

      tools.push({
        name: 'flightdeck_task_reopen',
        description: 'Reopen a completed or cancelled task.',
        parameters: { type: 'object', properties: { taskId: { type: 'string' } }, required: ['taskId'] },
        handler: async (args: { taskId: string }) => JSON.stringify(await httpPost(`/tasks/${encodeURIComponent(args.taskId)}/reopen`)),
        skipPermission: true,
      });

      tools.push({
        name: 'flightdeck_discuss',
        description: 'Create a focused discussion thread.',
        parameters: { type: 'object', properties: { topic: { type: 'string' }, context: { type: 'string' }, participants: { type: 'array', items: { type: 'string' } } }, required: ['topic'] },
        handler: async (args: any) => JSON.stringify(await httpPost('/discussions', args)),
        skipPermission: true,
      });
    }

    // Messaging (all roles)
    tools.push({
      name: 'flightdeck_read',
      description: 'Read messages from inbox or a channel.',
      parameters: { type: 'object', properties: { channel: { type: 'string' }, limit: { type: 'number' } } },
      handler: async (args: { channel?: string; limit?: number }) => JSON.stringify(await httpGet('/messages', { channel: args.channel ?? '', limit: String(args.limit ?? 20) })),
      skipPermission: true,
    });

    // Plan review (Lead only)
    tools.push({
      name: 'flightdeck_plan_review',
      description: 'Approve or reject a planned set of tasks.',
      parameters: { type: 'object', properties: { verdict: { type: 'string', enum: ['approve', 'reject'] }, specId: { type: 'string' }, message: { type: 'string' } }, required: ['verdict'] },
      handler: async (args: { verdict: string; specId?: string; message?: string }) => {
        const allTasks = await httpGet('/tasks') as any[];
        const planned = allTasks.filter((t: any) => t.state === 'planned' && (!args.specId || t.specId === args.specId));
        const targetState = args.verdict === 'approve' ? 'pending' : 'cancelled';
        let count = 0;
        for (const task of planned) {
          try { await httpPost(`/tasks/${encodeURIComponent(task.id)}/state`, { state: targetState }); count++; } catch {}
        }
        return JSON.stringify({ verdict: args.verdict, count, total: planned.length, message: args.message });
      },
      skipPermission: true,
    });

    // Task context (aggregated)
    tools.push({
      name: 'flightdeck_task_context',
      description: 'Get full working context for a task (deps, messages, decisions, learnings, spec).',
      parameters: { type: 'object', properties: { taskId: { type: 'string' }, include: { type: 'array', items: { type: 'string' } } }, required: ['taskId'] },
      handler: async (args: { taskId: string; include?: string[] }) => {
        const task = await httpGet(`/tasks/${encodeURIComponent(args.taskId)}`) as any;
        const result: Record<string, unknown> = { task };
        const inc = new Set(args.include ?? ['deps', 'messages', 'history']);
        const promises: Promise<void>[] = [];
        if (inc.has('deps') && task?.dependsOn?.length) {
          promises.push(Promise.all(task.dependsOn.map((id: string) => httpGet(`/tasks/${encodeURIComponent(id)}`))).then(deps => { result.deps = deps; }).catch(() => {}));
        }
        if (inc.has('messages')) {
          promises.push(httpGet('/messages', { task_id: args.taskId, limit: '20' }).then(msgs => { result.messages = msgs; }).catch(() => {}));
        }
        if (inc.has('history')) {
          promises.push(httpGet(`/tasks/${encodeURIComponent(args.taskId)}/comments`).then(c => { result.history = c; }).catch(() => {}));
        }
        await Promise.all(promises);
        return JSON.stringify(result);
      },
      skipPermission: true,
    });

    // File locks
    tools.push({
      name: 'flightdeck_file_lock',
      description: 'Acquire a lock on a file before modifying it.',
      parameters: { type: 'object', properties: { filePath: { type: 'string' }, reason: { type: 'string' } }, required: ['filePath'] },
      handler: async (args: { filePath: string; reason?: string }) => JSON.stringify(await httpPost('/file-locks', { filePath: args.filePath, reason: args.reason })),
      skipPermission: true,
    });
    tools.push({
      name: 'flightdeck_file_unlock',
      description: 'Release a file lock.',
      parameters: { type: 'object', properties: { filePath: { type: 'string' } }, required: ['filePath'] },
      handler: async (args: { filePath: string }) => {
        const res = await fetch(`${baseUrl}/file-locks/${encodeURIComponent(args.filePath)}`, { method: 'DELETE', headers, body: JSON.stringify({}) });
        return JSON.stringify(await res.json());
      },
      skipPermission: true,
    });
    tools.push({
      name: 'flightdeck_file_locks',
      description: 'List all active file locks.',
      parameters: { type: 'object', properties: {} },
      handler: async () => JSON.stringify(await httpGet('/file-locks')),
      skipPermission: true,
    });

    // Role listing
    tools.push({
      name: 'flightdeck_role_list',
      description: 'List available roles.',
      parameters: { type: 'object', properties: {} },
      handler: async () => JSON.stringify(await httpGet('/roles')),
      skipPermission: true,
    });

    tools.push({
      name: 'flightdeck_role_info',
      description: 'Get details about a role.',
      parameters: { type: 'object', properties: { roleId: { type: 'string' } }, required: ['roleId'] },
      handler: async (args: { roleId: string }) => JSON.stringify(await httpGet(`/roles/${encodeURIComponent(args.roleId)}`)),
      skipPermission: true,
    });

    // Agent lifecycle tools (missing from original SDK)
    tools.push({
      name: 'flightdeck_agent_output',
      description: 'Get the accumulated output of a running agent.',
      parameters: { type: 'object', properties: { targetAgentId: { type: 'string' }, tail: { type: 'number' } }, required: ['targetAgentId'] },
      handler: async (args: { targetAgentId: string; tail?: number }) => JSON.stringify(await httpGet(`/agents/${encodeURIComponent(args.targetAgentId)}/output`, { tail: String(args.tail ?? 50) })),
      skipPermission: true,
    });

    tools.push({
      name: 'flightdeck_agent_hibernate',
      description: 'Hibernate a worker — saves session, kills process, pauses assigned task.',
      parameters: { type: 'object', properties: { targetAgentId: { type: 'string' } }, required: ['targetAgentId'] },
      handler: async (args: { targetAgentId: string }) => JSON.stringify(await httpPost(`/agents/${encodeURIComponent(args.targetAgentId)}/hibernate`)),
      skipPermission: true,
    });

    tools.push({
      name: 'flightdeck_agent_wake',
      description: 'Wake a hibernated worker — resumes session, resumes task.',
      parameters: { type: 'object', properties: { targetAgentId: { type: 'string' } }, required: ['targetAgentId'] },
      handler: async (args: { targetAgentId: string }) => JSON.stringify(await httpPost(`/agents/${encodeURIComponent(args.targetAgentId)}/wake`)),
      skipPermission: true,
    });

    tools.push({
      name: 'flightdeck_agent_retire',
      description: 'Permanently dismiss a worker.',
      parameters: { type: 'object', properties: { targetAgentId: { type: 'string' } }, required: ['targetAgentId'] },
      handler: async (args: { targetAgentId: string }) => JSON.stringify(await httpPost(`/agents/${encodeURIComponent(args.targetAgentId)}/retire`)),
      skipPermission: true,
    });

    tools.push({
      name: 'flightdeck_agent_restart',
      description: 'Restart an agent.',
      parameters: { type: 'object', properties: { targetAgentId: { type: 'string' } }, required: ['targetAgentId'] },
      handler: async (args: { targetAgentId: string }) => JSON.stringify(await httpPost(`/agents/${encodeURIComponent(args.targetAgentId)}/restart`)),
      skipPermission: true,
    });

    tools.push({
      name: 'flightdeck_agent_interrupt',
      description: 'Send urgent message to an agent.',
      parameters: { type: 'object', properties: { targetAgentId: { type: 'string' }, message: { type: 'string' } }, required: ['targetAgentId', 'message'] },
      handler: async (args: { targetAgentId: string; message: string }) => JSON.stringify(await httpPost(`/agents/${encodeURIComponent(args.targetAgentId)}/interrupt`, { message: args.message })),
      skipPermission: true,
    });

    // Task tools (missing from original SDK)
    tools.push({
      name: 'flightdeck_task_retry',
      description: 'Retry a failed task.',
      parameters: { type: 'object', properties: { taskId: { type: 'string' } }, required: ['taskId'] },
      handler: async (args: { taskId: string }) => JSON.stringify(await httpPost(`/tasks/${encodeURIComponent(args.taskId)}/retry`)),
      skipPermission: true,
    });

    tools.push({
      name: 'flightdeck_task_compact',
      description: 'Compact a completed task to save context.',
      parameters: { type: 'object', properties: { taskId: { type: 'string' }, summary: { type: 'string' } }, required: ['taskId'] },
      handler: async (args: { taskId: string; summary?: string }) => JSON.stringify(await httpPost(`/tasks/${encodeURIComponent(args.taskId)}/compact`, { summary: args.summary })),
      skipPermission: true,
    });

    tools.push({
      name: 'flightdeck_task_clear_stale',
      description: 'Clear stale flag on a task after re-planning.',
      parameters: { type: 'object', properties: { taskId: { type: 'string' } }, required: ['taskId'] },
      handler: async (args: { taskId: string }) => JSON.stringify(await httpPost(`/tasks/${encodeURIComponent(args.taskId)}/clear-stale`)),
      skipPermission: true,
    });

    tools.push({
      name: 'flightdeck_declare_subtasks',
      description: 'Declare sub-tasks under a parent task.',
      parameters: { type: 'object', properties: { parentTaskId: { type: 'string' }, tasks: { type: 'array', items: { type: 'object' } } }, required: ['parentTaskId', 'tasks'] },
      handler: async (args: { parentTaskId: string; tasks: any[] }) => JSON.stringify(await httpPost(`/tasks/${encodeURIComponent(args.parentTaskId)}/subtasks`, { tasks: args.tasks })),
      skipPermission: true,
    });

    // Communication tools (missing)
    tools.push({
      name: 'flightdeck_msg_list',
      description: 'List chat messages.',
      parameters: { type: 'object', properties: { threadId: { type: 'string' }, taskId: { type: 'string' }, limit: { type: 'number' } } },
      handler: async (args: { threadId?: string; taskId?: string; limit?: number }) => JSON.stringify(await httpGet('/messages', { thread_id: args.threadId ?? '', task_id: args.taskId ?? '', limit: String(args.limit ?? 20) })),
      skipPermission: true,
    });

    tools.push({
      name: 'flightdeck_thread_create',
      description: 'Create a chat thread from a message.',
      parameters: { type: 'object', properties: { originId: { type: 'string' }, title: { type: 'string' } }, required: ['originId'] },
      handler: async (args: { originId: string; title?: string }) => JSON.stringify(await httpPost('/threads', { originId: args.originId, title: args.title })),
      skipPermission: true,
    });

    tools.push({
      name: 'flightdeck_thread_list',
      description: 'List chat threads.',
      parameters: { type: 'object', properties: { archived: { type: 'boolean' }, limit: { type: 'number' } } },
      handler: async (args: { archived?: boolean; limit?: number }) => JSON.stringify(await httpGet('/threads', { archived: String(args.archived ?? false), limit: String(args.limit ?? 20) })),
      skipPermission: true,
    });

    // Memory tools (missing)
    tools.push({
      name: 'flightdeck_memory_log',
      description: "Append an entry to today's daily log (append-only).",
      parameters: { type: 'object', properties: { entry: { type: 'string' } }, required: ['entry'] },
      handler: async (args: { entry: string }) => JSON.stringify(await httpPost('/memory/daily-log', { entry: args.entry })),
      skipPermission: true,
    });

    // Decision tools (missing)
    tools.push({
      name: 'flightdeck_decision_list',
      description: 'List recent decisions.',
      parameters: { type: 'object', properties: { taskId: { type: 'string' }, type: { type: 'string' }, limit: { type: 'number' } } },
      handler: async (args: { taskId?: string; type?: string; limit?: number }) => JSON.stringify(await httpGet('/decisions', { taskId: args.taskId ?? '', type: args.type ?? '', limit: String(args.limit ?? 20) })),
      skipPermission: true,
    });

    // Report tool (missing)
    tools.push({
      name: 'flightdeck_report',
      description: 'Generate daily report.',
      parameters: { type: 'object', properties: { since: { type: 'string' } } },
      handler: async (args: { since?: string }) => JSON.stringify(await httpGet('/report', { since: args.since ?? '' })),
      skipPermission: true,
    });

    // Escalate to human (missing)
    tools.push({
      name: 'flightdeck_escalate_to_human',
      description: 'Escalate an issue to the human user.',
      parameters: { type: 'object', properties: { title: { type: 'string' }, description: { type: 'string' }, priority: { type: 'string' } }, required: ['title', 'description'] },
      handler: async (args: { title: string; description: string; priority?: string }) => JSON.stringify(await httpPost('/escalate', { ...args, toHuman: true })),
      skipPermission: true,
    });

    // Model tools (missing)
    tools.push({
      name: 'flightdeck_model_list',
      description: 'List available models and runtimes.',
      parameters: { type: 'object', properties: {} },
      handler: async () => JSON.stringify(await httpGet('/models/available')),
      skipPermission: true,
    });

    tools.push({
      name: 'flightdeck_model_set',
      description: "Change a running agent's model.",
      parameters: { type: 'object', properties: { agentId: { type: 'string' }, model: { type: 'string' }, reason: { type: 'string' } }, required: ['agentId', 'model'] },
      handler: async (args: { agentId: string; model: string; reason?: string }) => JSON.stringify(await httpPut(`/agents/${encodeURIComponent(args.agentId)}/model`, { model: args.model, reason: args.reason })),
      skipPermission: true,
    });

    tools.push({
      name: 'flightdeck_model_config',
      description: 'Get current model configuration per role.',
      parameters: { type: 'object', properties: {} },
      handler: async () => JSON.stringify(await httpGet('/models')),
      skipPermission: true,
    });

    // Spec tools (missing)
    tools.push({
      name: 'flightdeck_spec_list',
      description: 'List specs.',
      parameters: { type: 'object', properties: {} },
      handler: async () => JSON.stringify(await httpGet('/specs')),
      skipPermission: true,
    });

    tools.push({
      name: 'flightdeck_spec_cancel',
      description: 'Cancel a spec and all its incomplete tasks.',
      parameters: { type: 'object', properties: { specId: { type: 'string', description: 'Spec ID to cancel' } }, required: ['specId'] },
      handler: async (args: { specId: string }) => JSON.stringify(await httpPost(`/specs/${encodeURIComponent(args.specId)}/cancel`, {})),
    });

    tools.push({
      name: 'flightdeck_spec_changes',
      description: 'List recent spec changes.',
      parameters: { type: 'object', properties: {} },
      handler: async () => JSON.stringify(await httpGet('/spec-changes')),
      skipPermission: true,
    });

    // Skill tools (missing)
    tools.push({
      name: 'flightdeck_skill_list',
      description: 'List available skills.',
      parameters: { type: 'object', properties: {} },
      handler: async () => JSON.stringify(await httpGet('/skills')),
      skipPermission: true,
    });

    tools.push({
      name: 'flightdeck_skill_install',
      description: 'Install a skill from a source directory.',
      parameters: { type: 'object', properties: { source: { type: 'string' } }, required: ['source'] },
      handler: async (args: { source: string }) => JSON.stringify(await httpPost('/skills/install', { source: args.source })),
      skipPermission: true,
    });

    // Suggestion tools (missing)
    tools.push({
      name: 'flightdeck_suggestion_list',
      description: 'List scout suggestions.',
      parameters: { type: 'object', properties: { specId: { type: 'string' }, status: { type: 'string' } } },
      handler: async (args: { specId?: string; status?: string }) => JSON.stringify(await httpGet('/suggestions', { spec_id: args.specId ?? '', status: args.status ?? '' })),
      skipPermission: true,
    });

    tools.push({
      name: 'flightdeck_suggestion_approve',
      description: 'Approve a scout suggestion.',
      parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      handler: async (args: { id: string }) => JSON.stringify(await httpPost(`/suggestions/${encodeURIComponent(args.id)}/approve`)),
      skipPermission: true,
    });

    tools.push({
      name: 'flightdeck_suggestion_reject',
      description: 'Reject a scout suggestion.',
      parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      handler: async (args: { id: string }) => JSON.stringify(await httpPost(`/suggestions/${encodeURIComponent(args.id)}/reject`)),
      skipPermission: true,
    });

    // Timer tools (missing)
    tools.push({
      name: 'flightdeck_timer_set',
      description: 'Set a timer.',
      parameters: { type: 'object', properties: { label: { type: 'string' }, delayMs: { type: 'number' }, message: { type: 'string' }, repeat: { type: 'boolean' } }, required: ['label', 'delayMs', 'message'] },
      handler: async (args: any) => JSON.stringify(await httpPost('/timers', args)),
      skipPermission: true,
    });

    tools.push({
      name: 'flightdeck_timer_cancel',
      description: 'Cancel a timer.',
      parameters: { type: 'object', properties: { label: { type: 'string' } }, required: ['label'] },
      handler: async (args: { label: string }) => {
        const res = await fetch(`${baseUrl}/timers/${encodeURIComponent(args.label)}`, { method: 'DELETE', headers });
        return JSON.stringify(await res.json());
      },
      skipPermission: true,
    });

    tools.push({
      name: 'flightdeck_timer_list',
      description: 'List timers.',
      parameters: { type: 'object', properties: {} },
      handler: async () => JSON.stringify(await httpGet('/timers')),
      skipPermission: true,
    });

    // Cron tools (missing)
    tools.push({
      name: 'flightdeck_cron_list',
      description: 'List all cron jobs.',
      parameters: { type: 'object', properties: {} },
      handler: async () => JSON.stringify(await httpGet('/cron')),
      skipPermission: true,
    });

    tools.push({
      name: 'flightdeck_cron_add',
      description: 'Add a new cron job.',
      parameters: { type: 'object', properties: { name: { type: 'string' }, schedule: { type: 'string' }, prompt: { type: 'string' }, tz: { type: 'string' }, enabled: { type: 'boolean' } }, required: ['name', 'schedule', 'prompt'] },
      handler: async (args: any) => JSON.stringify(await httpPost('/cron', args)),
      skipPermission: true,
    });

    tools.push({
      name: 'flightdeck_cron_enable',
      description: 'Enable a cron job.',
      parameters: { type: 'object', properties: { jobId: { type: 'string' } }, required: ['jobId'] },
      handler: async (args: { jobId: string }) => JSON.stringify(await httpPut(`/cron/${encodeURIComponent(args.jobId)}/enable`)),
      skipPermission: true,
    });

    tools.push({
      name: 'flightdeck_cron_disable',
      description: 'Disable a cron job.',
      parameters: { type: 'object', properties: { jobId: { type: 'string' } }, required: ['jobId'] },
      handler: async (args: { jobId: string }) => JSON.stringify(await httpPut(`/cron/${encodeURIComponent(args.jobId)}/disable`)),
      skipPermission: true,
    });

    tools.push({
      name: 'flightdeck_cron_remove',
      description: 'Remove a cron job.',
      parameters: { type: 'object', properties: { jobId: { type: 'string' } }, required: ['jobId'] },
      handler: async (args: { jobId: string }) => {
        const res = await fetch(`${baseUrl}/cron/${encodeURIComponent(args.jobId)}`, { method: 'DELETE', headers });
        return JSON.stringify(await res.json());
      },
      skipPermission: true,
    });

    tools.push({
      name: 'flightdeck_cron_run',
      description: 'Manually trigger a cron job now.',
      parameters: { type: 'object', properties: { jobId: { type: 'string' } }, required: ['jobId'] },
      handler: async (args: { jobId: string }) => JSON.stringify(await httpPost(`/cron/${encodeURIComponent(args.jobId)}/run`)),
      skipPermission: true,
    });

    // Misc tools (missing)
    tools.push({
      name: 'flightdeck_isolation_status',
      description: 'Show current isolation mode and active worktrees/workdirs.',
      parameters: { type: 'object', properties: {} },
      handler: async () => JSON.stringify(await httpGet('/isolation/status')),
      skipPermission: true,
    });

    tools.push({
      name: 'flightdeck_webhook_test',
      description: 'Send a test message to all configured webhooks.',
      parameters: { type: 'object', properties: {} },
      handler: async () => JSON.stringify(await httpPost('/webhook/test')),
      skipPermission: true,
    });

    // Tools available (self-report)
    tools.push({
      name: 'flightdeck_tools_available',
      description: 'List your available tools and role.',
      parameters: { type: 'object', properties: {} },
      handler: async () => {
        const allowed = getToolsForRole(role);
        return JSON.stringify({ role, tools: allowed });
      },
      skipPermission: true,
    });

    // Filter by role permissions
    const allowedTools = new Set(getToolsForRole(role));
    return tools.filter(t => allowedTools.has(t.name));
  }

  /**
   * Spawn a new Copilot agent session with flightdeck tools injected.
   */
  async spawn(opts: BaseSpawnOptions): Promise<AgentMetadata> {
    const client = await this.ensureClient();
    const aid = (opts.agentId ?? makeAgentId(opts.role, Date.now().toString())) as AgentId;

    const tools = this.buildTools(aid, opts.role, opts.projectName);

    // Generate a stable session ID that we control.
    // Per Copilot SDK docs: providing your own sessionId is required for resumable sessions.
    // Without it, the SDK generates a random ID and the session can't be resumed later.
    // Format: fd-{agentId} — deterministic, maps 1:1 to the agent.
    const sessionId = `fd-${aid}`;

    const sessionConfig: SessionConfig = {
      sessionId,
      model: opts.model ?? this.defaultModel,
      streaming: true,
      systemMessage: opts.systemPrompt
        ? { mode: 'append', content: opts.systemPrompt }
        : undefined,
      tools,
      onPermissionRequest: approveAll,
    };

    const session = await client.createSession(sessionConfig);

    const agentSession: CopilotAgentSession = {
      id: sessionId,
      agentId: aid,
      role: opts.role,
      session,
      status: 'active',
      output: '',
      startedAt: new Date(),
      lastActivityAt: new Date(),
      projectName: opts.projectName,
      cwd: opts.cwd,
      model: opts.model,
    };

    this.sessions.set(sessionId, agentSession);

    // Wire up event handlers
    session.on((event: SessionEvent) => {
      agentSession.lastActivityAt = new Date();

      // Capture resolved model from session.created event
      if ((event.type as string) === 'session.created' && (event as any).data?.selectedModel) {
        agentSession.model = (event as any).data.selectedModel;
        if (this.onModelResolved) {
          try { this.onModelResolved(agentSession.agentId, (event as any).data.selectedModel); } catch { /* */ }
        }
      }

      if (event.type === 'assistant.message') {
        agentSession.output += event.data.content;
        agentSession.status = 'active';
      }

      if (event.type === 'session.idle') {
        agentSession.status = 'idle';
        if (this.onSessionTurnEnd) {
          try { this.onSessionTurnEnd(sessionId, aid); } catch { /* */ }
        }
      }

      if (event.type === 'session.error') {
        console.error(`[CopilotSdk] Session ${sessionId} error: ${event.data.message}`);
      }

      if (event.type === 'session.shutdown' as any) {
        agentSession.status = 'ended';
        if (this.onSessionEnd) {
          try { this.onSessionEnd(sessionId, agentSession); } catch { /* */ }
        }
      }

      // Track per-call token usage
      if ((event as any).type === 'assistant.usage' && this.usageCallback) {
        const data = (event as any).data;
        try {
          this.usageCallback(aid, {
            model: data.model ?? '',
            inputTokens: data.inputTokens ?? 0,
            outputTokens: data.outputTokens ?? 0,
            cacheReadTokens: data.cacheReadTokens ?? 0,
            cacheWriteTokens: data.cacheWriteTokens ?? 0,
            cost: data.cost ?? 0,
            durationMs: data.durationMs ?? 0,
          });
        } catch { /* */ }
      }

      // Track context window utilization
      if ((event as any).type === 'session.usage_info' && this.contextWindowCallback) {
        const data = (event as any).data;
        try {
          this.contextWindowCallback(aid, {
            currentTokens: data.currentTokens ?? 0,
            tokenLimit: data.tokenLimit ?? 0,
            messagesLength: data.messagesLength ?? 0,
          });
        } catch { /* */ }
      }

      if (this.onOutput) {
        try { this.onOutput(aid, event); } catch { /* */ }
      }
    });

    // Try to get resolved model from session history (session.created event may have fired during createSession)
    try {
      const events = await session.getMessages();
      const createdEvent = events.find((e: any) => e.type === 'session.created');
      if (createdEvent && (createdEvent as any).data?.selectedModel) {
        agentSession.model = (createdEvent as any).data.selectedModel;
        if (this.onModelResolved) {
          try { this.onModelResolved(aid, agentSession.model!); } catch { /* */ }
        }
      }
    } catch { /* best effort */ }

    return { agentId: aid, sessionId: sessionId, status: 'running' as const, model: agentSession.model ?? opts.model };
  }

  /**
   */
  async steer(sessionId: string, message: SteerMessage): Promise<string> {
    const agentSession = this.sessions.get(sessionId);
    if (!agentSession) throw new Error(`Session not found: ${sessionId}`);
    if (agentSession.status === 'ended') throw new Error(`Session ended: ${sessionId}`);

    const outputBefore = agentSession.output.length;
    agentSession.status = 'active';

    // Notify turn start
    if (this.onSessionTurnStart) {
      try { this.onSessionTurnStart(sessionId, agentSession.agentId); } catch { /* */ }
    }

    await agentSession.session.send({ prompt: message.content });

    // Wait for idle (turn complete)
    await new Promise<void>((resolve) => {
      const handler = (event: SessionEvent) => {
        if (event.type === 'session.idle') {
          resolve();
        }
      };
      agentSession.session.on(handler);
      // Timeout after 5 minutes
      setTimeout(() => resolve(), 5 * 60 * 1000);
    });

    return agentSession.output.slice(outputBefore);
  }

  /**
   * Kill a session.
   */
  async kill(sessionId: string): Promise<void> {
    const agentSession = this.sessions.get(sessionId);
    if (!agentSession) return;
    try {
      await agentSession.session.disconnect();
    } catch { /* */ }
    agentSession.status = 'ended';
    // Clean up after grace period
    setTimeout(() => this.sessions.delete(sessionId), 60_000);
  }

  async getMetadata(sessionId: string): Promise<AgentMetadata | null> {
    const s = this.sessions.get(sessionId);
    if (!s) return null;
    return {
      agentId: s.agentId,
      sessionId: s.id,
      status: s.status === 'ended' ? 'ended' : s.status === 'idle' ? 'idle' : 'running',
    };
  }

  override getSession(sessionId: string): { output: string } | undefined {
    const s = this.sessions.get(sessionId);
    return s ? { output: s.output } : undefined;
  }

  /**
   * Resume a previous Copilot SDK session.
   */
  override async resumeSession(opts: {
    previousSessionId: string;
    cwd: string;
    role: string;
    agentId?: string;
    model?: string;
    projectName?: string;
  }): Promise<import('./AgentAdapter.js').AgentMetadata> {
    const client = await this.ensureClient();
    const aid = (opts.agentId ?? makeAgentId(opts.role, Date.now().toString())) as AgentId;
    const tools = this.buildTools(aid, opts.role as AgentRole, opts.projectName);

    const session = await client.resumeSession(opts.previousSessionId, {
      model: opts.model ?? this.defaultModel,
      streaming: true,
      tools,
      onPermissionRequest: approveAll,
    });

    // Use the same session ID we originally created (passed as previousSessionId)
    const sessionId = opts.previousSessionId;
    const agentSession: CopilotAgentSession = {
      id: sessionId,
      agentId: aid,
      role: opts.role as AgentRole,
      session,
      status: 'active',
      output: '',
      startedAt: new Date(),
      lastActivityAt: new Date(),
      projectName: opts.projectName,
      cwd: opts.cwd,
      model: opts.model,
    };

    this.sessions.set(sessionId, agentSession);

    // Wire same event handlers as spawn
    session.on((event: SessionEvent) => {
      agentSession.lastActivityAt = new Date();
      if (event.type === 'assistant.message') {
        agentSession.output += event.data.content;
        agentSession.status = 'active';
      }
      if (event.type === 'session.idle') {
        agentSession.status = 'idle';
        if (this.onSessionTurnEnd) {
          try { this.onSessionTurnEnd(sessionId, aid); } catch { /* */ }
        }
      }
      if ((event as any).type === 'session.shutdown') {
        agentSession.status = 'ended';
        if (this.onSessionEnd) {
          try { this.onSessionEnd(sessionId, agentSession); } catch { /* */ }
        }
      }
      if ((event as any).type === 'assistant.usage' && this.usageCallback) {
        const data = (event as any).data;
        try {
          this.usageCallback(aid, {
            model: data.model ?? '', inputTokens: data.inputTokens ?? 0,
            outputTokens: data.outputTokens ?? 0, cacheReadTokens: data.cacheReadTokens ?? 0,
            cacheWriteTokens: data.cacheWriteTokens ?? 0, cost: data.cost ?? 0, durationMs: data.durationMs ?? 0,
          });
        } catch { /* */ }
      }
      if ((event as any).type === 'session.usage_info' && this.contextWindowCallback) {
        const data = (event as any).data;
        try {
          this.contextWindowCallback(aid, {
            currentTokens: data.currentTokens ?? 0, tokenLimit: data.tokenLimit ?? 0, messagesLength: data.messagesLength ?? 0,
          });
        } catch { /* */ }
      }
      if (this.onOutput) { try { this.onOutput(aid, event); } catch { /* */ } }
    });

    return { agentId: aid, sessionId: sessionId, status: 'running' as const };
  }

  /**
   * Discover available models from the Copilot SDK.
   * Returns model list for registration in ModelRegistry.
   */
  async discoverModels(): Promise<Array<{ modelId: string; name: string }>> {
    try {
      const client = await this.ensureClient();
      const models = await client.listModels();
      return models.map(m => ({ modelId: m.id, name: m.name }));
    } catch (err) {
      console.error('[CopilotSdk] Failed to discover models:', err instanceof Error ? err.message : String(err));
      return [];
    }
  }

  /**
   * Stop the Copilot CLI server and clean up all sessions.
   */
  async shutdown(): Promise<void> {
    for (const session of this.sessions.values()) {
      try { await session.session.disconnect(); } catch { /* */ }
    }
    this.sessions.clear();
    if (this.client) {
      try { await this.client.stop(); } catch { /* */ }
      this.client = null;
    }
  }
}
