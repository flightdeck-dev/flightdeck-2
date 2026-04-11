#!/usr/bin/env node
// Flightdeck MCP Server — exposes Flightdeck as tools for AI agents via stdio

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { Flightdeck } from '../facade.js';

const fd = new Flightdeck({ dbPath: process.env.FLIGHTDECK_DB ?? '.flightdeck/flightdeck.db' });

const server = new McpServer({
  name: 'flightdeck',
  version: '2.0.0',
});

// Task tools
server.tool('flightdeck_task_add', 'Add a task to the DAG',
  { title: z.string(), role: z.string(), description: z.string().optional(), dependsOn: z.array(z.string()).optional(), priority: z.number().optional() },
  async (params) => {
    const task = fd.addTask(params);
    return { content: [{ type: 'text' as const, text: JSON.stringify(task) }] };
  }
);

server.tool('flightdeck_task_list', 'List tasks',
  { status: z.string().optional() },
  async (params) => {
    const tasks = fd.listTasks(params.status ? { status: params.status as any } : undefined);
    return { content: [{ type: 'text' as const, text: JSON.stringify(tasks) }] };
  }
);

server.tool('flightdeck_task_complete', 'Complete a task',
  { taskId: z.string() },
  async ({ taskId }) => {
    const task = fd.completeTask(taskId);
    return { content: [{ type: 'text' as const, text: JSON.stringify(task) }] };
  }
);

server.tool('flightdeck_task_fail', 'Fail a task',
  { taskId: z.string(), reason: z.string().optional() },
  async ({ taskId, reason }) => {
    const task = fd.failTask(taskId, reason);
    return { content: [{ type: 'text' as const, text: JSON.stringify(task) }] };
  }
);

server.tool('flightdeck_task_gate', 'Set a gate on a task',
  { taskId: z.string(), awaitType: z.string(), awaitId: z.string() },
  async ({ taskId, awaitType, awaitId }) => {
    const gate = fd.gateTask(taskId, awaitType, awaitId);
    return { content: [{ type: 'text' as const, text: JSON.stringify(gate) }] };
  }
);

server.tool('flightdeck_task_status', 'Get DAG summary',
  {},
  async () => {
    const stats = fd.dagStats();
    return { content: [{ type: 'text' as const, text: JSON.stringify(stats) }] };
  }
);

// Spec tools
server.tool('flightdeck_spec_create', 'Create a spec',
  { title: z.string() },
  async ({ title }) => {
    const spec = fd.createSpec(title);
    return { content: [{ type: 'text' as const, text: JSON.stringify(spec) }] };
  }
);

server.tool('flightdeck_spec_list', 'List specs',
  {},
  async () => {
    const specs = fd.listSpecs();
    return { content: [{ type: 'text' as const, text: JSON.stringify(specs) }] };
  }
);

// Message tools
server.tool('flightdeck_msg_send', 'Send a message',
  { to: z.string(), content: z.string(), priority: z.enum(['critical', 'normal', 'low']).optional() },
  async ({ to, content, priority }) => {
    const msg = fd.sendMessage(to, content, { priority });
    return { content: [{ type: 'text' as const, text: JSON.stringify(msg) }] };
  }
);

server.tool('flightdeck_msg_inbox', 'Get agent inbox',
  { agentId: z.string() },
  async ({ agentId }) => {
    const msgs = fd.getInbox(agentId);
    return { content: [{ type: 'text' as const, text: JSON.stringify(msgs) }] };
  }
);

// Verification tools
server.tool('flightdeck_verify_request', 'Request a review for a task',
  { taskId: z.string(), reviewerAgent: z.string().optional() },
  async ({ taskId, reviewerAgent }) => {
    const review = fd.requestReview(taskId, reviewerAgent);
    return { content: [{ type: 'text' as const, text: JSON.stringify(review) }] };
  }
);

server.tool('flightdeck_verify_decide', 'Submit a review verdict',
  { reviewId: z.string(), verdict: z.enum(['approve', 'request_changes', 'reject']), comments: z.string().optional() },
  async ({ reviewId, verdict, comments }) => {
    const review = fd.decideReview(reviewId, verdict, comments);
    return { content: [{ type: 'text' as const, text: JSON.stringify(review) }] };
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
