import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import type { AgentRole } from '@flightdeck-ai/shared';
import { GatewayClient } from './gateway-client.js';
import { getToolsForRole } from './toolPermissions.js';
import { AsyncLocalStorage } from 'node:async_hooks';

/** Lazily read agent ID from env (allows tests to set it after import) */
function getEnvAgentId(): string | undefined {
  return process.env.FLIGHTDECK_AGENT_ID || undefined;
}
const ENV_AGENT_ROLE = process.env.FLIGHTDECK_AGENT_ROLE || undefined;
const ENV_PROJECT = process.env.FLIGHTDECK_PROJECT || undefined;

// AsyncLocalStorage to track tool call context for notifications
const toolCallContext = new AsyncLocalStorage<{
  toolName: string;
  agentId: string;
  input: unknown;
  startTime: number;
  client: GatewayClient;
}>();

function errorResponse(text: string) {
  const ctx = toolCallContext.getStore();
  if (ctx) {
    ctx.client.notifyToolCall({
      toolName: ctx.toolName,
      agentId: ctx.agentId,
      input: ctx.input,
      output: null,
      status: 'error',
      error: text,
      durationMs: Date.now() - ctx.startTime,
    });
  }
  return { content: [{ type: 'text' as const, text }] };
}

function jsonResponse(data: unknown) {
  const ctx = toolCallContext.getStore();
  if (ctx) {
    ctx.client.notifyToolCall({
      toolName: ctx.toolName,
      agentId: ctx.agentId,
      input: ctx.input,
      output: data,
      status: 'completed',
      durationMs: Date.now() - ctx.startTime,
    });
  }
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

function resolveCallerId(): string {
  return getEnvAgentId() ?? 'unknown';
}

function requireAgentId(): { agentId: string } | { error: ReturnType<typeof errorResponse> } {
  const id = getEnvAgentId();
  if (!id) {
    return { error: errorResponse('Error: FLIGHTDECK_AGENT_ID env var not set. Cannot identify caller.') };
  }
  return { agentId: id };
}

export interface McpServerOptions {
  projectName?: string;
  agentRole?: string;
}

export function createMcpServer(projectNameOrOpts?: string | McpServerOptions): McpServer {
  const opts = typeof projectNameOrOpts === 'string'
    ? { projectName: projectNameOrOpts }
    : projectNameOrOpts ?? {};

  // Set env vars if provided via opts so GatewayClient picks them up
  if (opts.projectName && !process.env.FLIGHTDECK_PROJECT) {
    process.env.FLIGHTDECK_PROJECT = opts.projectName;
  }

  const client = new GatewayClient();
  const projectName = client.projectName || ENV_PROJECT;

  if (!projectName) {
    throw new Error('No Flightdeck project found. Set FLIGHTDECK_PROJECT env var or pass --project.');
  }

  // Only fall back to ENV_AGENT_ROLE when called with no arguments at all (CLI entry point).
  const agentRole = projectNameOrOpts === undefined
    ? (ENV_AGENT_ROLE ?? undefined)
    : opts.agentRole;

  const server = new McpServer({ name: 'flightdeck', version: '2.0.0' });

  // Wrap server.tool to inject AsyncLocalStorage context for tool call notifications
  const originalTool = server.tool.bind(server);
  server.tool = ((...args: any[]) => {
    const toolName = args[0] as string;
    const handlerIdx = args.length - 1;
    const originalHandler = args[handlerIdx];
    args[handlerIdx] = (params: any) => {
      const agentId = getEnvAgentId() || 'unknown';
      return toolCallContext.run(
        { toolName, agentId, input: params, startTime: Date.now(), client },
        () => {
          client.notifyToolCall({ toolName, agentId, input: params, output: null, status: 'running' });
          return originalHandler(params);
        }
      );
    };
    return (originalTool as any)(...args);
  }) as typeof server.tool;

  // ── Task tools ──

  server.tool('flightdeck_task_list', 'List tasks for the project (shows hierarchy for epics). Filter by state, role, or assignee.', {
    specId: z.string().optional(),
    state: z.enum(['pending', 'ready', 'running', 'in_review', 'done', 'failed', 'skipped', 'cancelled', 'gated', 'paused']).optional().describe('Filter by task state'),
    role: z.string().optional().describe('Filter by assigned role'),
    assignedAgent: z.string().optional().describe('Filter by assigned agent ID'),
  }, async (params) => {
    try {
      const tasks = await client.listTasks(params) as any[];
      // Group tasks: top-level first, then indent sub-tasks under their parent
      const topLevel = tasks.filter(t => t.parentTaskId === null);
      const byParent = new Map<string, typeof tasks>();
      for (const t of tasks) {
        if (t.parentTaskId) {
          if (!byParent.has(t.parentTaskId)) byParent.set(t.parentTaskId, []);
          byParent.get(t.parentTaskId)!.push(t);
        }
      }
      const result: Array<Record<string, unknown>> = [];
      for (const t of topLevel) {
        const children = byParent.get(t.id);
        if (children && children.length > 0) {
          const doneCount = children.filter((c: any) => c.state === 'done' || c.state === 'skipped').length;
          result.push({ ...t, _epic: true, _progress: `${doneCount}/${children.length} done`, subTasks: children });
        } else {
          result.push(t as unknown as Record<string, unknown>);
        }
      }
      return jsonResponse(result);
    } catch (err) {
      return errorResponse(`Error: ${(err as Error).message}`);
    }
  });

  server.tool('flightdeck_task_get', 'Get details for a single task', {
    taskId: z.string(),
  }, async (params) => {
    try {
      const task = await client.getTask(params.taskId);
      if (!task) return errorResponse(`Task not found: ${params.taskId}`);
      return jsonResponse(task);
    } catch (err) {
      return errorResponse(`Error: ${(err as Error).message}`);
    }
  });

  server.tool('flightdeck_task_context', 'Get full working context for a task — aggregates task details, dependency states, messages, decisions, learnings, and spec in one call', {
    taskId: z.string(),
    include: z.array(z.enum(['deps', 'messages', 'decisions', 'learnings', 'spec', 'history'])).optional().describe('What to include. Default: all.'),
  }, async (params) => {
    try {
      const task = await client.getTask(params.taskId);
      if (!task) return errorResponse(`Task not found: ${params.taskId}`);
      const t = task as any;
      const include = new Set(params.include ?? ['deps', 'messages', 'decisions', 'learnings', 'spec', 'history']);
      const result: Record<string, unknown> = { task };

      const promises: Array<Promise<void>> = [];

      if (include.has('deps') && t.dependsOn?.length) {
        promises.push(
          Promise.all(t.dependsOn.map((id: string) => client.getTask(id)))
            .then(deps => { result.deps = (deps as any[]).map(d => ({ id: d?.id, title: d?.title, state: d?.state, claim: d?.claim })); })
            .catch(() => { result.deps = []; })
        );
      }
      if (include.has('messages')) {
        promises.push(
          client.listMessages({ taskId: params.taskId }).then(msgs => { result.messages = msgs; }).catch(() => { result.messages = []; })
        );
      }
      if (include.has('decisions')) {
        promises.push(
          client.listDecisions().then(decs => {
            result.decisions = (decs as any[]).filter(d => d.taskId === params.taskId);
          }).catch(() => { result.decisions = []; })
        );
      }
      if (include.has('learnings')) {
        promises.push(
          client.searchLearnings(t.title ?? '').then(l => { result.learnings = l; }).catch(() => { result.learnings = []; })
        );
      }
      if (include.has('spec') && t.specId) {
        promises.push(
          client.getSpec(t.specId).then(s => { result.spec = s; }).catch(() => {})
        );
      }
      if (include.has('history')) {
        // Previous submissions from task comments
        promises.push(
          client.listTaskComments(params.taskId).then(comments => {
            result.previousSubmissions = (comments as any[]).filter(c => c.type === 'submission' || c.type === 'review');
          }).catch(() => { result.previousSubmissions = []; })
        );
      }

      await Promise.all(promises);
      return jsonResponse(result);
    } catch (err) {
      return errorResponse(`Error: ${(err as Error).message}`);
    }
  });

  server.tool('flightdeck_task_add', 'Add a new task to the DAG', {
    title: z.string(),
    description: z.string().optional(),
    specId: z.string().optional(),
    role: z.enum(['lead', 'planner', 'worker', 'reviewer', 'product-thinker', 'qa-tester', 'tech-writer']).optional(),
    dependsOn: z.array(z.string()).optional(),
    priority: z.number().optional(),
    needsReview: z.boolean().optional().describe('If false, skip review and auto-complete on submit. Default: true.'),
      notifyLead: z.boolean().optional().describe('If true, notify Lead when this task completes. Default: false.'),
      acceptanceCriteria: z.string().optional().describe('What done looks like. Shown to worker and reviewer.'),
      context: z.string().optional().describe('Additional context: references, code snippets, related files.'),
  }, async (params) => {
    const resolved = requireAgentId();
    if ('error' in resolved) return resolved.error;
    try {
      const task = await client.addTask(params);
      return jsonResponse(task);
    } catch (err) {
      return errorResponse(`Error: Failed to add task '${params.title}' — ${(err as Error).message}.`);
    }
  });

  server.tool('flightdeck_task_claim', 'Claim a ready task', {
    taskId: z.string(),
  }, async (params) => {
    const resolved = requireAgentId();
    if ('error' in resolved) return resolved.error;
    try {
      const task = await client.claimTask(params.taskId);
      return jsonResponse(task);
    } catch (err) {
      return errorResponse(`Error: ${(err as Error).message}`);
    }
  });

  server.tool('flightdeck_task_submit', 'Submit completed work with claim', {
    taskId: z.string(),
    claim: z.string().optional(),
  }, async (params) => {
    const resolved = requireAgentId();
    if ('error' in resolved) return resolved.error;
    try {
      const task = await client.submitTask(params.taskId, params.claim);
      return jsonResponse(task);
    } catch (err) {
      return errorResponse(`Error: ${(err as Error).message}`);
    }
  });

  server.tool('flightdeck_task_fail', 'Report task failure', {
    taskId: z.string(),
    reason: z.string().optional(),
  }, async (params) => {
    const resolved = requireAgentId();
    if ('error' in resolved) return resolved.error;
    try {
      const task = await client.failTask(params.taskId, params.reason);
      return jsonResponse(task);
    } catch (err) {
      return errorResponse(`Error: ${(err as Error).message}`);
    }
  });

  server.tool('flightdeck_task_cancel', 'Cancel a task', {
    taskId: z.string(),
  }, async (params) => {
    const resolved = requireAgentId();
    if ('error' in resolved) return resolved.error;
    try {
      const task = await client.cancelTask(params.taskId);
      return jsonResponse(task);
    } catch (err) {
      return errorResponse(`Error: ${(err as Error).message}`);
    }
  });

  server.tool('flightdeck_task_pause', 'Pause a task', {
    taskId: z.string(),
  }, async (params) => {
    const resolved = requireAgentId();
    if ('error' in resolved) return resolved.error;
    try {
      const task = await client.pauseTask(params.taskId);
      return jsonResponse(task);
    } catch (err) {
      return errorResponse(`Error: ${(err as Error).message}`);
    }
  });

  server.tool('flightdeck_task_resume', 'Resume a paused task (paused → running)', {
    taskId: z.string(),
  }, async (params) => {
    const resolved = requireAgentId();
    if ('error' in resolved) return resolved.error;
    try {
      const task = await client.resumeTask(params.taskId);
      return jsonResponse(task);
    } catch (err) {
      return errorResponse(`Error: ${(err as Error).message}`);
    }
  });

  server.tool('flightdeck_task_retry', 'Retry a failed task', {
    taskId: z.string(),
  }, async (params) => {
    const resolved = requireAgentId();
    if ('error' in resolved) return resolved.error;
    try {
      const task = await client.retryTask(params.taskId);
      return jsonResponse(task);
    } catch (err) {
      return errorResponse(`Error: ${(err as Error).message}`);
    }
  });

  server.tool('flightdeck_task_skip', 'Skip a task (unblocks dependents)', {
    taskId: z.string(),
  }, async (params) => {
    const resolved = requireAgentId();
    if ('error' in resolved) return resolved.error;
    try {
      const task = await client.skipTask(params.taskId);
      return jsonResponse(task);
    } catch (err) {
      return errorResponse(`Error: ${(err as Error).message}`);
    }
  });

  server.tool('flightdeck_task_complete', 'Complete a task (in_review → done)', {
    taskId: z.string(),
  }, async (params) => {
    const resolved = requireAgentId();
    if ('error' in resolved) return resolved.error;
    try {
      const task = await client.completeTask(params.taskId);
      return jsonResponse(task);
    } catch (err) {
      return errorResponse(`Error: ${(err as Error).message}`);
    }
  });

  server.tool('flightdeck_review_submit', 'Submit a code review verdict for a task in review', {
    taskId: z.string().describe('The task ID being reviewed'),
    verdict: z.enum(['approve', 'request_changes']).describe('approve = task passes review; request_changes = worker must address feedback'),
    comment: z.string().describe('Review feedback explaining the verdict'),
  }, async (params) => {
    const resolved = requireAgentId();
    if ('error' in resolved) return resolved.error;
    try {
      const result = await client.reviewSubmit(params.taskId, params.verdict, params.comment);
      return jsonResponse(result);
    } catch (err) {
      return errorResponse(`Error: ${(err as Error).message}`);
    }
  });

  server.tool('flightdeck_task_comment', 'Add a comment to a task (like a PR comment)', {
    taskId: z.string().describe('The task ID to comment on'),
    comment: z.string().describe('The comment text'),
  }, async (params) => {
    const resolved = requireAgentId();
    if ('error' in resolved) return resolved.error;
    try {
      const result = await client.addTaskComment(params.taskId, params.comment);
      return jsonResponse(result);
    } catch (err) {
      return errorResponse(`Error: ${(err as Error).message}`);
    }
  });

  server.tool('flightdeck_task_reopen', 'Reopen a completed task (done → ready)', {
    taskId: z.string(),
  }, async (params) => {
    const resolved = requireAgentId();
    if ('error' in resolved) return resolved.error;
    try {
      const task = await client.reopenTask(params.taskId);
      return jsonResponse(task);
    } catch (err) {
      return errorResponse(`Error: ${(err as Error).message}`);
    }
  });

  server.tool('flightdeck_declare_tasks', 'Batch create tasks with dependencies. dependsOn accepts task titles, index refs (#0, #1), or existing task IDs.', {
    tasks: z.array(z.object({
      title: z.string(),
      description: z.string().optional(),
      specId: z.string().optional(),
      role: z.enum(['lead', 'planner', 'worker', 'reviewer', 'product-thinker', 'qa-tester', 'tech-writer']).optional(),
      dependsOn: z.array(z.string()).optional(),
      priority: z.number().optional(),
      needsReview: z.boolean().optional().describe('If false, skip review and auto-complete on submit. Default: true.'),
      notifyLead: z.boolean().optional().describe('If true, notify Lead when this task completes. Default: false.'),
      acceptanceCriteria: z.string().optional().describe('What done looks like. Shown to worker and reviewer.'),
      context: z.string().optional().describe('Additional context: references, code snippets, related files.'),
    })),
  }, async (params) => {
    const resolved = requireAgentId();
    if ('error' in resolved) return resolved.error;
    try {
      const tasks = await client.declareTasks(params.tasks);
      return jsonResponse(tasks);
    } catch (err) {
      return errorResponse(`Error: ${(err as Error).message}`);
    }
  });

  server.tool('flightdeck_declare_subtasks', 'Declare sub-tasks under a parent task (FR-017)', {
    parentTaskId: z.string(),
    tasks: z.array(z.object({
      title: z.string(),
      description: z.string().optional(),
      role: z.enum(['lead', 'planner', 'worker', 'reviewer', 'product-thinker', 'qa-tester', 'tech-writer']).optional(),
      dependsOn: z.array(z.string()).optional(),
      priority: z.number().optional(),
      needsReview: z.boolean().optional().describe('If false, skip review and auto-complete on submit. Default: true.'),
      notifyLead: z.boolean().optional().describe('If true, notify Lead when this task completes. Default: false.'),
      acceptanceCriteria: z.string().optional().describe('What done looks like. Shown to worker and reviewer.'),
      context: z.string().optional().describe('Additional context: references, code snippets, related files.'),
    })),
  }, async (params) => {
    const resolved = requireAgentId();
    if ('error' in resolved) return resolved.error;
    try {
      const tasks = await client.declareSubtasks(params.parentTaskId, params.tasks);
      return jsonResponse(tasks);
    } catch (err) {
      return errorResponse(`Error: ${(err as Error).message}`);
    }
  });

  server.tool('flightdeck_task_compact', 'Compact a completed task to save context (FR-015)', {
    taskId: z.string(),
    summary: z.string().optional(),
  }, async (params) => {
    const resolved = requireAgentId();
    if ('error' in resolved) return resolved.error;
    try {
      const task = await client.compactTask(params.taskId, params.summary);
      return jsonResponse(task);
    } catch (err) {
      return errorResponse(`Error: ${(err as Error).message}`);
    }
  });

  // ── Role tools ──

  server.tool('flightdeck_role_list', 'List all available roles (built-in + custom from .github/agents/ and .claude/agents/) with their enabled models', {}, async () => {
    try {
      const roles = await client.listRoles();
      return jsonResponse(roles);
    } catch (err) {
      return errorResponse(`Error: ${(err as Error).message}`);
    }
  });

  server.tool('flightdeck_role_info', 'Get full role details', {
    roleId: z.string(),
  }, async (params) => {
    try {
      const role = await client.getRoleInfo(params.roleId);
      if (!role) return errorResponse(`Role '${params.roleId}' not found.`);
      return jsonResponse(role);
    } catch (err) {
      return errorResponse(`Error: ${(err as Error).message}`);
    }
  });

  // ── Model discovery tool ──

  server.tool('flightdeck_model_list', 'List available models and runtimes across all providers, including per-role enabled models. Use this to decide which runtime:model to assign when spawning agents.', {
  }, async () => {
    const resolved = requireAgentId();
    if ('error' in resolved) return resolved.error;
    try {
      const [available, config] = await Promise.all([
        client.getModelsAvailable(),
        client.getModelConfig(),
      ]);
      const roleModels: Record<string, unknown> = {};
      const cfg = config as { roles?: Array<{ role: string; runtime?: string; model?: string; enabledModels?: unknown[] }> };
      if (cfg.roles) {
        for (const rc of cfg.roles) {
          roleModels[rc.role] = {
            runtime: rc.runtime,
            model: rc.model,
            enabledModels: rc.enabledModels ?? [],
          };
        }
      }
      return jsonResponse({ availableModels: available, roleModels });
    } catch (err) {
      return errorResponse(`Error: ${(err as Error).message}`);
    }
  });

  // ── Agent lifecycle tools ──

  server.tool('flightdeck_agent_spawn', 'Spawn a new agent', {
    role: z.enum(['lead', 'planner', 'worker', 'reviewer', 'product-thinker', 'qa-tester', 'tech-writer']),
    model: z.string().optional(),
    runtime: z.string().optional().describe('Runtime name (e.g. copilot, opencode, cursor, codex-acp). Uses project config default if not set.'),
    task: z.string().optional(),
    cwd: z.string().optional(),
  }, async (params) => {
    const resolved = requireAgentId();
    if ('error' in resolved) return resolved.error;
    try {
      const newAgent = await client.spawnAgent(params);
      return jsonResponse(newAgent);
    } catch (err) {
      return errorResponse(`Error spawning agent: ${(err as Error).message}`);
    }
  });

  server.tool('flightdeck_agent_terminate', 'Terminate an agent', {
    targetAgentId: z.string(),
  }, async (params) => {
    const resolved = requireAgentId();
    if ('error' in resolved) return resolved.error;
    try {
      await client.terminateAgent(params.targetAgentId);
      return jsonResponse({ status: 'terminated', agentId: params.targetAgentId });
    } catch (err) {
      return errorResponse(`Error terminating agent: ${(err as Error).message}`);
    }
  });

  server.tool('flightdeck_agent_list', 'List all agents', {
    includeRetired: z.boolean().optional(),
  }, async (params) => {
    try {
      return jsonResponse(await client.listAgents(params.includeRetired));
    } catch (err) {
      return errorResponse(`Error: ${(err as Error).message}`);
    }
  });

  server.tool('flightdeck_agent_output', 'Get the accumulated output of a running agent', {
    targetAgentId: z.string().describe('The agent ID to get output from'),
    tail: z.number().optional().describe('Number of lines from the end to return (default 50)'),
  }, async (params) => {
    try {
      const result = await client.getAgentOutput(params.targetAgentId, params.tail);
      return jsonResponse(result);
    } catch (err) {
      return errorResponse(`Error: ${(err as Error).message}`);
    }
  });

  server.tool('flightdeck_agent_hibernate', 'Hibernate a worker — saves session, kills process, pauses assigned task', {
    targetAgentId: z.string(),
  }, async (params) => {
    const resolved = requireAgentId();
    if ('error' in resolved) return resolved.error;
    try {
      const result = await client.hibernateAgent(params.targetAgentId);
      return jsonResponse(result);
    } catch (err) {
      return errorResponse(`Error hibernating agent: ${(err as Error).message}`);
    }
  });

  server.tool('flightdeck_agent_wake', 'Wake a hibernated worker — resumes session, resumes task', {
    targetAgentId: z.string(),
  }, async (params) => {
    const resolved = requireAgentId();
    if ('error' in resolved) return resolved.error;
    try {
      const result = await client.wakeAgent(params.targetAgentId);
      return jsonResponse(result);
    } catch (err) {
      return errorResponse(`Error waking agent: ${(err as Error).message}`);
    }
  });

  server.tool('flightdeck_agent_retire', 'Permanently dismiss a worker — invisible to lead after this', {
    targetAgentId: z.string(),
  }, async (params) => {
    const resolved = requireAgentId();
    if ('error' in resolved) return resolved.error;
    try {
      await client.retireAgent(params.targetAgentId);
      return jsonResponse({ status: 'retired', agentId: params.targetAgentId });
    } catch (err) {
      return errorResponse(`Error retiring agent: ${(err as Error).message}`);
    }
  });

  server.tool('flightdeck_agent_restart', 'Restart an agent', {
    targetAgentId: z.string(),
  }, async (params) => {
    const resolved = requireAgentId();
    if ('error' in resolved) return resolved.error;
    try {
      const restarted = await client.restartAgent(params.targetAgentId);
      return jsonResponse({ status: 'restarted', agentId: params.targetAgentId, agent: restarted });
    } catch (err) {
      return errorResponse(`Error restarting agent: ${(err as Error).message}`);
    }
  });

  server.tool('flightdeck_agent_interrupt', 'Send urgent message to an agent', {
    targetAgentId: z.string(),
    message: z.string(),
  }, async (params) => {
    const resolved = requireAgentId();
    if ('error' in resolved) return resolved.error;
    // Fire-and-forget to avoid MCP timeout
    client.interruptAgent(params.targetAgentId, params.message).catch(() => {});
    return jsonResponse({ status: 'interrupted', targetAgentId: params.targetAgentId });
  });

  // ── Communication tools (consolidated) ──

  server.tool('flightdeck_send', 'Send a message. If "to" is set, sends a DM. If "channel" is set, posts to a group channel. If "taskId" is set, posts a task comment.', {
    to: z.string().optional().describe('Agent ID for DM'),
    channel: z.string().optional().describe('Channel name for group message'),
    taskId: z.string().optional().describe('Task ID to post a comment on'),
    parentId: z.string().optional().describe('Message ID to reply to (quote)'),
    content: z.string(),
  }, async (params) => {
    const resolved = requireAgentId();
    if ('error' in resolved) return resolved.error;
    if (!params.to && !params.channel && !params.taskId) {
      return errorResponse('Error: Either "to" (for DM), "channel" (for group), or "taskId" (for task comment) must be set.');
    }
    try {
      const result = await client.sendMessage(params);
      return jsonResponse(result);
    } catch (err) {
      return errorResponse(`Error: ${(err as Error).message}`);
    }
  });

  server.tool('flightdeck_read', 'Read messages. If "channel" is set, reads group channel. Otherwise reads your DM inbox.', {
    channel: z.string().optional().describe('Channel name to read. Omit for DM inbox.'),
    since: z.string().optional().describe('ISO timestamp to filter messages since'),
  }, async (params) => {
    try {
      const result = await client.readMessages(params);
      return jsonResponse(result);
    } catch (err) {
      return errorResponse(`Error: ${(err as Error).message}`);
    }
  });

  // ── Search tools (consolidated) ──

  server.tool('flightdeck_search', 'Search across all project data sources: chat messages, project memory files, and session transcripts. Results are tagged with their source.', {
    query: z.string().describe('Search query (keywords or phrases)'),
    source: z.enum(['all', 'chat', 'memory', 'session']).optional().describe('Data source to search. Default: all'),
    authorType: z.enum(['user', 'lead', 'agent', 'system']).optional().describe('Filter chat results by author type'),
    limit: z.number().optional().describe('Max results to return (default 10, max 50)'),
    offset: z.number().optional().describe('Skip N results for pagination (default 0)'),
  }, async (params) => {
    try {
      const result = await client.search(params);
      return jsonResponse(result);
    } catch (err) {
      return errorResponse(`Error: ${(err as Error).message}`);
    }
  });

  // ── Chat message tools ──

  server.tool('flightdeck_msg_list', 'List chat messages', {
    threadId: z.string().optional(),
    taskId: z.string().optional(),
    limit: z.number().optional(),
  }, async (params) => {
    try {
      const msgs = await client.listMessages({ thread_id: params.threadId, task_id: params.taskId, limit: params.limit });
      return jsonResponse(msgs);
    } catch (err) {
      return errorResponse(`Error: ${(err as Error).message}`);
    }
  });

  server.tool('flightdeck_thread_create', 'Create a chat thread from a message', {
    originId: z.string(),
    title: z.string().optional(),
  }, async (params) => {
    try {
      const thread = await client.createThread(params.originId, params.title);
      return jsonResponse(thread);
    } catch (err) {
      return errorResponse(`Error: ${(err as Error).message}`);
    }
  });

  server.tool('flightdeck_thread_list', 'List chat threads', {
    archived: z.boolean().optional(),
    limit: z.number().optional(),
  }, async (params) => {
    try {
      const threads = await client.listThreads(params);
      return jsonResponse(threads);
    } catch (err) {
      return errorResponse(`Error: ${(err as Error).message}`);
    }
  });

  // ── Memory tools ──

  server.tool('flightdeck_memory_read', 'Read a project memory file', {
    filename: z.string().describe('Memory filename (e.g. SOUL.md, MEMORY.md, 2026-04-14.md)'),
  }, async (params) => {
    try {
      const result = await client.readMemory(params.filename);
      if (!result) return errorResponse(`Memory file not found: ${params.filename}`);
      return { content: [{ type: 'text' as const, text: result.content }] };
    } catch (err) {
      return errorResponse(`Error: ${(err as Error).message}`);
    }
  });

  server.tool('flightdeck_memory_log', 'Append an entry to today\'s daily log (append-only)', {
    entry: z.string().describe('Log entry text'),
  }, async (params) => {
    const resolved = requireAgentId();
    if ('error' in resolved) return resolved.error;
    try {
      const result = await client.appendDailyLog(`[${ENV_AGENT_ROLE ?? 'unknown'}/${resolveCallerId()}] ${params.entry}`);
      return jsonResponse(result);
    } catch (err) {
      return errorResponse(`Error: ${(err as Error).message}`);
    }
  });

  server.tool('flightdeck_memory_write', 'Write to project memory', {
    filename: z.string(),
    content: z.string(),
  }, async (params) => {
    const resolved = requireAgentId();
    if ('error' in resolved) return resolved.error;
    try {
      const result = await client.writeMemory(params.filename, params.content);
      return jsonResponse(result);
    } catch (err) {
      return errorResponse(`Error: ${(err as Error).message}`);
    }
  });

  // ── Learnings tools ──

  server.tool('flightdeck_learning_add', 'Add a learning', {
    content: z.string(),
    tags: z.array(z.string()).optional(),
  }, async (params) => {
    const resolved = requireAgentId();
    if ('error' in resolved) return resolved.error;
    try {
      const learning = await client.addLearning(params);
      return jsonResponse(learning);
    } catch (err) {
      return errorResponse(`Error: ${(err as Error).message}`);
    }
  });

  server.tool('flightdeck_learning_search', 'Search learnings', {
    query: z.string(),
  }, async (params) => {
    try {
      return jsonResponse(await client.searchLearnings(params.query));
    } catch (err) {
      return errorResponse(`Error: ${(err as Error).message}`);
    }
  });

  // ── Cost tools ──


  // ── Timer tools ──

  server.tool('flightdeck_timer_set', 'Set a timer', {
    label: z.string(),
    delayMs: z.number(),
    message: z.string(),
    repeat: z.boolean().optional(),
  }, async (params) => {
    const resolved = requireAgentId();
    if ('error' in resolved) return resolved.error;
    try {
      const timer = await client.setTimer(params);
      return jsonResponse(timer);
    } catch (err) {
      return errorResponse(`Error: ${(err as Error).message}`);
    }
  });

  server.tool('flightdeck_timer_cancel', 'Cancel a timer', {
    label: z.string(),
  }, async (params) => {
    const resolved = requireAgentId();
    if ('error' in resolved) return resolved.error;
    try {
      return jsonResponse(await client.cancelTimer(params.label));
    } catch (err) {
      return errorResponse(`Error: ${(err as Error).message}`);
    }
  });

  server.tool('flightdeck_timer_list', 'List timers', {
  }, async () => {
    const resolved = requireAgentId();
    if ('error' in resolved) return resolved.error;
    try {
      return jsonResponse(await client.listTimers());
    } catch (err) {
      return errorResponse(`Error: ${(err as Error).message}`);
    }
  });

  // ── Cron tools ──

  server.tool('flightdeck_cron_list', 'List all cron jobs', {}, async () => {
    try {
      return jsonResponse(await client.listCronJobs());
    } catch (err) {
      return errorResponse(`Error: ${(err as Error).message}`);
    }
  });

  server.tool('flightdeck_cron_add', 'Add a new cron job', {
    name: z.string().describe('Job name'),
    schedule: z.string().describe('Cron expression (e.g. "0 9 * * *")'),
    prompt: z.string().describe('Message to send to Lead when triggered'),
    tz: z.string().optional().describe('IANA timezone (default UTC)'),
    skill: z.string().optional().describe('Skill name to activate'),
    enabled: z.boolean().optional().describe('Whether the job is enabled (default true)'),
  }, async (params) => {
    try {
      return jsonResponse(await client.addCronJob(params));
    } catch (err) {
      return errorResponse(`Error: ${(err as Error).message}`);
    }
  });

  server.tool('flightdeck_cron_enable', 'Enable a cron job', {
    jobId: z.string().describe('Job ID to enable'),
  }, async (params) => {
    try {
      await client.enableCronJob(params.jobId);
      return jsonResponse({ success: true, jobId: params.jobId, enabled: true });
    } catch (err) {
      return errorResponse(`Error: ${(err as Error).message}`);
    }
  });

  server.tool('flightdeck_cron_disable', 'Disable a cron job', {
    jobId: z.string().describe('Job ID to disable'),
  }, async (params) => {
    try {
      await client.disableCronJob(params.jobId);
      return jsonResponse({ success: true, jobId: params.jobId, enabled: false });
    } catch (err) {
      return errorResponse(`Error: ${(err as Error).message}`);
    }
  });

  server.tool('flightdeck_cron_remove', 'Remove a cron job', {
    jobId: z.string().describe('Job ID to remove'),
  }, async (params) => {
    try {
      await client.removeCronJob(params.jobId);
      return jsonResponse({ success: true, jobId: params.jobId, removed: true });
    } catch (err) {
      return errorResponse(`Error: ${(err as Error).message}`);
    }
  });

  server.tool('flightdeck_cron_run', 'Manually trigger a cron job now', {
    jobId: z.string().describe('Job ID to run'),
  }, async (params) => {
    try {
      return jsonResponse(await client.runCronJob(params.jobId));
    } catch (err) {
      return errorResponse(`Error: ${(err as Error).message}`);
    }
  });

  // ── Status tools ──

  server.tool('flightdeck_status', 'Get project status', {}, async () => {
    try {
      const status = await client.getStatus() as Record<string, unknown>;
      // Strip cost/token data — agents don't need it
      delete status.tokenUsage;
      delete status.totalCost;
      return jsonResponse(status);
    } catch (err) {
      return errorResponse(`Error: ${(err as Error).message}`);
    }
  });

  server.tool('flightdeck_spec_list', 'List specs', {}, async () => {
    try {
      return jsonResponse(await client.listSpecs());
    } catch (err) {
      return errorResponse(`Error: ${(err as Error).message}`);
    }
  });

  server.tool('flightdeck_spec_create', 'Create a new spec document', {
    title: z.string().describe('Spec title'),
    content: z.string().describe('Spec content (markdown)'),
  }, async (params) => {
    const resolved = requireAgentId();
    if ('error' in resolved) return resolved.error;
    try {
      return jsonResponse(await client.createSpec(params.title, params.content));
    } catch (err) {
      return errorResponse(`Error: ${(err as Error).message}`);
    }
  });

  server.tool('flightdeck_spec_cancel', 'Cancel a spec and all its incomplete tasks', {
    specId: z.string().describe('Spec ID to cancel'),
  }, async (params) => {
    try {
      const cancelled = client.cancelSpec(params.specId);
      return jsonResponse(cancelled);
    } catch (err) {
      return errorResponse(`Error: ${(err as Error).message}`);
    }
  });

  server.tool('flightdeck_spec_changes', 'List recent spec changes detected by the system', {}, async () => {
    try {
      return jsonResponse(await client.getSpecChanges());
    } catch (err) {
      return errorResponse(`Error: ${(err as Error).message}`);
    }
  });

  server.tool('flightdeck_task_clear_stale', 'Clear stale flag on a task after re-planning', {
    taskId: z.string(),
  }, async (params) => {
    const resolved = requireAgentId();
    if ('error' in resolved) return resolved.error;
    try {
      return jsonResponse(await client.clearTaskStale(params.taskId));
    } catch (err) {
      return errorResponse(`Error: ${(err as Error).message}`);
    }
  });

  server.tool('flightdeck_escalate', 'Escalate to lead/planner', {
    taskId: z.string(),
    reason: z.string(),
  }, async (params) => {
    const resolved = requireAgentId();
    if ('error' in resolved) return resolved.error;
    try {
      return jsonResponse(await client.escalate(params.taskId, params.reason));
    } catch (err) {
      return errorResponse(`Error: ${(err as Error).message}`);
    }
  });

  server.tool('flightdeck_escalate_to_human', 'Escalate an issue to the human user for decision/action. Creates a visible notification in the dashboard.', {
    title: z.string().describe('Short title for the escalation'),
    description: z.string().describe('Detailed description of what needs human input'),
    priority: z.enum(['low', 'normal', 'high', 'urgent']).optional().describe('Priority level'),
  }, async (params) => {
    const resolved = requireAgentId();
    if ('error' in resolved) return resolved.error;
    try {
      return jsonResponse(await client.escalateToHuman(params.title, params.description, params.priority));
    } catch (err) {
      return errorResponse(`Error: ${(err as Error).message}`);
    }
  });

  server.tool('flightdeck_discuss', 'Create a group discussion', {
    topic: z.string(),
    invitees: z.array(z.string()).optional(),
  }, async (params) => {
    const resolved = requireAgentId();
    if ('error' in resolved) return resolved.error;
    try {
      return jsonResponse(await client.discuss(params.topic, params.invitees));
    } catch (err) {
      return errorResponse(`Error: ${(err as Error).message}`);
    }
  });

  // ── Plan approval tool (Lead only) ──

  server.tool('flightdeck_plan_review', 'Approve or reject a planned set of tasks. Approve transitions planned → pending; reject transitions planned → cancelled.', {
    verdict: z.enum(['approve', 'reject']).describe('Whether to approve or reject the plan'),
    specId: z.string().optional().describe('Target tasks for this spec. If omitted, targets all planned tasks.'),
    message: z.string().optional().describe('Reason or feedback for the decision'),
  }, async (params) => {
    const resolved = requireAgentId();
    if ('error' in resolved) return resolved.error;
    try {
      const allTasks = await client.listTasks();
      const planned = (allTasks as any[]).filter((t: any) =>
        t.state === 'planned' && (!params.specId || t.specId === params.specId)
      );
      const targetState = params.verdict === 'approve' ? 'pending' : 'cancelled';
      let count = 0;
      for (const task of planned) {
        try {
          await client.updateTaskState(task.id, targetState);
          count++;
        } catch { /* skip invalid transitions */ }
      }
      return jsonResponse({ verdict: params.verdict, count, total: planned.length, message: params.message });
    } catch (err) {
      return errorResponse(`Error reviewing plan: ${(err as Error).message}`);
    }
  });

  // ── Decision tools ──

  server.tool('flightdeck_decision_log', 'Record a decision', {
    taskId: z.string(),
    type: z.enum(['architecture', 'implementation', 'dependency', 'api_design', 'tradeoff']),
    title: z.string(),
    reasoning: z.string(),
    alternatives: z.array(z.string()).optional(),
    confidence: z.number().min(0).max(1),
    reversible: z.boolean(),
  }, async (params) => {
    const resolved = requireAgentId();
    if ('error' in resolved) return resolved.error;
    try {
      return jsonResponse(await client.logDecision(params));
    } catch (err) {
      return errorResponse(`Error: ${(err as Error).message}`);
    }
  });

  server.tool('flightdeck_decision_list', 'List recent decisions', {
    taskId: z.string().optional(),
    type: z.string().optional(),
    status: z.string().optional(),
    since: z.string().optional(),
    limit: z.number().optional(),
  }, async (params) => {
    try {
      return jsonResponse(await client.listDecisions(params));
    } catch (err) {
      return errorResponse(`Error: ${(err as Error).message}`);
    }
  });

  // ── Report tool ──

  server.tool('flightdeck_report', 'Generate daily report', {
    since: z.string().optional(),
  }, async (params) => {
    try {
      const markdown = await client.getReport(params.since);
      return { content: [{ type: 'text' as const, text: markdown }] };
    } catch (err) {
      return errorResponse(`Error: ${(err as Error).message}`);
    }
  });

  // ── Skill tools ──

  server.tool('flightdeck_skill_list', 'List available skills and their role assignments', {}, async () => {
    try {
      return jsonResponse(await client.listSkills());
    } catch (err) {
      return errorResponse(`Error: ${(err as Error).message}`);
    }
  });

  server.tool('flightdeck_skill_install', 'Install a skill from a source directory', {
    source: z.string().describe('Path to skill directory containing SKILL.md'),
  }, async (params) => {
    const resolved = requireAgentId();
    if ('error' in resolved) return resolved.error;
    try {
      return jsonResponse(await client.installSkill(params.source));
    } catch (err) {
      return errorResponse(`Error: ${(err as Error).message}`);
    }
  });

  // ── Model tools ──

  server.tool('flightdeck_model_config', 'Get current model configuration per role', {}, async () => {
    try {
      return jsonResponse(await client.getModelConfig());
    } catch (err) {
      return errorResponse(`Error: ${(err as Error).message}`);
    }
  });

  server.tool('flightdeck_model_set', 'Change a running agent\'s model (Lead only, user-requested)', {
    agentId: z.string().describe('Agent ID to change model for'),
    model: z.string().describe('Model ID (e.g. gpt-4.1, claude-sonnet-4)'),
    reason: z.string().optional().describe('Why the model is being changed (logged)'),
  }, async (params) => {
    const resolved = requireAgentId();
    if ('error' in resolved) return resolved.error;
    try {
      return jsonResponse(await client.setAgentModel(params.agentId, params.model, params.reason));
    } catch (err) {
      return errorResponse(`Error: ${(err as Error).message}`);
    }
  });

  // ── Suggestion tools ──

  server.tool('flightdeck_suggestion_list', 'List scout suggestions', {
    specId: z.string().optional().describe('Filter by spec ID'),
    status: z.enum(['pending', 'approved', 'rejected', 'implemented']).optional().describe('Filter by status'),
  }, async (params) => {
    try {
      return jsonResponse(await client.listSuggestions({ spec_id: params.specId, status: params.status }));
    } catch (err) {
      return errorResponse(`Error: ${(err as Error).message}`);
    }
  });

  server.tool('flightdeck_suggestion_approve', 'Approve a scout suggestion (creates follow-up tasks)', {
    id: z.string().describe('Suggestion ID to approve'),
  }, async (params) => {
    const resolved = requireAgentId();
    if ('error' in resolved) return resolved.error;
    try {
      return jsonResponse(await client.approveSuggestion(params.id));
    } catch (err) {
      return errorResponse(`Error: ${(err as Error).message}`);
    }
  });

  server.tool('flightdeck_suggestion_reject', 'Reject a scout suggestion', {
    id: z.string().describe('Suggestion ID to reject'),
  }, async (params) => {
    const resolved = requireAgentId();
    if ('error' in resolved) return resolved.error;
    try {
      return jsonResponse(await client.rejectSuggestion(params.id));
    } catch (err) {
      return errorResponse(`Error: ${(err as Error).message}`);
    }
  });

  // ── Tools available (self-discovery) ──

  server.tool('flightdeck_tools_available', 'List the MCP tools available to the calling agent', {}, async () => {
    if (agentRole) {
      const tools = getToolsForRole(agentRole);
      return jsonResponse({ role: agentRole, tools });
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- accessing private SDK property for tool introspection
    const allTools = Object.keys((server as any)._registeredTools ?? {});
    return jsonResponse({ role: null, tools: allTools });
  });

  // ── Isolation status ──

  // ── File Lock tools (file_lock isolation mode) ──

  server.tool('flightdeck_file_lock', 'Acquire a lock on a file before modifying it. Required in file_lock isolation mode.', {
    filePath: z.string().describe('Relative file path to lock'),
    reason: z.string().optional().describe('Why you need this file'),
  }, async (params) => {
    const resolved = requireAgentId();
    if ('error' in resolved) return resolved.error;
    try {
      const success = await client.acquireFileLock(params.filePath, resolved.agentId, ENV_AGENT_ROLE ?? 'worker', params.reason);
      if (!success) {
        const locks = await client.listFileLocks();
        const holder = (locks as any[]).find((l: any) => l.filePath === params.filePath);
        return errorResponse(`File "${params.filePath}" is locked by ${holder?.agentId ?? 'another agent'}. Wait and retry, or work on a different file.`);
      }
      return jsonResponse({ locked: true, filePath: params.filePath });
    } catch (err) {
      return errorResponse(`Error: ${(err as Error).message}`);
    }
  });

  server.tool('flightdeck_file_unlock', 'Release a file lock after you are done modifying it.', {
    filePath: z.string().describe('Relative file path to unlock'),
  }, async (params) => {
    const resolved = requireAgentId();
    if ('error' in resolved) return resolved.error;
    try {
      const released = await client.releaseFileLock(params.filePath, resolved.agentId);
      return jsonResponse({ released, filePath: params.filePath });
    } catch (err) {
      return errorResponse(`Error: ${(err as Error).message}`);
    }
  });

  server.tool('flightdeck_file_locks', 'List all active file locks in the project.', {}, async () => {
    try {
      return jsonResponse(await client.listFileLocks());
    } catch (err) {
      return errorResponse(`Error: ${(err as Error).message}`);
    }
  });

  server.tool('flightdeck_isolation_status', 'Show current isolation mode and active worktrees/workdirs', {}, async () => {
    try {
      return jsonResponse(await client.getIsolationStatus());
    } catch (err) {
      return errorResponse(`Error: ${(err as Error).message}`);
    }
  });

  // ── Webhook test tool ──
  server.tool('flightdeck_webhook_test', 'Send a test message to all configured webhooks', {}, async () => {
    try {
      return jsonResponse(await client.testWebhook());
    } catch (err) {
      return errorResponse(`Error: ${(err as Error).message}`);
    }
  });

  // ── Per-role tool filtering ──
  if (agentRole) {
    const allowed = new Set(getToolsForRole(agentRole));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- accessing private SDK property for tool introspection
    const registered = (server as any)._registeredTools as Record<string, unknown> | undefined;
    if (registered) {
      for (const toolName of Object.keys(registered)) {
        if (!allowed.has(toolName)) {
          delete registered[toolName];
        }
      }
    }
  }

  return server;
}

async function main() {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

const isMain = process.argv[1]?.endsWith('server.ts') || process.argv[1]?.endsWith('server.js');
if (isMain) {
  main().catch(console.error);
}
