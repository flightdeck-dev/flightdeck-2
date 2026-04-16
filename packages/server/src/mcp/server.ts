import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { Flightdeck } from '../facade.js';
import { ProjectStore } from '../storage/ProjectStore.js';
import type { TaskId, AgentId, SpecId, Message, Agent, AgentRole } from '@flightdeck-ai/shared';
import { messageId, agentId as makeAgentId } from '@flightdeck-ai/shared';
import type { LearningCategory } from '../storage/LearningsStore.js';
import type { AgentManager } from '../agents/AgentManager.js';
import { SkillManager } from '../skills/SkillManager.js';
import { DailyReport } from '../reporting/DailyReport.js';
import type { DecisionId, DecisionStatus } from '@flightdeck-ai/shared';
import { decisionId as makeDecisionId } from '@flightdeck-ai/shared';
import { modelRegistry } from '../agents/ModelTiers.js';
import type { AcpAdapter } from '../agents/AcpAdapter.js';
import { ModelConfig } from '../agents/ModelConfig.js';
import { getToolsForRole } from './toolPermissions.js';
import { agentMessageEvent } from '../integrations/WebhookNotifier.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { GatewayRelay } from './gatewayRelay.js';

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
  relay: GatewayRelay | null;
}>();

function errorResponse(text: string) {
  const ctx = toolCallContext.getStore();
  if (ctx?.relay) {
    ctx.relay.notifyToolCall({
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
  if (ctx?.relay) {
    ctx.relay.notifyToolCall({
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

/** Format a timestamped message for agent consumption. */
function formatAgentMessage(type: 'dm' | 'user' | 'system' | 'urgent', opts: {
  from?: string;
  fromRole?: string;
  content: string;
}): string {
  const ts = new Date().toISOString().slice(0, 19) + 'Z';
  const sender = opts.from
    ? opts.fromRole ? `${opts.fromRole} (${opts.from})` : opts.from
    : type;
  const tag = type === 'urgent' ? 'URGENT' : type.toUpperCase();
  return `[${ts}] [${tag} from ${sender}] ${opts.content}`;
}

function resolveAgent(fd: Flightdeck, _toolName: string) {
  const resolved = getEnvAgentId();
  if (!resolved) {
    return { error: errorResponse(`Error: FLIGHTDECK_AGENT_ID env var not set. Cannot identify caller.`) };
  }
  const agent = fd.sqlite.getAgent(resolved as AgentId);
  if (!agent) {
    return { error: errorResponse(`Error: Agent '${resolved}' not found. Register the agent first or check the ID. Use flightdeck_status() to see registered agents.`) };
  }
  return { agent };
}

/** Resolve caller agent ID from env var (injected by AcpAdapter at spawn) */
function resolveCallerId(): string | undefined {
  return getEnvAgentId();
}

function permError(agentId: string, role: string, toolName: string, permission: string) {
  // Generate role-specific helpful messages
  const suggestions: Record<string, string> = {
    task_add: "Use flightdeck_escalate({ reason: 'need new task' }) instead.",
    task_claim: 'Only workers claim and execute tasks.',
    task_submit: 'Only the assigned worker can submit task work.',
    task_fail: 'Use flightdeck_escalate() to report issues if you are a planner/reviewer.',
    discuss: 'Use flightdeck_channel_send() to post in an existing channel, or flightdeck_escalate() to request a discussion.',
    memory_write: 'Your role does not have memory write access.',
  };
  const permToRoles: Record<string, string> = {
    task_add: 'lead/planner',
    task_claim: 'worker',
    task_submit: 'worker',
    task_fail: 'worker/lead',
    discuss: 'lead/planner',
    task_cancel: 'lead/worker',
    task_pause: 'lead',
    task_resume: 'lead/worker/qa-tester',
    task_retry: 'lead',
    task_skip: 'lead/planner',
    task_complete: 'lead/reviewer',
    task_reopen: 'lead',
    task_compact: 'lead',
    declare_tasks: 'lead/planner',
    agent_spawn: 'lead',
    agent_terminate: 'lead',
    memory_write: 'lead/worker/planner/product-thinker/qa-tester/tech-writer',
  };
  const allowed = permToRoles[permission] || 'authorized roles';
  const suggestion = suggestions[permission] || '';
  return errorResponse(
    `Error: You (${agentId}, role: ${role}) cannot call ${toolName}. ` +
    `This tool is for ${allowed} roles. ${suggestion}`
  );
}

export interface McpServerOptions {
  projectName?: string;
  agentManager?: AgentManager;
  acpAdapter?: AcpAdapter;
  agentRole?: string;
}

export function createMcpServer(projectNameOrOpts?: string | McpServerOptions): McpServer {
  const opts = typeof projectNameOrOpts === 'string'
    ? { projectName: projectNameOrOpts }
    : projectNameOrOpts ?? {};
  const name = opts.projectName ?? ENV_PROJECT ?? ProjectStore.resolve(process.cwd());
  const acpAdapter = opts.acpAdapter ?? null;
  // Only fall back to ENV_AGENT_ROLE when called with no arguments at all (CLI entry point).
  // Explicit callers (string or opts object) get unfiltered tools unless they set agentRole.
  const agentRole = projectNameOrOpts === undefined
    ? (ENV_AGENT_ROLE ?? undefined)
    : opts.agentRole;
  if (!name) {
    throw new Error('No Flightdeck project found. Run `flightdeck init` first or pass --project.');
  }

  const fd = new Flightdeck(name);
  const roleRegistry = fd.roles;
  const agentManager = opts.agentManager ?? null;

  // When no AgentManager (MCP subprocess), create HTTP relay to gateway
  // Only create relay when FLIGHTDECK_URL is explicitly set (indicates gateway is running)
  const gatewayUrl = process.env.FLIGHTDECK_URL;
  const relay = !agentManager && gatewayUrl ? new GatewayRelay(gatewayUrl, name) : null;

  const server = new McpServer({ name: 'flightdeck', version: '2.0.0' });

  // Wrap server.tool to inject AsyncLocalStorage context for tool call notifications
  const originalTool = server.tool.bind(server);
  server.tool = ((...args: any[]) => {
    // server.tool(name, description, schema, handler) or server.tool(name, schema, handler)
    const toolName = args[0] as string;
    const handlerIdx = args.length - 1;
    const originalHandler = args[handlerIdx];
    args[handlerIdx] = (params: any) => {
      const agentId = getEnvAgentId() || 'unknown';
      return toolCallContext.run(
        { toolName, agentId, input: params, startTime: Date.now(), relay },
        () => {
          relay?.notifyToolCall({ toolName, agentId, input: params, output: null, status: 'running' });
          return originalHandler(params);
        }
      );
    };
    return (originalTool as any)(...args);
  }) as typeof server.tool;

  // Helper: check permission
  function checkPerm(agent: Agent, permission: string, toolName: string): ReturnType<typeof errorResponse> | null {
    if (!roleRegistry.hasPermission(agent.role, permission)) {
      return permError(agent.id, agent.role, toolName, permission);
    }
    return null;
  }

  // ── Task tools ──

  server.tool('flightdeck_task_list', 'List tasks for the project (shows hierarchy for epics). Filter by state, role, or assignee.', {
    specId: z.string().optional(),
    state: z.enum(['pending', 'ready', 'running', 'in_review', 'done', 'failed', 'skipped', 'cancelled', 'gated', 'paused']).optional().describe('Filter by task state'),
    role: z.string().optional().describe('Filter by assigned role'),
    assignedAgent: z.string().optional().describe('Filter by assigned agent ID'),
  }, async (params) => {
    let tasks = fd.listTasks(params.specId as SpecId | undefined);
    if (params.state) tasks = tasks.filter(t => t.state === params.state);
    if (params.role) tasks = tasks.filter(t => t.role === params.role);
    if (params.assignedAgent) tasks = tasks.filter(t => t.assignedAgent === params.assignedAgent);
    // Group tasks: top-level first, then indent sub-tasks under their parent
    const topLevel = tasks.filter(t => t.parentTaskId === null);
    const byParent = new Map<string, typeof tasks>();
    for (const t of tasks) {
      if (t.parentTaskId) {
        if (!byParent.has(t.parentTaskId)) byParent.set(t.parentTaskId, []);
        byParent.get(t.parentTaskId)!.push(t);
      }
    }
    // Build hierarchical result
    const result: Array<Record<string, unknown>> = [];
    for (const t of topLevel) {
      const children = byParent.get(t.id);
      if (children && children.length > 0) {
        const doneCount = children.filter(c => c.state === 'done' || c.state === 'skipped').length;
        result.push({ ...t, _epic: true, _progress: `${doneCount}/${children.length} done`, subTasks: children });
      } else {
        result.push(t as unknown as Record<string, unknown>);
      }
    }
    return jsonResponse(result);
  });

  server.tool('flightdeck_task_get', 'Get details for a single task', {
    taskId: z.string(),
  }, async (params) => {
    const task = fd.sqlite.getTask(params.taskId as TaskId);
    if (!task) return errorResponse(`Task not found: ${params.taskId}`);
    return jsonResponse(task);
  });

  server.tool('flightdeck_task_add', 'Add a new task to the DAG', {
    title: z.string(),
    description: z.string().optional(),
    specId: z.string().optional(),
    role: z.enum(['lead', 'planner', 'worker', 'reviewer', 'product-thinker', 'qa-tester', 'tech-writer']).optional(),
    dependsOn: z.array(z.string()).optional(),
    priority: z.number().optional(),
    needsReview: z.boolean().optional().describe('If false, skip review and auto-complete on submit. Default: true.'),
  }, async (params) => {
    const { agent, error } = resolveAgent(fd, 'flightdeck_task_add');
    if (error) return error;
    const permErr = checkPerm(agent!, 'task_add', 'flightdeck_task_add');
    if (permErr) return permErr;
    try {
      const task = fd.addTask({
        title: params.title,
        description: params.description,
        specId: params.specId as SpecId | undefined,
        role: params.role as AgentRole | undefined,
        dependsOn: params.dependsOn as TaskId[] | undefined,
        priority: params.priority,
        needsReview: params.needsReview,
      });
      return jsonResponse(task);
    } catch (err) {
      return errorResponse(`Error: Failed to add task '${params.title}' — ${(err as Error).message}.`);
    }
  });

  server.tool('flightdeck_task_claim', 'Claim a ready task', {
    taskId: z.string(),
  }, async (params) => {
    const { agent, error } = resolveAgent(fd, 'flightdeck_task_claim');
    if (error) return error;
    const permErr = checkPerm(agent!, 'task_claim', 'flightdeck_task_claim');
    if (permErr) return permErr;
    try {
      const task = fd.claimTask(params.taskId as TaskId, resolveCallerId() as AgentId);
      return jsonResponse(task);
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes('not found')) {
        return errorResponse(`Error: Task '${params.taskId}' not found. Use flightdeck_task_list() to see available tasks.`);
      }
      if (msg.includes('not ready')) {
        const task = fd.sqlite.getTask(params.taskId as TaskId);
        return errorResponse(`Error: Cannot claim task '${params.taskId}' — current state is '${task?.state ?? 'unknown'}', must be 'ready'. Use flightdeck_task_list() to find ready tasks.`);
      }
      return errorResponse(`Error: ${msg}`);
    }
  });

  server.tool('flightdeck_task_submit', 'Submit completed work with claim', {
    taskId: z.string(),
    claim: z.string().optional(),
  }, async (params) => {
    const { agent, error } = resolveAgent(fd, 'flightdeck_task_submit');
    if (error) return error;
    const permErr = checkPerm(agent!, 'task_submit', 'flightdeck_task_submit');
    if (permErr) return permErr;
    try {
      const task = fd.submitTask(params.taskId as TaskId, params.claim);
      return jsonResponse(task);
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes('not found')) {
        return errorResponse(`Error: Task '${params.taskId}' not found. Use flightdeck_task_list() to see available tasks.`);
      }
      if (msg.includes('not running')) {
        const task = fd.sqlite.getTask(params.taskId as TaskId);
        return errorResponse(`Error: Cannot submit task '${params.taskId}' — current state is '${task?.state ?? 'unknown'}', must be 'running'. Did you forget to call flightdeck_task_claim() first?`);
      }
      return errorResponse(`Error: ${msg}`);
    }
  });

  server.tool('flightdeck_task_fail', 'Report task failure', {
    taskId: z.string(),
    reason: z.string().optional(),
  }, async (params) => {
    const { agent, error } = resolveAgent(fd, 'flightdeck_task_fail');
    if (error) return error;
    const permErr = checkPerm(agent!, 'task_fail', 'flightdeck_task_fail');
    if (permErr) return permErr;
    try {
      const task = fd.failTask(params.taskId as TaskId);
      return jsonResponse(task);
    } catch (err) {
      return errorResponse(`Error: ${(err as Error).message}`);
    }
  });

  server.tool('flightdeck_task_cancel', 'Cancel a task', {
    taskId: z.string(),
  }, async (params) => {
    const { agent, error } = resolveAgent(fd, 'flightdeck_task_cancel');
    if (error) return error;
    const permErr = checkPerm(agent!, 'task_cancel', 'flightdeck_task_cancel');
    if (permErr) return permErr;
    try {
      const task = fd.cancelTask(params.taskId as TaskId);
      return jsonResponse(task);
    } catch (err) {
      return errorResponse(`Error: ${(err as Error).message}`);
    }
  });

  server.tool('flightdeck_task_pause', 'Pause a task', {
    taskId: z.string(),
  }, async (params) => {
    const { agent, error } = resolveAgent(fd, 'flightdeck_task_pause');
    if (error) return error;
    const permErr = checkPerm(agent!, 'task_pause', 'flightdeck_task_pause');
    if (permErr) return permErr;
    try {
      const task = fd.pauseTask(params.taskId as TaskId);
      return jsonResponse(task);
    } catch (err) {
      return errorResponse(`Error: ${(err as Error).message}`);
    }
  });

  server.tool('flightdeck_task_resume', 'Resume a paused task (paused → running)', {
    taskId: z.string(),
  }, async (params) => {
    const { agent, error } = resolveAgent(fd, 'flightdeck_task_resume');
    if (error) return error;
    const permErr = checkPerm(agent!, 'task_resume', 'flightdeck_task_resume');
    if (permErr) return permErr;
    try {
      const task = fd.resumeTask(params.taskId as TaskId);
      return jsonResponse(task);
    } catch (err) {
      return errorResponse(`Error: ${(err as Error).message}`);
    }
  });

  server.tool('flightdeck_task_retry', 'Retry a failed task', {
    taskId: z.string(),
  }, async (params) => {
    const { agent, error } = resolveAgent(fd, 'flightdeck_task_retry');
    if (error) return error;
    const permErr = checkPerm(agent!, 'task_retry', 'flightdeck_task_retry');
    if (permErr) return permErr;
    try {
      const task = fd.retryTask(params.taskId as TaskId);
      return jsonResponse(task);
    } catch (err) {
      return errorResponse(`Error: ${(err as Error).message}`);
    }
  });

  server.tool('flightdeck_task_skip', 'Skip a task (unblocks dependents)', {
    taskId: z.string(),
  }, async (params) => {
    const { agent, error } = resolveAgent(fd, 'flightdeck_task_skip');
    if (error) return error;
    const permErr = checkPerm(agent!, 'task_skip', 'flightdeck_task_skip');
    if (permErr) return permErr;
    try {
      const task = fd.skipTask(params.taskId as TaskId);
      return jsonResponse(task);
    } catch (err) {
      return errorResponse(`Error: ${(err as Error).message}`);
    }
  });

  server.tool('flightdeck_task_complete', 'Complete a task (in_review → done)', {
    taskId: z.string(),
  }, async (params) => {
    const { agent, error } = resolveAgent(fd, 'flightdeck_task_complete');
    if (error) return error;
    const permErr = checkPerm(agent!, 'task_complete', 'flightdeck_task_complete');
    if (permErr) return permErr;
    try {
      const task = fd.completeTask(params.taskId as TaskId);
      return jsonResponse(task);
    } catch (err) {
      return errorResponse(`Error: ${(err as Error).message}`);
    }
  });

  server.tool('flightdeck_task_reopen', 'Reopen a completed task (done → ready)', {
    taskId: z.string(),
  }, async (params) => {
    const { agent, error } = resolveAgent(fd, 'flightdeck_task_reopen');
    if (error) return error;
    const permErr = checkPerm(agent!, 'task_reopen', 'flightdeck_task_reopen');
    if (permErr) return permErr;
    try {
      const task = fd.reopenTask(params.taskId as TaskId);
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
    })),
  }, async (params) => {
    const { agent, error } = resolveAgent(fd, 'flightdeck_declare_tasks');
    if (error) return error;
    const permErr = checkPerm(agent!, 'declare_tasks', 'flightdeck_declare_tasks');
    if (permErr) return permErr;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- MCP SDK type mismatch with internal types
      const tasks = fd.declareTasks(params.tasks as any);
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
    })),
  }, async (params) => {
    const { agent, error } = resolveAgent(fd, 'flightdeck_declare_subtasks');
    if (error) return error;
    const permErr = checkPerm(agent!, 'declare_tasks', 'flightdeck_declare_subtasks');
    if (permErr) return permErr;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- MCP SDK type mismatch with internal types
      const tasks = fd.declareSubTasks(params.parentTaskId as any, params.tasks as any);
      return jsonResponse(tasks);
    } catch (err) {
      return errorResponse(`Error: ${(err as Error).message}`);
    }
  });

  server.tool('flightdeck_task_compact', 'Compact a completed task to save context (FR-015)', {
    taskId: z.string(),
    summary: z.string().optional(),
  }, async (params) => {
    const { agent, error } = resolveAgent(fd, 'flightdeck_task_compact');
    if (error) return error;
    const permErr = checkPerm(agent!, 'task_compact', 'flightdeck_task_compact');
    if (permErr) return permErr;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- MCP SDK type mismatch with internal types
      const task = fd.compactTask(params.taskId as any, params.summary);
      return jsonResponse(task);
    } catch (err) {
      return errorResponse(`Error: ${(err as Error).message}`);
    }
  });

  // ── Role tools ──

  server.tool('flightdeck_role_list', 'List all available roles (built-in + custom from .github/agents/ and .claude/agents/)', {}, async () => {
    // Discover repo-level custom roles on demand (cwd is the project repo root in MCP subprocess)
    roleRegistry.discoverRepoRoles(process.cwd());
    const roles = roleRegistry.list().map(r => ({
      id: r.id, name: r.name, description: r.description, icon: r.icon, permissions: r.permissions,
    }));
    return jsonResponse(roles);
  });

  server.tool('flightdeck_role_info', 'Get full role details', {
    roleId: z.string(),
  }, async (params) => {
    const role = roleRegistry.get(params.roleId);
    if (!role) return errorResponse(`Role '${params.roleId}' not found.`);
    const specialists = roleRegistry.getSpecialists(params.roleId);
    return jsonResponse({ ...role, specialists });
  });

  // ── Model discovery tool ──

  server.tool('flightdeck_model_list', 'List available models and runtimes across all providers. Use this to decide which runtime:model to assign when spawning agents.', {
  }, async (params) => {
    const { agent, error } = resolveAgent(fd, 'flightdeck_model_list');
    if (error) return error;
    const permErr = checkPerm(agent!, 'agent_spawn', 'flightdeck_model_list');
    if (permErr) return permErr;

    const { modelRegistry: registry } = await import('../agents/ModelTiers.js');
    const { ModelConfig } = await import('../agents/ModelConfig.js');
    const mc = new ModelConfig(fd.project.subpath('.'));
    const roleConfigs = mc.getRoleConfigs();

    const runtimes = registry.getRuntimes();
    const output: Record<string, unknown> = {
      config: {
        default_runtime: mc.getAgentsConfig().default_runtime ?? 'copilot',
        roles: Object.fromEntries(roleConfigs.map(rc => [rc.role, { runtime: rc.runtime, model: rc.model }])),
      },
      discovered_models: Object.fromEntries(
        runtimes.map(rt => {
          const grouped = registry.getModelsGrouped(rt);
          return [rt, {
            high: grouped.high.map(m => m.modelId),
            medium: grouped.medium.map(m => m.modelId),
            fast: grouped.fast.map(m => m.modelId),
          }];
        }),
      ),
    };

    if (runtimes.length === 0) {
      output.note = 'No models discovered yet. Models appear after agents connect. ' +
        'You can still spawn agents with explicit model IDs.';
    }

    return jsonResponse(output);
  });

  // ── Agent lifecycle tools ──

  server.tool('flightdeck_agent_spawn', 'Spawn a new agent', {
    role: z.enum(['lead', 'planner', 'worker', 'reviewer', 'product-thinker', 'qa-tester', 'tech-writer']),
    model: z.string().optional(),
    runtime: z.string().optional().describe('Runtime name (e.g. copilot, opencode, cursor, codex-acp). Uses project config default if not set.'),
    task: z.string().optional(),
    cwd: z.string().optional(),
  }, async (params) => {
    const { agent, error } = resolveAgent(fd, 'flightdeck_agent_spawn');
    if (error) return error;
    const permErr = checkPerm(agent!, 'agent_spawn', 'flightdeck_agent_spawn');
    if (permErr) return permErr;

    // Check budget
    const config = fd.project.getConfig();
    const maxAgents = config.maxConcurrentAgents ?? 10;
    const activeCount = fd.sqlite.getActiveAgentCount();
    if (activeCount >= maxAgents) {
      return errorResponse(`Error: Agent limit reached (${activeCount}/${maxAgents}). Terminate an agent first.`);
    }

    if (agentManager) {
      try {
        // Resolve per-role runtime from project config
        const { ModelConfig } = await import('../agents/ModelConfig.js');
        const mc = new ModelConfig(fd.project.subpath('.'));
        const roleConfig = mc.getRoleConfig(params.role);
        const newAgent = await agentManager.spawnAgent({
          role: params.role as AgentRole,
          model: params.model,
          runtime: params.runtime ?? roleConfig.runtime,
          task: params.task,
          cwd: params.cwd ?? fd.project.subpath('.'),
          projectName: name,
        });
        return jsonResponse(newAgent);
      } catch (err) {
        return errorResponse(`Error spawning agent: ${(err as Error).message}`);
      }
    }

    // Relay via gateway HTTP when in MCP subprocess mode
    if (relay) {
      try {
        const newAgent = await relay.spawnAgent({
          role: params.role,
          model: params.model,
          runtime: params.runtime,
          task: params.task,
          cwd: params.cwd ?? fd.project.subpath('.'),
        });
        return jsonResponse(newAgent);
      } catch (err) {
        return errorResponse(`Error spawning agent via gateway: ${(err as Error).message}`);
      }
    }
    // Fallback: SQLite-only registration (no real process — ghost record)
    const newId = makeAgentId(params.role, Date.now().toString());
    const newAgent: Agent = {
      id: newId,
      role: params.role as AgentRole,
      runtime: 'acp',
      acpSessionId: null,
      status: 'idle',
      currentSpecId: null,
      costAccumulated: 0,
      lastHeartbeat: null,
    };
    fd.sqlite.insertAgent(newAgent);
    return jsonResponse(newAgent);
  });

  server.tool('flightdeck_agent_terminate', 'Terminate an agent', {
    targetAgentId: z.string(),
  }, async (params) => {
    const { agent, error } = resolveAgent(fd, 'flightdeck_agent_terminate');
    if (error) return error;
    const permErr = checkPerm(agent!, 'agent_terminate', 'flightdeck_agent_terminate');
    if (permErr) return permErr;
    const target = fd.sqlite.getAgent(params.targetAgentId as AgentId);
    if (!target) return errorResponse(`Agent '${params.targetAgentId}' not found.`);
    if (agentManager) {
      try {
        await agentManager.terminateAgent(params.targetAgentId as AgentId);
      } catch (err) {
        return errorResponse(`Error terminating agent: ${(err as Error).message}`);
      }
    } else if (relay) {
      try {
        await relay.terminateAgent(params.targetAgentId);
      } catch (err) {
        return errorResponse(`Error terminating agent via gateway: ${(err as Error).message}`);
      }
    } else {
      fd.sqlite.updateAgentStatus(params.targetAgentId as AgentId, 'offline');
    }
    return jsonResponse({ status: 'terminated', agentId: params.targetAgentId });
  });

  server.tool('flightdeck_agent_list', 'List all agents', {
    includeRetired: z.boolean().optional(),
  }, async (params) => {
    const includeRetired = params.includeRetired ?? false;
    if (agentManager) {
      return jsonResponse(agentManager.listAgents(includeRetired));
    }
    return jsonResponse(fd.listAgents(includeRetired));
  });

  server.tool('flightdeck_agent_output', 'Get the accumulated output of a running agent', {
    targetAgentId: z.string().describe('The agent ID to get output from'),
    tail: z.number().optional().describe('Number of lines from the end to return (default 50)'),
  }, async (params) => {
    const tail = params.tail ?? 50;
    try {
      if (agentManager) {
        const result = agentManager.getAgentOutput(params.targetAgentId as import('@flightdeck-ai/shared').AgentId, tail);
        return jsonResponse(result);
      }
      if (relay) {
        const result = await relay.getAgentOutput(params.targetAgentId, tail);
        return jsonResponse(result);
      }
      return errorResponse('No AgentManager or relay available');
    } catch (e: unknown) {
      return errorResponse(e instanceof Error ? e.message : String(e));
    }
  });

  server.tool('flightdeck_agent_hibernate', 'Hibernate a worker — saves session, kills process, pauses assigned task', {
    targetAgentId: z.string(),
  }, async (params) => {
    const { agent, error } = resolveAgent(fd, 'flightdeck_agent_hibernate');
    if (error) return error;
    const permErr = checkPerm(agent!, 'agent_hibernate', 'flightdeck_agent_hibernate');
    if (permErr) return permErr;
    const target = fd.sqlite.getAgent(params.targetAgentId as AgentId);
    if (!target) return errorResponse(`Agent '${params.targetAgentId}' not found.`);

    // Find and pause assigned task
    const tasks = fd.listTasks();
    const assignedTask = tasks.find(t => t.assignedAgent === params.targetAgentId && t.state === 'running');
    if (assignedTask) {
      fd.sqlite.updateTaskState(assignedTask.id, 'paused' as any);
    }

    if (agentManager) {
      try {
        await agentManager.hibernateAgent(params.targetAgentId as AgentId);
      } catch (err) {
        return errorResponse(`Error hibernating agent: ${(err as Error).message}`);
      }
    } else if (relay) {
      try {
        await relay.hibernateAgent(params.targetAgentId);
      } catch (err) {
        return errorResponse(`Error hibernating agent via gateway: ${(err as Error).message}`);
      }
    } else {
      fd.sqlite.updateAgentStatus(params.targetAgentId as AgentId, 'hibernated');
    }
    return jsonResponse({
      status: 'hibernated',
      agentId: params.targetAgentId,
      task: assignedTask ? { id: assignedTask.id, title: assignedTask.title, state: 'paused' } : null,
    });
  });

  server.tool('flightdeck_agent_wake', 'Wake a hibernated worker — resumes session, resumes task', {
    targetAgentId: z.string(),
  }, async (params) => {
    const { agent, error } = resolveAgent(fd, 'flightdeck_agent_wake');
    if (error) return error;
    const permErr = checkPerm(agent!, 'agent_wake', 'flightdeck_agent_wake');
    if (permErr) return permErr;
    const target = fd.sqlite.getAgent(params.targetAgentId as AgentId);
    if (!target) return errorResponse(`Agent '${params.targetAgentId}' not found.`);

    if (agentManager) {
      try {
        const woken = await agentManager.wakeAgent(params.targetAgentId as AgentId);
        // Resume paused task
        const tasks = fd.listTasks();
        const pausedTask = tasks.find(t => t.assignedAgent === params.targetAgentId && t.state === 'paused');
        if (pausedTask) {
          fd.sqlite.updateTaskState(pausedTask.id, 'running' as any);
        }
        return jsonResponse({
          status: 'woken',
          agentId: params.targetAgentId,
          agent: woken,
          task: pausedTask ? { id: pausedTask.id, title: pausedTask.title, state: 'running' } : null,
        });
      } catch (err) {
        return errorResponse(`Error waking agent: ${(err as Error).message}`);
      }
    } else if (relay) {
      try {
        const result = await relay.wakeAgent(params.targetAgentId);
        return jsonResponse(result);
      } catch (err) {
        return errorResponse(`Error waking agent via gateway: ${(err as Error).message}`);
      }
    }
    return errorResponse('No AgentManager or relay available to wake agent.');
  });

  server.tool('flightdeck_agent_retire', 'Permanently dismiss a worker — invisible to lead after this', {
    targetAgentId: z.string(),
  }, async (params) => {
    const { agent, error } = resolveAgent(fd, 'flightdeck_agent_retire');
    if (error) return error;
    const permErr = checkPerm(agent!, 'agent_retire', 'flightdeck_agent_retire');
    if (permErr) return permErr;
    const target = fd.sqlite.getAgent(params.targetAgentId as AgentId);
    if (!target) return errorResponse(`Agent '${params.targetAgentId}' not found.`);

    // Unassign and reset their task to 'ready'
    const tasks = fd.listTasks();
    const assignedTask = tasks.find(t => t.assignedAgent === params.targetAgentId && (t.state === 'running' || t.state === 'paused'));
    if (assignedTask) {
      fd.sqlite.updateTaskState(assignedTask.id, 'ready' as any, null);
    }

    if (agentManager) {
      try {
        await agentManager.retireAgent(params.targetAgentId as AgentId);
      } catch (err) {
        return errorResponse(`Error retiring agent: ${(err as Error).message}`);
      }
    } else if (relay) {
      try {
        await relay.retireAgent(params.targetAgentId);
      } catch (err) {
        return errorResponse(`Error retiring agent via gateway: ${(err as Error).message}`);
      }
    } else {
      fd.sqlite.updateAgentStatus(params.targetAgentId as AgentId, 'retired');
      fd.sqlite.updateAgentAcpSession(params.targetAgentId as AgentId, null);
    }
    return jsonResponse({
      status: 'retired',
      agentId: params.targetAgentId,
      task: assignedTask ? { id: assignedTask.id, title: assignedTask.title, state: 'ready' } : null,
    });
  });

  server.tool('flightdeck_agent_restart', 'Restart an agent', {
    targetAgentId: z.string(),
  }, async (params) => {
    const { agent, error } = resolveAgent(fd, 'flightdeck_agent_restart');
    if (error) return error;
    const permErr = checkPerm(agent!, 'agent_spawn', 'flightdeck_agent_restart');
    if (permErr) return permErr;
    const target = fd.sqlite.getAgent(params.targetAgentId as AgentId);
    if (!target) return errorResponse(`Agent '${params.targetAgentId}' not found.`);
    if (agentManager) {
      try {
        const restarted = await agentManager.restartAgent(params.targetAgentId as AgentId);
        return jsonResponse({ status: 'restarted', agentId: params.targetAgentId, agent: restarted });
      } catch (err) {
        return errorResponse(`Error restarting agent: ${(err as Error).message}`);
      }
    }
    if (relay) {
      try {
        const restarted = await relay.restartAgent(params.targetAgentId);
        return jsonResponse({ status: 'restarted', agentId: params.targetAgentId, agent: restarted });
      } catch (err) {
        return errorResponse(`Error restarting agent via gateway: ${(err as Error).message}`);
      }
    }
    fd.sqlite.updateAgentStatus(params.targetAgentId as AgentId, 'idle');
    return jsonResponse({ status: 'restarted', agentId: params.targetAgentId });
  });

  server.tool('flightdeck_agent_interrupt', 'Send urgent message to an agent', {
    targetAgentId: z.string(),
    message: z.string(),
  }, async (params) => {
    const { agent, error } = resolveAgent(fd, 'flightdeck_agent_interrupt');
    if (error) return error;
    const permErr = checkPerm(agent!, 'agent_spawn', 'flightdeck_agent_interrupt');
    if (permErr) return permErr;
    if (agentManager) {
      // Fire-and-forget to avoid MCP timeout on long steer operations
      agentManager.interruptAgent(params.targetAgentId as AgentId, params.message).catch(() => {});
      return jsonResponse({ status: 'interrupted', targetAgentId: params.targetAgentId });
    }
    if (relay) {
      relay.interruptAgent(params.targetAgentId, params.message).catch(() => {});
      return jsonResponse({ status: 'interrupted', targetAgentId: params.targetAgentId });
    }
    const msg: Message = {
      id: messageId(resolveCallerId()!, params.targetAgentId, Date.now().toString()),
      from: resolveCallerId() as AgentId,
      to: params.targetAgentId as AgentId,
      channel: null,
      content: `[URGENT] ${params.message}`,
      timestamp: new Date().toISOString(),
    };
    fd.sendMessage(msg);
    return jsonResponse({ status: 'interrupted', targetAgentId: params.targetAgentId });
  });

  // ── Communication tools (consolidated) ──

  // --- New consolidated: flightdeck_send ---
  async function handleSend(params: { to?: string; channel?: string; taskId?: string; parentId?: string; content: string }) {
    const from = resolveCallerId();
    if (!from) return errorResponse('Error: FLIGHTDECK_AGENT_ID env var not set.');
    const { error } = resolveAgent(fd, 'flightdeck_send');
    if (error) return error;
    if (!params.to && !params.channel && !params.taskId) {
      return errorResponse('Error: Either "to" (for DM), "channel" (for group), or "taskId" (for task comment) must be set.');
    }

    // Task comment path
    if (params.taskId) {
      if (!fd.messages) return errorResponse('MessageStore not available');
      const senderAgent = fd.sqlite.getAgent(from as AgentId);
      const msg = fd.messages.createMessage({
        threadId: null,
        parentId: params.parentId ?? null,
        taskId: params.taskId,
        authorType: (senderAgent?.role === 'lead' ? 'lead' : 'agent') as 'lead' | 'agent',
        authorId: from,
        content: params.content,
        metadata: null,
      });
      // Broadcast via relay (gateway has WS) or agentManager
      if (relay) {
        try {
          await relay.postTaskComment(params.taskId, msg);
        } catch { /* stored in DB, will show on refresh */ }
      }
      return jsonResponse({ status: 'sent', taskId: params.taskId, messageId: msg.id });
    }
    if (params.to) {
      // DM path
      const msg: Message = {
        id: messageId(from, params.to, Date.now().toString()),
        from: from as AgentId,
        to: params.to as AgentId,
        channel: null,
        content: params.content,
        timestamp: new Date().toISOString(),
        parentId: params.parentId ?? null,
      };
      fd.sendMessage(msg);
      const notifier = fd.orchestrator.getWebhookNotifier();
      if (notifier) notifier.notify(agentMessageEvent(fd.status().config.name, from, params.to, params.content));
      const senderAgent = fd.sqlite.getAgent(from as AgentId);
      const dmText = formatAgentMessage('dm', { from: from, fromRole: senderAgent?.role, content: params.content });
      if (agentManager) {
        try {
          await agentManager.sendToAgent(params.to as AgentId, dmText);
          return jsonResponse({ status: 'delivered', to: params.to });
        } catch {
          return jsonResponse({ status: 'sent', to: params.to, note: 'Agent not reachable; message will be delivered when agent comes online.' });
        }
      }
      if (relay) {
        try {
          await relay.sendToAgent(params.to, dmText);
          return jsonResponse({ status: 'delivered', to: params.to });
        } catch {
          return jsonResponse({ status: 'sent', to: params.to, note: 'Agent not reachable via gateway; message stored for later.' });
        }
      }
      return jsonResponse({ status: 'sent', to: params.to });
    } else {
      // Channel path
      const ch = params.channel!;
      const msg: Message = {
        id: messageId(from, ch, Date.now().toString()),
        from: from as AgentId,
        to: null,
        channel: ch,
        content: params.content,
        timestamp: new Date().toISOString(),
        parentId: params.parentId ?? null,
      };
      fd.sendMessage(msg, ch);
      const chNotifier = fd.orchestrator.getWebhookNotifier();
      if (chNotifier) chNotifier.notify(agentMessageEvent(fd.status().config.name, from, '', params.content, ch));
      return jsonResponse({ status: 'sent', channel: ch });
    }
  }

  server.tool('flightdeck_send', 'Send a message. If "to" is set, sends a DM. If "channel" is set, posts to a group channel. If "taskId" is set, posts a task comment.', {
    to: z.string().optional().describe('Agent ID for DM'),
    channel: z.string().optional().describe('Channel name for group message'),
    taskId: z.string().optional().describe('Task ID to post a comment on'),
    parentId: z.string().optional().describe('Message ID to reply to (quote)'),
    content: z.string(),
  }, async (params) => handleSend(params));

  // --- New consolidated: flightdeck_read ---
  async function handleRead(params: { channel?: string; since?: string }) {
    if (params.channel) {
      const messages = fd.readMessages(params.channel, params.since);
      return jsonResponse(messages);
    } else {
      // DM inbox
      const callerId = resolveCallerId();
      const { error } = resolveAgent(fd, 'flightdeck_read');
      if (error) return error;
      const unread = fd.getUnreadDMs(callerId as AgentId);
      fd.markDMsRead(callerId as AgentId);
      if (unread.length === 0) {
        return jsonResponse({ status: 'empty', messages: [] });
      }
      return jsonResponse({
        status: 'unread',
        count: unread.length,
        messages: unread.map(m => ({
          from: m.from,
          content: m.content,
          timestamp: m.timestamp,
        })),
      });
    }
  }

  server.tool('flightdeck_read', 'Read messages. If "channel" is set, reads group channel. Otherwise reads your DM inbox.', {
    channel: z.string().optional().describe('Channel name to read. Omit for DM inbox.'),
    since: z.string().optional().describe('ISO timestamp to filter messages since'),
  }, async (params) => handleRead(params));

    // ── Search tools (consolidated) ──

  async function handleSearch(params: { query: string; source?: string; authorType?: string; limit?: number; offset?: number }) {
    const source = params.source ?? 'all';
    const limit = Math.min(params.limit ?? 10, 50); // cap at 50
    const offset = params.offset ?? 0;
    // Per-source fetch limit: fetch more internally so pagination works across sources,
    // but cap total collected to avoid blowing up memory
    const fetchLimit = Math.min(limit + offset, 50);
    const results: Array<{ source: string; [key: string]: unknown }> = [];

    // Memory search
    if (source === 'all' || source === 'memory') {
      try {
        const memResults = fd.searchMemory(params.query, fetchLimit);
        for (const r of memResults) {
          results.push({ source: 'memory', ...r });
        }
      } catch { /* memory search may fail on malformed FTS queries */ }
    }

    // Chat message search
    if (source === 'all' || source === 'chat') {
      try {
        if (fd.messages) {
          const chatResults = fd.messages.searchMessages(params.query, {
            authorType: params.authorType as 'user' | 'lead' | 'agent' | 'system' | undefined,
            limit: fetchLimit,
          });
          for (const m of chatResults) {
            results.push({
              source: 'chat',
              id: m.id,
              authorType: m.authorType,
              authorId: m.authorId,
              content: m.content.length > 500 ? m.content.slice(0, 500) + '...' : m.content,
              createdAt: m.createdAt,
              threadId: m.threadId,
              taskId: m.taskId,
            });
          }
        }
      } catch { /* chat search may fail on FTS query issues */ }
    }

    // Session transcript search via gateway API
    if (source === 'all' || source === 'session') {
      if (relay) {
        try {
          const sessionData = await relay.searchSessions(params.query, fetchLimit);
          for (const r of sessionData.results) {
            const rec = r as Record<string, unknown>;
            // Normalize ts (epoch ms) to ISO timestamp for consistency
            if (typeof rec.ts === 'number') {
              rec.timestamp = new Date(rec.ts).toISOString();
            }
            results.push({ source: 'session', ...rec });
          }
        } catch { /* gateway may not be available */ }
      }
    }

    // Apply offset pagination across combined results
    const paged = results.slice(offset, offset + limit);
    // Enforce total character budget (default 8K) to avoid flooding agent context
    const MAX_TOTAL_CHARS = 8_000;
    let totalChars = 0;
    const budgeted = paged.filter(r => {
      const content = (r.content as string) ?? (r.snippet as string) ?? '';
      totalChars += content.length;
      return totalChars <= MAX_TOTAL_CHARS;
    });
    const truncated = budgeted.length < paged.length;
    return jsonResponse({ count: budgeted.length, total: results.length, offset, limit, hasMore: offset + limit < results.length, truncatedByBudget: truncated, results: budgeted });
  }

  server.tool('flightdeck_search', 'Search across all project data sources: chat messages, project memory files, and session transcripts. Results are tagged with their source.', {
    query: z.string().describe('Search query (keywords or phrases)'),
    source: z.enum(['all', 'chat', 'memory', 'session']).optional().describe('Data source to search. Default: all'),
    authorType: z.enum(['user', 'lead', 'agent', 'system']).optional().describe('Filter chat results by author type'),
    limit: z.number().optional().describe('Max results to return (default 10, max 50)'),
    offset: z.number().optional().describe('Skip N results for pagination (default 0)'),
  }, async (params) => handleSearch(params));

  // ── Chat message tools (WebSocket-backed) ──

  server.tool('flightdeck_msg_list', 'List chat messages', {
    thread_id: z.string().optional(),
    task_id: z.string().optional(),
    limit: z.number().optional(),
  }, async (params) => {
    if (!fd.messages) return errorResponse('MessageStore not available (no SQLite chat tables)');
    const msgs = fd.messages.listMessages({
      threadId: params.thread_id,
      taskId: params.task_id,
      limit: params.limit,
    });
    return jsonResponse(msgs);
  });

  server.tool('flightdeck_thread_create', 'Create a chat thread from a message', {
    origin_id: z.string(),
    title: z.string().optional(),
  }, async (params) => {
    if (!fd.messages) return errorResponse('MessageStore not available (no SQLite chat tables)');
    const thread = fd.messages.createThread({
      originId: params.origin_id,
      title: params.title,
    });
    return jsonResponse(thread);
  });

  server.tool('flightdeck_thread_list', 'List chat threads', {
    archived: z.boolean().optional(),
    limit: z.number().optional(),
  }, async (params) => {
    if (!fd.messages) return errorResponse('MessageStore not available (no SQLite chat tables)');
    const threads = fd.messages.listThreads({
      archived: params.archived,
      limit: params.limit,
    });
    return jsonResponse(threads);
  });

  server.tool('flightdeck_memory_read', 'Read a project memory file', {
    filename: z.string().describe('Memory filename (e.g. SOUL.md, MEMORY.md, 2026-04-14.md)'),
  }, async (params) => {
    const content = fd.memory.read(params.filename);
    if (content === null) return errorResponse(`Memory file not found: ${params.filename}`);
    return { content: [{ type: 'text' as const, text: content }] };
  });

  server.tool('flightdeck_memory_log', 'Append an entry to today\'s daily log (append-only)', {
    entry: z.string().describe('Log entry text'),
  }, async (params) => {
    const { agent, error } = resolveAgent(fd, 'flightdeck_memory_log');
    if (error) return error;
    const permErr = checkPerm(agent!, 'memory_write', 'flightdeck_memory_log');
    if (permErr) return permErr;
    try {
      fd.memory.appendDailyLog(`[${agent!.role}/${resolveCallerId()}] ${params.entry}`);
      return jsonResponse({ status: 'logged', filename: fd.memory.getDailyLogFilename() });
    } catch (err) {
      return errorResponse(`Error: ${(err as Error).message}`);
    }
  });

  server.tool('flightdeck_memory_write', 'Write to project memory', {
    filename: z.string(),
    content: z.string(),
  }, async (params) => {
    const { agent, error } = resolveAgent(fd, 'flightdeck_memory_write');
    if (error) return error;
    const permErr = checkPerm(agent!, 'memory_write', 'flightdeck_memory_write');
    if (permErr) return permErr;
    try {
      fd.writeMemory(params.filename, params.content);
      return jsonResponse({ status: 'written', path: `memory/${params.filename}` });
    } catch (err) {
      return errorResponse(`Error: ${(err as Error).message}`);
    }
  });

  // ── Learnings tools ──

  server.tool('flightdeck_learning_add', 'Add a learning', {
    category: z.enum(['pattern', 'gotcha', 'decision', 'performance', 'security']),
    content: z.string(),
    tags: z.array(z.string()).optional(),
  }, async (params) => {
    const { error } = resolveAgent(fd, 'flightdeck_learning_add');
    if (error) return error;
    const learning = fd.learnings.append({
      agentId: resolveCallerId(),
      category: params.category as LearningCategory,
      content: params.content,
      tags: params.tags ?? [],
    });
    return jsonResponse(learning);
  });

  server.tool('flightdeck_learning_search', 'Search learnings', {
    query: z.string(),
  }, async (params) => {
    return jsonResponse(fd.learnings.search(params.query));
  });

  // ── Cost tools ──

  server.tool('flightdeck_cost_report', 'Get cost report', {
  }, async (params) => {
    const { agent, error } = resolveAgent(fd, 'flightdeck_cost_report');
    if (error) return error;
    // Lead only check via permission
    if (!roleRegistry.hasPermission(agent!.role, 'agent_spawn')) {
      return permError(resolveCallerId()!, agent!.role, 'flightdeck_cost_report', 'lead-level access');
    }
    return jsonResponse({
      totalCost: fd.sqlite.getTotalCost(),
      byAgent: fd.sqlite.getCostByAgent(),
      byTask: fd.sqlite.getCostByTask(),
    });
  });

  // ── Timer tools ──

  server.tool('flightdeck_timer_set', 'Set a timer', {
    label: z.string(),
    delayMs: z.number(),
    message: z.string(),
    repeat: z.boolean().optional(),
  }, async (params) => {
    const { error } = resolveAgent(fd, 'flightdeck_timer_set');
    if (error) return error;
    const timer = fd.timers.setTimer(resolveCallerId(), params.label, params.delayMs, params.message, params.repeat);
    return jsonResponse(timer);
  });

  server.tool('flightdeck_timer_cancel', 'Cancel a timer', {
    label: z.string(),
  }, async (params) => {
    const { error } = resolveAgent(fd, 'flightdeck_timer_cancel');
    if (error) return error;
    const cancelled = fd.timers.cancelTimer(resolveCallerId(), params.label);
    return jsonResponse({ cancelled });
  });

  server.tool('flightdeck_timer_list', 'List timers', {
  }, async (params) => {
    const { error } = resolveAgent(fd, 'flightdeck_timer_list');
    if (error) return error;
    return jsonResponse(fd.timers.listTimers(resolveCallerId()));
  });

  // ── Cron tools ──

  server.tool('flightdeck_cron_list', 'List all cron jobs', {}, async () => {
    const jobs = fd.cron.listJobs();
    return jsonResponse(jobs.map(j => ({
      id: j.id,
      name: j.name,
      enabled: j.enabled,
      schedule: j.schedule.expr,
      tz: j.schedule.tz ?? 'UTC',
      skill: j.skill,
      prompt: j.prompt,
      nextRunAt: j.state.nextRunAt,
      lastRunAt: j.state.lastRunAt,
      lastRunStatus: j.state.lastRunStatus,
    })));
  });

  server.tool('flightdeck_cron_add', 'Add a new cron job', {
    name: z.string().describe('Job name'),
    schedule: z.string().describe('Cron expression (e.g. "0 9 * * *")'),
    prompt: z.string().describe('Message to send to Lead when triggered'),
    tz: z.string().optional().describe('IANA timezone (default UTC)'),
    skill: z.string().optional().describe('Skill name to activate'),
    enabled: z.boolean().optional().describe('Whether the job is enabled (default true)'),
  }, async (params) => {
    const job = fd.cron.addJob({
      name: params.name,
      schedule: { kind: 'cron', expr: params.schedule, tz: params.tz },
      prompt: params.prompt,
      skill: params.skill,
      enabled: params.enabled ?? true,
    });
    return jsonResponse(job);
  });

  server.tool('flightdeck_cron_enable', 'Enable a cron job', {
    jobId: z.string().describe('Job ID to enable'),
  }, async (params) => {
    const ok = fd.cron.enableJob(params.jobId);
    if (!ok) return errorResponse(`Cron job '${params.jobId}' not found.`);
    return jsonResponse({ success: true, jobId: params.jobId, enabled: true });
  });

  server.tool('flightdeck_cron_disable', 'Disable a cron job', {
    jobId: z.string().describe('Job ID to disable'),
  }, async (params) => {
    const ok = fd.cron.disableJob(params.jobId);
    if (!ok) return errorResponse(`Cron job '${params.jobId}' not found.`);
    return jsonResponse({ success: true, jobId: params.jobId, enabled: false });
  });

  server.tool('flightdeck_cron_remove', 'Remove a cron job', {
    jobId: z.string().describe('Job ID to remove'),
  }, async (params) => {
    const ok = fd.cron.removeJob(params.jobId);
    if (!ok) return errorResponse(`Cron job '${params.jobId}' not found.`);
    return jsonResponse({ success: true, jobId: params.jobId, removed: true });
  });

  server.tool('flightdeck_cron_run', 'Manually trigger a cron job now', {
    jobId: z.string().describe('Job ID to run'),
  }, async (params) => {
    const job = fd.cron.getJob(params.jobId);
    if (!job) return errorResponse(`Cron job '${params.jobId}' not found.`);
    // Steer Lead via gateway HTTP API if available
    const gatewayBaseUrl = process.env.FLIGHTDECK_URL;
    if (gatewayBaseUrl) {
      try {
        const url = `${gatewayBaseUrl}/api/projects/${encodeURIComponent(name)}/chat`;
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: job.prompt, source: 'cron', jobId: job.id }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return jsonResponse({ success: true, jobId: job.id, message: 'Job triggered — Lead has been steered.' });
      } catch (err) {
        return errorResponse(`Failed to steer Lead: ${(err as Error).message}`);
      }
    }
    return jsonResponse({ success: true, jobId: job.id, prompt: job.prompt, skill: job.skill, message: 'Job details returned — steer Lead with this prompt.' });
  });

  // ── Status tools ──

  server.tool('flightdeck_status', 'Get project status', {}, async () => {
    const status = fd.status();
    return jsonResponse(status);
  });

  server.tool('flightdeck_spec_list', 'List specs', {}, async () => {
    const specs = fd.listSpecs();
    return jsonResponse(specs.map(s => ({ id: s.id, title: s.title, filename: s.filename })));
  });

  server.tool('flightdeck_spec_create', 'Create a new spec document', {
    title: z.string().describe('Spec title'),
    content: z.string().describe('Spec content (markdown)'),
  }, async (params) => {
    const { agent, error } = resolveAgent(fd, 'flightdeck_spec_create');
    if (error) return error;
    const permErr = checkPerm(agent!, 'spec_create', 'flightdeck_spec_create');
    if (permErr) return permErr;
    try {
      const spec = fd.createSpec(params.title, params.content);
      return jsonResponse({ status: 'created', id: spec.id, title: spec.title, filename: spec.filename });
    } catch (err) {
      return errorResponse(`Error: ${(err as Error).message}`);
    }
  });

  server.tool('flightdeck_spec_changes', 'List recent spec changes detected by the system', {}, async () => {
    const changes = fd.orchestrator.getRecentSpecChanges();
    return jsonResponse(changes);
  });

  server.tool('flightdeck_task_clear_stale', 'Clear stale flag on a task after re-planning', {
    taskId: z.string(),
  }, async (params) => {
    const { agent, error } = resolveAgent(fd, 'flightdeck_task_clear_stale');
    if (error) return error;
    const permErr = checkPerm(agent!, 'task_add', 'flightdeck_task_clear_stale');
    if (permErr) return permErr;
    fd.sqlite.clearTaskStale(params.taskId as TaskId);
    return jsonResponse({ status: 'ok', taskId: params.taskId });
  });

  server.tool('flightdeck_escalate', 'Escalate to lead/planner', {
    taskId: z.string(),
    reason: z.string(),
  }, async (params) => {
    const { error } = resolveAgent(fd, 'flightdeck_escalate');
    if (error) return error;
    const msg: Message = {
      id: messageId(resolveCallerId()!, 'escalation', Date.now().toString()),
      from: resolveCallerId() as AgentId,
      to: null,
      channel: 'escalations',
      content: `ESCALATION for task ${params.taskId}: ${params.reason}`,
      timestamp: new Date().toISOString(),
    };
    fd.sendMessage(msg, 'escalations');
    return jsonResponse({ status: 'escalated', taskId: params.taskId });
  });

  server.tool('flightdeck_discuss', 'Create a group discussion', {
    topic: z.string(),
    invitees: z.array(z.string()).optional(),
  }, async (params) => {
    const { agent, error } = resolveAgent(fd, 'flightdeck_discuss');
    if (error) return error;
    const permErr = checkPerm(agent!, 'discuss', 'flightdeck_discuss');
    if (permErr) return permErr;
    // Use hash-based slug to avoid truncation with non-ASCII (e.g. Chinese) topics
    const topicHash = Array.from(params.topic).reduce((h, c) => ((h << 5) - h + c.charCodeAt(0)) | 0, 0);
    const channel = `discuss-${Math.abs(topicHash).toString(36)}-${Date.now().toString(36)}`;
    const now = new Date().toISOString();
    const initMsg: Message = {
      id: messageId('system', channel, now),
      from: resolveCallerId() as AgentId,
      to: null,
      channel,
      content: `Discussion created: "${params.topic}"\nInvitees: ${(params.invitees ?? []).join(', ') || 'open'}\nCreated: ${now}`,
      timestamp: now,
    };
    fd.sendMessage(initMsg, channel);
    return jsonResponse({ channel, topic: params.topic, invitees: params.invitees ?? [], createdAt: now });
  });

  // ── Skill tools ──

  const skillManager = new SkillManager(fd.project.cwd ?? process.cwd());

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
    const { error } = resolveAgent(fd, 'flightdeck_decision_log');
    if (error) return error;
    const resolvedId = resolveCallerId()!;
    const id = makeDecisionId(params.taskId, params.title, Date.now().toString());
    const decision = {
      id: id as DecisionId,
      taskId: params.taskId as TaskId,
      agentId: resolvedId as AgentId,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- MCP SDK type mismatch with internal types
      type: params.type as any,
      title: params.title,
      reasoning: params.reasoning,
      alternatives: params.alternatives ?? [],
      confidence: params.confidence,
      reversible: params.reversible,
      timestamp: new Date().toISOString(),
      status: 'pending_review' as DecisionStatus,
    };
    // Let governance evaluate
    const result = fd.governance.evaluateDecision(decision);
    if (result.allowed && result.action === 'approve') {
      decision.status = 'auto_approved';
    }
    fd.decisions.append(decision);
    return jsonResponse(decision);
  });

  server.tool('flightdeck_decision_list', 'List recent decisions', {
    taskId: z.string().optional(),
    type: z.string().optional(),
    status: z.string().optional(),
    since: z.string().optional(),
    limit: z.number().optional(),
  }, async (params) => {
    const decisions = fd.decisions.list({
      taskId: params.taskId,
      type: params.type,
      status: params.status,
      since: params.since,
      limit: params.limit,
    });
    return jsonResponse(decisions);
  });

  // ── Report tool ──

  server.tool('flightdeck_report', 'Generate daily report', {
    since: z.string().optional(),
  }, async (params) => {
    const report = new DailyReport(fd.sqlite, fd.decisions);
    const markdown = report.generate({ since: params.since });
    return { content: [{ type: 'text' as const, text: markdown }] };
  });

  // ── Skill tools ──

  server.tool('flightdeck_skill_list', 'List available skills and their role assignments', {}, async () => {
    skillManager.loadProjectConfig();
    const installed = skillManager.listInstalledSkills();
    const repoSkills = skillManager.discoverRepoSkills(process.cwd());
    skillManager.loadProjectConfig();
    const roleAssignments: Record<string, string[]> = {};
    const allRoles = ['lead', 'planner', 'worker', 'reviewer'] as const;
    for (const role of allRoles) {
      roleAssignments[role] = skillManager.getSkillsForRole(role);
    }
    return jsonResponse({ installed, repoSkills, roleAssignments });
  });

  server.tool('flightdeck_skill_install', 'Install a skill from a source directory', {
    source: z.string().describe('Path to skill directory containing SKILL.md'),
  }, async (params) => {
    const { agent, error } = resolveAgent(fd, 'flightdeck_skill_install');
    if (error) return error;
    // Only lead can install skills
    if (agent!.role !== 'lead') {
      return permError(resolveCallerId()!, agent!.role, 'flightdeck_skill_install', 'skill_install');
    }
    const result = skillManager.installSkill(params.source);
    if (!result) return errorResponse('Failed to install skill. Check that the source directory exists and contains a SKILL.md.');
    return jsonResponse(result);
  });

  // ── Model tools ──
  // flightdeck_model_list is defined above (model discovery section) with full config + discovered models

  server.tool('flightdeck_model_config', 'Get current model configuration per role', {}, async () => {
    const cwd = process.cwd();
    const mc = new ModelConfig(cwd);
    return jsonResponse({ roles: mc.getRoleConfigs() });
  });

  server.tool('flightdeck_model_set', 'Change a running agent\'s model (Lead only, user-requested)', {
    agent_id: z.string().describe('Agent ID to change model for'),
    model: z.string().describe('Tier name (high/medium/fast) or specific model ID'),
    reason: z.string().optional().describe('Why the model is being changed (logged)'),
  }, async (params) => {
    const { agent, error } = resolveAgent(fd, 'flightdeck_model_set');
    if (error) return error;
    if (agent!.role !== 'lead') {
      return permError(resolveCallerId()!, agent!.role, 'flightdeck_model_set', 'agent_spawn');
    }
    if (!acpAdapter) {
      return errorResponse('Model changes require an ACP adapter. Start flightdeck with `flightdeck start`.');
    }

    // Find the target agent's session
    const targetAgent = fd.sqlite.getAgent(params.agent_id as AgentId);
    if (!targetAgent) return errorResponse(`Agent '${params.agent_id}' not found.`);

    // Resolve tier to model ID if needed
    const runtimes = modelRegistry.getRuntimes();
    const runtimeName = runtimes[0]; // use first available runtime
    const resolvedModel = modelRegistry.resolveModel(runtimeName ?? '', params.model);
    if (!resolvedModel) {
      return errorResponse(`Could not resolve model '${params.model}'. No models registered for runtime.`);
    }

    // Find session for target agent
    const sessions = acpAdapter.getAllSessions();
    const targetSession = sessions.find(s => s.agentId === params.agent_id);
    if (!targetSession) {
      return errorResponse(`No active session found for agent '${params.agent_id}'.`);
    }

    try {
      await acpAdapter.setModel(targetSession.id, resolvedModel);
      const logMsg = `Model changed for ${params.agent_id}: ${resolvedModel}${params.reason ? ` — ${params.reason}` : ''}`;
      return jsonResponse({ success: true, model: resolvedModel, message: logMsg });
    } catch (err) {
      return errorResponse(`Failed to set model: ${(err as Error).message}`);
    }
  });

  // ── Suggestion tools ──

  server.tool('flightdeck_suggestion_list', 'List scout suggestions', {
    spec_id: z.string().optional().describe('Filter by spec ID'),
    status: z.enum(['pending', 'approved', 'rejected']).optional().describe('Filter by status'),
  }, async (params) => {
    const suggestions = fd.suggestions.list({
      specId: params.spec_id,
      status: params.status,
    });
    return jsonResponse(suggestions);
  });

  server.tool('flightdeck_suggestion_approve', 'Approve a scout suggestion (creates follow-up tasks)', {
    id: z.string().describe('Suggestion ID to approve'),
  }, async (params) => {
    const { agent, error } = resolveAgent(fd, 'flightdeck_suggestion_approve');
    if (error) return error;
    if (agent!.role !== 'lead') {
      return permError(resolveCallerId()!, agent!.role, 'flightdeck_suggestion_approve', 'task_add');
    }
    const suggestion = fd.suggestions.updateStatus(params.id, 'approved');
    if (!suggestion) return errorResponse(`Suggestion '${params.id}' not found.`);
    return jsonResponse({ success: true, suggestion });
  });

  server.tool('flightdeck_suggestion_reject', 'Reject a scout suggestion', {
    id: z.string().describe('Suggestion ID to reject'),
  }, async (params) => {
    const { agent, error } = resolveAgent(fd, 'flightdeck_suggestion_reject');
    if (error) return error;
    if (agent!.role !== 'lead') {
      return permError(resolveCallerId()!, agent!.role, 'flightdeck_suggestion_reject', 'task_add');
    }
    const suggestion = fd.suggestions.updateStatus(params.id, 'rejected');
    if (!suggestion) return errorResponse(`Suggestion '${params.id}' not found.`);
    return jsonResponse({ success: true, suggestion });
  });

  // ── Tools available (self-discovery) ──

  server.tool('flightdeck_tools_available', 'List the MCP tools available to the calling agent', {}, async () => {
    if (agentRole) {
      const tools = getToolsForRole(agentRole);
      return jsonResponse({ role: agentRole, tools });
    }
    // No role filtering — return all tool names
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- accessing private SDK property for tool introspection
    const allTools = Object.keys((server as any)._registeredTools ?? {});
    return jsonResponse({ role: null, tools: allTools });
  });

  // ── Isolation status ──

  server.tool('flightdeck_isolation_status', 'Show current isolation mode and active worktrees/workdirs', {}, async () => {
    const project = fd.project.getConfig();
    const isolationMode = project.isolation ?? 'none';
    const { IsolationManager } = await import('../isolation/IsolationManager.js');
    const im = new IsolationManager(fd.project.cwd ?? process.cwd(), {
      mode: isolationMode as 'none' | 'git_worktree' | 'directory',
    });
    return jsonResponse(im.status());
  });

  // ── Webhook test tool ──
  server.tool('flightdeck_webhook_test', 'Send a test message to all configured webhooks', {}, async () => {
    const notifier = fd.orchestrator.getWebhookNotifier();
    if (notifier.count === 0) {
      return errorResponse('No webhooks configured. Add notifications.webhooks to your project config.');
    }
    const result = await notifier.sendTest();
    return jsonResponse(result);
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
