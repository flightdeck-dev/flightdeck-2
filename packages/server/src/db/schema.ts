import { sqliteTable, text, integer, real } from 'drizzle-orm/sqlite-core';

export const tasks = sqliteTable('tasks', {
  id: text('id').primaryKey(),
  specId: text('spec_id'),
  title: text('title').notNull(),
  description: text('description').notNull().default(''),
  state: text('state').notNull().default('pending'),
  role: text('role').notNull().default('worker'),
  dependsOn: text('depends_on').notNull().default('[]'),
  priority: integer('priority').notNull().default(0),
  assignedAgent: text('assigned_agent'),
  acpSessionId: text('acp_session_id'),
  claim: text('claim'),
  source: text('source').notNull().default('planned'),
  cost: real('cost').default(0),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const agents = sqliteTable('agents', {
  id: text('id').primaryKey(),
  role: text('role').notNull(),
  runtime: text('runtime').notNull().default('acp'),
  acpSessionId: text('acp_session_id'),
  status: text('status').notNull().default('idle'),
  currentSpecId: text('current_spec_id'),
  costAccumulated: real('cost_accumulated').notNull().default(0),
  lastHeartbeat: text('last_heartbeat'),
});

export const costEntries = sqliteTable('cost_entries', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  agentId: text('agent_id').notNull(),
  specId: text('spec_id'),
  tokensIn: integer('tokens_in').notNull().default(0),
  tokensOut: integer('tokens_out').notNull().default(0),
  costUsd: real('cost_usd').notNull().default(0),
  timestamp: text('timestamp').notNull(),
});
