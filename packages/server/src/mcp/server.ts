import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { Flightdeck } from '../facade.js';
import { ProjectStore } from '../storage/ProjectStore.js';
import type { TaskId, AgentId, SpecId, Message, MessageId, Agent, AgentRole } from '@flightdeck-ai/shared';
import { messageId, agentId as makeAgentId } from '@flightdeck-ai/shared';
import type { LearningCategory } from '../storage/LearningsStore.js';
import type { AgentManager } from '../agents/AgentManager.js';

const ENV_AGENT_ID = process.env.FLIGHTDECK_AGENT_ID || undefined;

function errorResponse(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function jsonResponse(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

function resolveAgent(fd: Flightdeck, agentId: string, toolName: string) {
  const agent = fd.sqlite.getAgent(agentId as AgentId);
  if (!agent) {
    return { error: errorResponse(`Error: Agent '${agentId}' not found. Register the agent first or check the ID. Use flightdeck_status() to see registered agents.`) };
  }
  return { agent };
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
    task_retry: 'lead',
    task_skip: 'lead/planner',
    task_complete: 'lead/reviewer',
    task_reopen: 'lead',
    declare_tasks: 'lead/planner',
    agent_spawn: 'lead',
    agent_terminate: 'lead',
    memory_write: 'worker/product-thinker/qa-tester/tech-writer',
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
}

export function createMcpServer(projectNameOrOpts?: string | McpServerOptions): McpServer {
  const opts = typeof projectNameOrOpts === 'string'
    ? { projectName: projectNameOrOpts }
    : projectNameOrOpts ?? {};
  const name = opts.projectName ?? ProjectStore.resolve(process.cwd());
  if (!name) {
    throw new Error('No Flightdeck project found. Run `flightdeck init` first or pass --project.');
  }

  const fd = new Flightdeck(name);
  const roleRegistry = fd.roles;
  const agentManager = opts.agentManager ?? null;
  const server = new McpServer({ name: 'flightdeck', version: '2.0.0' });

  // Helper: check permission
  function checkPerm(agent: Agent, permission: string, toolName: string): ReturnType<typeof errorResponse> | null {
    if (!roleRegistry.hasPermission(agent.role, permission)) {
      return permError(agent.id, agent.role, toolName, permission);
    }
    return null;
  }

  // ── Task tools ──

  server.tool('flightdeck_task_list', 'List tasks for the project', {
    specId: z.string().optional(),
  }, async (params) => {
    const tasks = fd.listTasks(params.specId as SpecId | undefined);
    return jsonResponse(tasks);
  });

  server.tool('flightdeck_task_add', 'Add a new task to the DAG', {
    title: z.string(),
    description: z.string().optional(),
    specId: z.string().optional(),
    role: z.enum(['lead', 'planner', 'worker', 'reviewer', 'product-thinker', 'qa-tester', 'tech-writer']).optional(),
    dependsOn: z.array(z.string()).optional(),
    priority: z.number().optional(),
    agentId: z.string(),
  }, async (params) => {
    const { agent, error } = resolveAgent(fd, params.agentId, 'flightdeck_task_add');
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
      });
      return jsonResponse(task);
    } catch (err) {
      return errorResponse(`Error: Failed to add task '${params.title}' — ${(err as Error).message}.`);
    }
  });

  server.tool('flightdeck_task_claim', 'Claim a ready task', {
    taskId: z.string(),
    agentId: z.string(),
  }, async (params) => {
    const { agent, error } = resolveAgent(fd, params.agentId, 'flightdeck_task_claim');
    if (error) return error;
    const permErr = checkPerm(agent!, 'task_claim', 'flightdeck_task_claim');
    if (permErr) return permErr;
    try {
      const task = fd.claimTask(params.taskId as TaskId, params.agentId as AgentId);
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
    agentId: z.string(),
    claim: z.string().optional(),
  }, async (params) => {
    const { agent, error } = resolveAgent(fd, params.agentId, 'flightdeck_task_submit');
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
    agentId: z.string(),
    reason: z.string().optional(),
  }, async (params) => {
    const { agent, error } = resolveAgent(fd, params.agentId, 'flightdeck_task_fail');
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
    agentId: z.string(),
  }, async (params) => {
    const { agent, error } = resolveAgent(fd, params.agentId, 'flightdeck_task_cancel');
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
    agentId: z.string(),
  }, async (params) => {
    const { agent, error } = resolveAgent(fd, params.agentId, 'flightdeck_task_pause');
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

  server.tool('flightdeck_task_retry', 'Retry a failed task', {
    taskId: z.string(),
    agentId: z.string(),
  }, async (params) => {
    const { agent, error } = resolveAgent(fd, params.agentId, 'flightdeck_task_retry');
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
    agentId: z.string(),
  }, async (params) => {
    const { agent, error } = resolveAgent(fd, params.agentId, 'flightdeck_task_skip');
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
    agentId: z.string(),
  }, async (params) => {
    const { agent, error } = resolveAgent(fd, params.agentId, 'flightdeck_task_complete');
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
    agentId: z.string(),
  }, async (params) => {
    const { agent, error } = resolveAgent(fd, params.agentId, 'flightdeck_task_reopen');
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

  server.tool('flightdeck_declare_tasks', 'Batch create tasks with dependencies', {
    tasks: z.array(z.object({
      title: z.string(),
      description: z.string().optional(),
      specId: z.string().optional(),
      role: z.enum(['lead', 'planner', 'worker', 'reviewer', 'product-thinker', 'qa-tester', 'tech-writer']).optional(),
      dependsOn: z.array(z.string()).optional(),
      priority: z.number().optional(),
    })),
    agentId: z.string(),
  }, async (params) => {
    const { agent, error } = resolveAgent(fd, params.agentId, 'flightdeck_declare_tasks');
    if (error) return error;
    const permErr = checkPerm(agent!, 'declare_tasks', 'flightdeck_declare_tasks');
    if (permErr) return permErr;
    try {
      const tasks = fd.declareTasks(params.tasks as any);
      return jsonResponse(tasks);
    } catch (err) {
      return errorResponse(`Error: ${(err as Error).message}`);
    }
  });

  // ── Role tools ──

  server.tool('flightdeck_role_list', 'List all available roles', {}, async () => {
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

  // ── Agent lifecycle tools ──

  server.tool('flightdeck_agent_spawn', 'Spawn a new agent', {
    role: z.enum(['lead', 'planner', 'worker', 'reviewer', 'product-thinker', 'qa-tester', 'tech-writer']),
    model: z.string().optional(),
    task: z.string().optional(),
    cwd: z.string().optional(),
    agentId: z.string(),
  }, async (params) => {
    const { agent, error } = resolveAgent(fd, params.agentId, 'flightdeck_agent_spawn');
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
        const newAgent = await agentManager.spawnAgent({
          role: params.role as AgentRole,
          model: params.model,
          task: params.task,
          cwd: params.cwd ?? process.cwd(),
        });
        return jsonResponse(newAgent);
      } catch (err) {
        return errorResponse(`Error spawning agent: ${(err as Error).message}`);
      }
    }

    // Fallback: SQLite-only registration (no real process)
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
    agentId: z.string(),
  }, async (params) => {
    const { agent, error } = resolveAgent(fd, params.agentId, 'flightdeck_agent_terminate');
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
    } else {
      fd.sqlite.updateAgentStatus(params.targetAgentId as AgentId, 'offline');
    }
    return jsonResponse({ status: 'terminated', agentId: params.targetAgentId });
  });

  server.tool('flightdeck_agent_list', 'List all agents', {}, async () => {
    return jsonResponse(fd.listAgents());
  });

  server.tool('flightdeck_agent_restart', 'Restart an agent', {
    targetAgentId: z.string(),
    agentId: z.string(),
  }, async (params) => {
    const { agent, error } = resolveAgent(fd, params.agentId, 'flightdeck_agent_restart');
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
    fd.sqlite.updateAgentStatus(params.targetAgentId as AgentId, 'idle');
    return jsonResponse({ status: 'restarted', agentId: params.targetAgentId });
  });

  server.tool('flightdeck_agent_interrupt', 'Send urgent message to an agent', {
    targetAgentId: z.string(),
    message: z.string(),
    agentId: z.string(),
  }, async (params) => {
    const { agent, error } = resolveAgent(fd, params.agentId, 'flightdeck_agent_interrupt');
    if (error) return error;
    const permErr = checkPerm(agent!, 'agent_spawn', 'flightdeck_agent_interrupt');
    if (permErr) return permErr;
    if (agentManager) {
      try {
        await agentManager.interruptAgent(params.targetAgentId as AgentId, params.message);
        return jsonResponse({ status: 'interrupted', targetAgentId: params.targetAgentId });
      } catch (err) {
        return errorResponse(`Error interrupting agent: ${(err as Error).message}`);
      }
    }
    const msg: Message = {
      id: messageId(params.agentId, params.targetAgentId, Date.now().toString()),
      from: params.agentId as AgentId,
      to: params.targetAgentId as AgentId,
      channel: null,
      content: `[URGENT] ${params.message}`,
      timestamp: new Date().toISOString(),
    };
    fd.sendMessage(msg);
    return jsonResponse({ status: 'interrupted', targetAgentId: params.targetAgentId });
  });

  // ── Communication tools ──

  server.tool('flightdeck_msg_send', 'Send a DM to another agent', {
    from: z.string(),
    to: z.string(),
    content: z.string(),
    agentId: z.string(),
  }, async (params) => {
    const { agent, error } = resolveAgent(fd, params.agentId, 'flightdeck_msg_send');
    if (error) return error;
    if (params.agentId !== params.from) {
      return errorResponse(`Error: Agent '${params.agentId}' cannot send messages as '${params.from}'. The agentId and from fields must match.`);
    }
    const msg: Message = {
      id: messageId(params.from, params.to, Date.now().toString()),
      from: params.from as AgentId,
      to: params.to as AgentId,
      channel: null,
      content: params.content,
      timestamp: new Date().toISOString(),
    };
    fd.sendMessage(msg);
    return jsonResponse({ status: 'sent', to: params.to });
  });

  server.tool('flightdeck_channel_send', 'Send to group chat', {
    from: z.string(),
    channel: z.string(),
    message: z.string(),
    agentId: z.string(),
  }, async (params) => {
    const { agent, error } = resolveAgent(fd, params.agentId, 'flightdeck_channel_send');
    if (error) return error;
    if (params.agentId !== params.from) {
      return errorResponse(`Error: Agent '${params.agentId}' cannot send messages as '${params.from}'.`);
    }
    const msg: Message = {
      id: messageId(params.from, params.channel, Date.now().toString()),
      from: params.from as AgentId,
      to: null,
      channel: params.channel,
      content: params.message,
      timestamp: new Date().toISOString(),
    };
    fd.sendMessage(msg, params.channel);
    return jsonResponse({ status: 'sent', channel: params.channel });
  });

  server.tool('flightdeck_channel_read', 'Read group chat messages', {
    channel: z.string(),
    since: z.string().optional(),
  }, async (params) => {
    const messages = fd.readMessages(params.channel, params.since);
    return jsonResponse(messages);
  });

  // ── Memory tools ──

  server.tool('flightdeck_memory_search', 'Search project memory (full-text across memory/*.md)', {
    query: z.string(),
  }, async (params) => {
    const results = fd.searchMemory(params.query);
    return jsonResponse(results);
  });

  // ── Chat message tools (WebSocket-backed) ──

  server.tool('flightdeck_msg_list', 'List chat messages', {
    thread_id: z.string().optional(),
    task_id: z.string().optional(),
    limit: z.number().optional(),
  }, async (params) => {
    if (!fd.chatMessages) return errorResponse('MessageStore not available (no SQLite chat tables)');
    const msgs = fd.chatMessages.listMessages({
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
    if (!fd.chatMessages) return errorResponse('MessageStore not available (no SQLite chat tables)');
    const thread = fd.chatMessages.createThread({
      originId: params.origin_id,
      title: params.title,
    });
    return jsonResponse(thread);
  });

  server.tool('flightdeck_thread_list', 'List chat threads', {
    archived: z.boolean().optional(),
    limit: z.number().optional(),
  }, async (params) => {
    if (!fd.chatMessages) return errorResponse('MessageStore not available (no SQLite chat tables)');
    const threads = fd.chatMessages.listThreads({
      archived: params.archived,
      limit: params.limit,
    });
    return jsonResponse(threads);
  });

  server.tool('flightdeck_memory_write', 'Write to project memory', {
    filename: z.string(),
    content: z.string(),
    agentId: z.string(),
  }, async (params) => {
    const { agent, error } = resolveAgent(fd, params.agentId, 'flightdeck_memory_write');
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
    agentId: z.string(),
  }, async (params) => {
    const { agent, error } = resolveAgent(fd, params.agentId, 'flightdeck_learning_add');
    if (error) return error;
    const learning = fd.learnings.append({
      agentId: params.agentId,
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
    agentId: z.string(),
  }, async (params) => {
    const { agent, error } = resolveAgent(fd, params.agentId, 'flightdeck_cost_report');
    if (error) return error;
    // Lead only check via permission
    if (!roleRegistry.hasPermission(agent!.role, 'agent_spawn')) {
      return permError(params.agentId, agent!.role, 'flightdeck_cost_report', 'lead-level access');
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
    agentId: z.string(),
  }, async (params) => {
    const { agent, error } = resolveAgent(fd, params.agentId, 'flightdeck_timer_set');
    if (error) return error;
    const timer = fd.timers.setTimer(params.agentId, params.label, params.delayMs, params.message, params.repeat);
    return jsonResponse(timer);
  });

  server.tool('flightdeck_timer_cancel', 'Cancel a timer', {
    label: z.string(),
    agentId: z.string(),
  }, async (params) => {
    const { agent, error } = resolveAgent(fd, params.agentId, 'flightdeck_timer_cancel');
    if (error) return error;
    const cancelled = fd.timers.cancelTimer(params.agentId, params.label);
    return jsonResponse({ cancelled });
  });

  server.tool('flightdeck_timer_list', 'List timers', {
    agentId: z.string(),
  }, async (params) => {
    const { agent, error } = resolveAgent(fd, params.agentId, 'flightdeck_timer_list');
    if (error) return error;
    return jsonResponse(fd.timers.listTimers(params.agentId));
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

  server.tool('flightdeck_escalate', 'Escalate to lead/planner', {
    taskId: z.string(),
    reason: z.string(),
    agentId: z.string(),
  }, async (params) => {
    const { agent, error } = resolveAgent(fd, params.agentId, 'flightdeck_escalate');
    if (error) return error;
    const msg: Message = {
      id: messageId(params.agentId, 'escalation', Date.now().toString()),
      from: params.agentId as AgentId,
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
    agentId: z.string(),
  }, async (params) => {
    const { agent, error } = resolveAgent(fd, params.agentId, 'flightdeck_discuss');
    if (error) return error;
    const permErr = checkPerm(agent!, 'discuss', 'flightdeck_discuss');
    if (permErr) return permErr;
    const channel = params.topic.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const now = new Date().toISOString();
    const initMsg: Message = {
      id: messageId('system', channel, now),
      from: params.agentId as AgentId,
      to: null,
      channel,
      content: `Discussion created: "${params.topic}"\nInvitees: ${(params.invitees ?? []).join(', ') || 'open'}\nCreated: ${now}`,
      timestamp: now,
    };
    fd.sendMessage(initMsg, channel);
    return jsonResponse({ channel, topic: params.topic, invitees: params.invitees ?? [], createdAt: now });
  });

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
