import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { Flightdeck } from '../facade.js';
import { ProjectStore } from '../storage/ProjectStore.js';
import type { TaskId, AgentId, SpecId, Message, MessageId } from '../core/types.js';
import { messageId } from '../core/ids.js';

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

function roleError(agentId: string, role: string, toolName: string, allowed: string[], suggestion: string) {
  return errorResponse(
    `Error: You (${agentId}, role: ${role}) cannot call ${toolName}. ` +
    `This tool is for ${allowed.join('/')} roles. ${suggestion}`
  );
}

export function createMcpServer(projectName?: string): McpServer {
  // Resolve project from cwd or explicit param
  const name = projectName ?? ProjectStore.resolve(process.cwd());
  if (!name) {
    throw new Error('No Flightdeck project found. Run `flightdeck init` first or pass --project.');
  }

  const fd = new Flightdeck(name);
  const server = new McpServer({ name: 'flightdeck', version: '2.0.0' });

  // ── Task tools ── (read-only: no agentId needed)

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
    role: z.enum(['lead', 'planner', 'worker', 'reviewer']).optional(),
    dependsOn: z.array(z.string()).optional(),
    priority: z.number().optional(),
    agentId: z.string(),
  }, async (params) => {
    const { agent, error } = resolveAgent(fd, params.agentId, 'flightdeck_task_add');
    if (error) return error;
    if (agent!.role !== 'lead' && agent!.role !== 'planner') {
      return roleError(params.agentId, agent!.role, 'flightdeck_task_add', ['lead', 'planner'],
        "Use flightdeck_escalate({ reason: 'need new task' }) instead.");
    }
    try {
      const task = fd.addTask({
        title: params.title,
        description: params.description,
        specId: params.specId as SpecId | undefined,
        role: params.role,
        dependsOn: params.dependsOn as TaskId[] | undefined,
        priority: params.priority,
      });
      return jsonResponse(task);
    } catch (err) {
      return errorResponse(`Error: Failed to add task '${params.title}' — ${(err as Error).message}. Check that dependsOn task IDs exist using flightdeck_task_list().`);
    }
  });

  server.tool('flightdeck_task_claim', 'Claim a ready task', {
    taskId: z.string(),
    agentId: z.string(),
  }, async (params) => {
    const { agent, error } = resolveAgent(fd, params.agentId, 'flightdeck_task_claim');
    if (error) return error;
    if (agent!.role !== 'worker') {
      return roleError(params.agentId, agent!.role, 'flightdeck_task_claim', ['worker'],
        'Only workers claim and execute tasks.');
    }
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
      return errorResponse(`Error: Failed to claim task '${params.taskId}' — ${msg}.`);
    }
  });

  server.tool('flightdeck_task_submit', 'Submit completed work with claim', {
    taskId: z.string(),
    agentId: z.string(),
    claim: z.string().optional(),
  }, async (params) => {
    const { agent, error } = resolveAgent(fd, params.agentId, 'flightdeck_task_submit');
    if (error) return error;
    if (agent!.role !== 'worker') {
      return roleError(params.agentId, agent!.role, 'flightdeck_task_submit', ['worker'],
        'Only the assigned worker can submit task work.');
    }
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
      return errorResponse(`Error: Failed to submit task '${params.taskId}' — ${msg}.`);
    }
  });

  server.tool('flightdeck_task_fail', 'Report task failure', {
    taskId: z.string(),
    agentId: z.string(),
    reason: z.string().optional(),
  }, async (params) => {
    const { agent, error } = resolveAgent(fd, params.agentId, 'flightdeck_task_fail');
    if (error) return error;
    if (agent!.role !== 'worker' && agent!.role !== 'lead') {
      return roleError(params.agentId, agent!.role, 'flightdeck_task_fail', ['worker', 'lead'],
        'Use flightdeck_escalate() to report issues if you are a planner/reviewer.');
    }
    try {
      const task = fd.failTask(params.taskId as TaskId);
      return jsonResponse(task);
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes('not found')) {
        return errorResponse(`Error: Task '${params.taskId}' not found. Use flightdeck_task_list() to see available tasks.`);
      }
      if (msg.includes('Invalid state transition')) {
        const task = fd.sqlite.getTask(params.taskId as TaskId);
        return errorResponse(`Error: Cannot fail task '${params.taskId}' — current state is '${task?.state ?? 'unknown'}'. Only running or in_review tasks can be failed.`);
      }
      return errorResponse(`Error: Failed to report failure for task '${params.taskId}' — ${msg}.`);
    }
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
      return errorResponse(`Error: Agent '${params.agentId}' cannot send messages as '${params.from}'. The agentId and from fields must match.`);
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

  // ── Memory tools ── (read-only search, mutating write)

  server.tool('flightdeck_memory_search', 'Search project memory', {
    query: z.string(),
  }, async (params) => {
    const results = fd.searchMemory(params.query);
    return jsonResponse(results);
  });

  server.tool('flightdeck_memory_write', 'Write to project memory', {
    filename: z.string(),
    content: z.string(),
    agentId: z.string(),
  }, async (params) => {
    const { agent, error } = resolveAgent(fd, params.agentId, 'flightdeck_memory_write');
    if (error) return error;
    try {
      fd.writeMemory(params.filename, params.content);
      return jsonResponse({ status: 'written', path: `memory/${params.filename}` });
    } catch (err) {
      return errorResponse(`Error: Failed to write to memory/${params.filename} — ${(err as Error).message}. Check that the filename is valid.`);
    }
  });

  // ── Status tools ── (read-only)

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
    // Any role can escalate
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
    if (agent!.role !== 'lead' && agent!.role !== 'planner') {
      return roleError(params.agentId, agent!.role, 'flightdeck_discuss', ['lead', 'planner'],
        'Use flightdeck_channel_send() to post in an existing channel, or flightdeck_escalate() to request a discussion.');
    }
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

// Run as stdio server when executed directly
async function main() {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Check if this file is being run directly
const isMain = process.argv[1]?.endsWith('server.ts') || process.argv[1]?.endsWith('server.js');
if (isMain) {
  main().catch(console.error);
}
