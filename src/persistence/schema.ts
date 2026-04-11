// Database Schema — SQLite via drizzle-orm
// Clean schema covering all entity types

import { sqliteTable, text, integer, real } from 'drizzle-orm/sqlite-core';

export const tasks = sqliteTable('tasks', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  description: text('description').notNull(),
  state: text('state').notNull().default('pending'),
  role: text('role').notNull(),
  files: text('files').notNull().default('[]'), // JSON array
  dependsOn: text('depends_on').notNull().default('[]'), // JSON array
  priority: integer('priority').notNull().default(0),
  specRequirementId: text('spec_requirement_id'),
  planId: text('plan_id'),
  assignedAgent: text('assigned_agent'),
  model: text('model'),
  stale: integer('stale', { mode: 'boolean' }).notNull().default(false),
  compacted: integer('compacted', { mode: 'boolean' }).notNull().default(false),
  compactedSummary: text('compacted_summary'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const specs = sqliteTable('specs', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  requirements: text('requirements').notNull().default('[]'), // JSON
  userScenarios: text('user_scenarios').notNull().default('[]'), // JSON
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const changes = sqliteTable('changes', {
  id: text('id').primaryKey(),
  specId: text('spec_id').notNull(),
  title: text('title').notNull(),
  description: text('description').notNull(),
  status: text('status').notNull().default('proposed'),
  diff: text('diff').notNull().default('{}'), // JSON
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const plans = sqliteTable('plans', {
  id: text('id').primaryKey(),
  specId: text('spec_id').notNull(),
  title: text('title').notNull(),
  taskIds: text('task_ids').notNull().default('[]'), // JSON
  requirementMapping: text('requirement_mapping').notNull().default('{}'), // JSON
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const messages = sqliteTable('messages', {
  id: text('id').primaryKey(),
  type: text('type').notNull(),
  priority: text('priority').notNull().default('normal'),
  fromAgent: text('from_agent').notNull(),
  toAgents: text('to_agents').notNull().default('[]'), // JSON array
  content: text('content').notNull(),
  threadId: text('thread_id'),
  replyTo: text('reply_to'),
  deliveryStatus: text('delivery_status').notNull().default('sent'),
  createdAt: text('created_at').notNull(),
  readAt: text('read_at'),
});

export const agents = sqliteTable('agents', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  role: text('role').notNull(),
  model: text('model').notNull(),
  status: text('status').notNull().default('idle'),
  capabilities: text('capabilities').notNull().default('[]'), // JSON
  costAccumulated: real('cost_accumulated').notNull().default(0),
  lastHeartbeat: text('last_heartbeat'),
  sessionId: text('session_id'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const events = sqliteTable('events', {
  id: text('id').primaryKey(),
  type: text('type').notNull(),
  payload: text('payload').notNull().default('{}'), // JSON
  priority: integer('priority').notNull().default(1),
  timestamp: text('timestamp').notNull(),
});

export const gates = sqliteTable('gates', {
  id: text('id').primaryKey(),
  taskId: text('task_id').notNull(),
  awaitType: text('await_type').notNull(),
  awaitId: text('await_id').notNull(),
  timeout: integer('timeout'),
  cleared: integer('cleared', { mode: 'boolean' }).notNull().default(false),
  clearedAt: text('cleared_at'),
  createdAt: text('created_at').notNull(),
});

export const reviews = sqliteTable('reviews', {
  id: text('id').primaryKey(),
  taskId: text('task_id').notNull(),
  writerAgent: text('writer_agent').notNull(),
  writerModel: text('writer_model').notNull(),
  reviewerAgent: text('reviewer_agent'),
  reviewerModel: text('reviewer_model'),
  verdict: text('verdict'),
  comments: text('comments').notNull().default('[]'), // JSON
  attempt: integer('attempt').notNull().default(1),
  createdAt: text('created_at').notNull(),
  completedAt: text('completed_at'),
});
