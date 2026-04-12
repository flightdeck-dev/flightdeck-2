import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { Flightdeck } from '../facade.js';
import { ProjectStore } from '../storage/ProjectStore.js';
import type { TaskId, AgentId, SpecId, Message, MessageId } from '../core/types.js';
import { messageId } from '../core/ids.js';

export function createMcpServer(projectName?: string): McpServer {
  // Resolve project from cwd or explicit param
  const name = projectName ?? ProjectStore.resolve(process.cwd());
  if (!name) {
    throw new Error('No Flightdeck project found. Run `flightdeck init` first or pass --project.');
  }

  const fd = new Flightdeck(name);
  const server = new McpServer({ name: 'flightdeck', version: '2.0.0' });

  // ── Task tools ──

  server.tool('flightdeck_task_list', 'List tasks for the project', {
    specId: z.string().optional(),
  }, async (params) => {
    const tasks = fd.listTasks(params.specId as SpecId | undefined);
    return { content: [{ type: 'text' as const, text: JSON.stringify(tasks, null, 2) }] };
  });

  server.tool('flightdeck_task_claim', 'Claim a ready task', {
    taskId: z.string(),
    agentId: z.string(),
  }, async (params) => {
    const task = fd.claimTask(params.taskId as TaskId, params.agentId as AgentId);
    return { content: [{ type: 'text' as const, text: JSON.stringify(task, null, 2) }] };
  });

  server.tool('flightdeck_task_submit', 'Submit completed work with claim', {
    taskId: z.string(),
    claim: z.string().optional(),
  }, async (params) => {
    const task = fd.submitTask(params.taskId as TaskId);
    return { content: [{ type: 'text' as const, text: JSON.stringify(task, null, 2) }] };
  });

  server.tool('flightdeck_task_fail', 'Report task failure', {
    taskId: z.string(),
    reason: z.string().optional(),
  }, async (params) => {
    const task = fd.failTask(params.taskId as TaskId);
    return { content: [{ type: 'text' as const, text: JSON.stringify(task, null, 2) }] };
  });

  // ── Communication tools ──

  server.tool('flightdeck_msg_send', 'Send a DM to another agent', {
    from: z.string(),
    to: z.string(),
    content: z.string(),
  }, async (params) => {
    const msg: Message = {
      id: messageId(params.from, params.to, Date.now().toString()),
      from: params.from as AgentId,
      to: params.to as AgentId,
      channel: null,
      content: params.content,
      timestamp: new Date().toISOString(),
    };
    fd.sendMessage(msg);
    return { content: [{ type: 'text' as const, text: 'Message sent' }] };
  });

  server.tool('flightdeck_channel_send', 'Send to group chat', {
    from: z.string(),
    channel: z.string(),
    message: z.string(),
  }, async (params) => {
    const msg: Message = {
      id: messageId(params.from, params.channel, Date.now().toString()),
      from: params.from as AgentId,
      to: null,
      channel: params.channel,
      content: params.message,
      timestamp: new Date().toISOString(),
    };
    fd.sendMessage(msg, params.channel);
    return { content: [{ type: 'text' as const, text: 'Message sent to channel' }] };
  });

  server.tool('flightdeck_channel_read', 'Read group chat messages', {
    channel: z.string(),
    since: z.string().optional(),
  }, async (params) => {
    const messages = fd.readMessages(params.channel, params.since);
    return { content: [{ type: 'text' as const, text: JSON.stringify(messages, null, 2) }] };
  });

  // ── Memory tools ──

  server.tool('flightdeck_memory_search', 'Search project memory', {
    query: z.string(),
  }, async (params) => {
    const results = fd.searchMemory(params.query);
    return { content: [{ type: 'text' as const, text: JSON.stringify(results, null, 2) }] };
  });

  server.tool('flightdeck_memory_write', 'Write to project memory', {
    filename: z.string(),
    content: z.string(),
  }, async (params) => {
    fd.writeMemory(params.filename, params.content);
    return { content: [{ type: 'text' as const, text: `Written to memory/${params.filename}` }] };
  });

  // ── Status tools ──

  server.tool('flightdeck_status', 'Get project status', {}, async () => {
    const status = fd.status();
    return { content: [{ type: 'text' as const, text: JSON.stringify(status, null, 2) }] };
  });

  server.tool('flightdeck_spec_list', 'List specs', {}, async () => {
    const specs = fd.listSpecs();
    return { content: [{ type: 'text' as const, text: JSON.stringify(specs.map(s => ({ id: s.id, title: s.title, filename: s.filename })), null, 2) }] };
  });

  server.tool('flightdeck_escalate', 'Escalate to lead/planner', {
    taskId: z.string(),
    reason: z.string(),
    agentId: z.string(),
  }, async (params) => {
    // Log as a message to the lead channel
    const msg: Message = {
      id: messageId(params.agentId, 'escalation', Date.now().toString()),
      from: params.agentId as AgentId,
      to: null,
      channel: 'escalations',
      content: `ESCALATION for task ${params.taskId}: ${params.reason}`,
      timestamp: new Date().toISOString(),
    };
    fd.sendMessage(msg, 'escalations');
    return { content: [{ type: 'text' as const, text: 'Escalation logged' }] };
  });

  server.tool('flightdeck_discuss', 'Create a group discussion', {
    topic: z.string(),
    invitees: z.array(z.string()).optional(),
  }, async (params) => {
    const channel = params.topic.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    return { content: [{ type: 'text' as const, text: `Discussion channel created: ${channel}` }] };
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
