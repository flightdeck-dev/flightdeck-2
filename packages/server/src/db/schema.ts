import { sqliteTable, text, integer, real, index } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

/** ISO 8601 UTC timestamp with Z suffix — use instead of datetime('now') to avoid timezone ambiguity */
export const utcNow = sql`(strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`;

// ── Tasks ────────────────────────────────────────────────────────────

export const tasks = sqliteTable('tasks', {
  id: text('id').primaryKey(),
  specId: text('spec_id'),
  parentTaskId: text('parent_task_id'),
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
  stale: integer('stale', { mode: 'boolean' }).notNull().default(false),
  needsReview: integer('needs_review', { mode: 'boolean' }).notNull().default(true),
  acceptanceCriteria: text('acceptance_criteria'),
  context: text('context'),
  notifyLead: integer('notify_lead', { mode: 'boolean' }).notNull().default(false),
  runtime: text('runtime'),
  model: text('model'),
  compactedAt: text('compacted_at'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  index('idx_tasks_state').on(table.state),
  index('idx_tasks_assigned_agent').on(table.assignedAgent),
  index('idx_tasks_spec').on(table.specId),
  index('idx_tasks_parent').on(table.parentTaskId),
]);

// ── Agents ───────────────────────────────────────────────────────────

export const agents = sqliteTable('agents', {
  id: text('id').primaryKey(),
  role: text('role').notNull(),
  runtime: text('runtime').notNull().default('acp'),
  runtimeName: text('runtime_name'),
  acpSessionId: text('acp_session_id'),
  status: text('status').notNull().default('idle'),
  currentSpecId: text('current_spec_id'),
  costAccumulated: real('cost_accumulated').notNull().default(0),
  lastHeartbeat: text('last_heartbeat'),
}, (table) => [
  index('idx_agents_status').on(table.status),
  index('idx_agents_role').on(table.role),
]);

// ── Messages ─────────────────────────────────────────────────────────

export const messages = sqliteTable('messages', {
  id: text('id').primaryKey(),
  threadId: text('thread_id'),
  parentId: text('parent_id'),
  parentIds: text('parent_ids'),  // JSON array of message IDs for multi-parent (merged replies)
  taskId: text('task_id'),
  authorType: text('author_type').notNull(), // 'user' | 'lead' | 'agent' | 'system'
  authorId: text('author_id'),
  content: text('content').notNull(),
  metadata: text('metadata'), // JSON
  channel: text('channel'),
  recipient: text('recipient'),
  source: text('source').default('web'),
  senderId: text('sender_id'),
  senderName: text('sender_name'),
  replyToId: text('reply_to_id'),
  attachments: text('attachments'), // JSON array
  channelId: text('channel_id'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at'),
}, (table) => [
  index('idx_messages_thread').on(table.threadId),
  index('idx_messages_task').on(table.taskId),
  index('idx_messages_author_type').on(table.authorType),
  index('idx_messages_channel').on(table.channel),
  index('idx_messages_recipient').on(table.recipient),
]);

// ── Read State (DM read tracking) ────────────────────────────────────

export const readState = sqliteTable('read_state', {
  agentId: text('agent_id').primaryKey(),
  lastReadAt: text('last_read_at').notNull(),
});

// ── Threads ──────────────────────────────────────────────────────────

export const threads = sqliteTable('threads', {
  id: text('id').primaryKey(),
  title: text('title'),
  originId: text('origin_id'),
  createdAt: text('created_at').notNull(),
  archivedAt: text('archived_at'),
});

// ── Cost Entries ─────────────────────────────────────────────────────

export const costEntries = sqliteTable('cost_entries', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  agentId: text('agent_id').notNull(),
  specId: text('spec_id'),
  model: text('model'),
  tokensIn: integer('tokens_in').notNull().default(0),
  tokensOut: integer('tokens_out').notNull().default(0),
  cacheReadTokens: integer('cache_read_tokens').notNull().default(0),
  cacheWriteTokens: integer('cache_write_tokens').notNull().default(0),
  costUsd: real('cost_usd').notNull().default(0),
  durationMs: integer('duration_ms'),
  timestamp: text('timestamp').notNull(),
}, (table) => [
  index('idx_cost_entries_agent').on(table.agentId),
  index('idx_cost_entries_spec').on(table.specId),
]);

// ── File Locks ───────────────────────────────────────────────────────

export const fileLocks = sqliteTable('file_locks', {
  filePath: text('file_path').primaryKey(),
  agentId: text('agent_id').notNull(),
  agentRole: text('agent_role').notNull(),
  reason: text('reason').default(''),
  acquiredAt: text('acquired_at').default(utcNow),
  expiresAt: text('expires_at').notNull(),
}, (table) => [
  index('idx_file_locks_agent').on(table.agentId),
]);

// ── Activity Log ─────────────────────────────────────────────────────

export const activityLog = sqliteTable('activity_log', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  agentId: text('agent_id').notNull(),
  agentRole: text('agent_role').notNull(),
  actionType: text('action_type').notNull(),
  summary: text('summary').notNull(),
  details: text('details').default('{}'), // JSON
  timestamp: text('timestamp').default(utcNow),
}, (table) => [
  index('idx_activity_agent').on(table.agentId),
  index('idx_activity_type').on(table.actionType),
]);

// ── Message Queue (crash-safe message delivery) ─────────────────────

export const messageQueue = sqliteTable('message_queue', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  targetAgentId: text('target_agent_id').notNull(),
  sourceAgentId: text('source_agent_id'),
  messageType: text('message_type').notNull(), // 'agent_message' | 'delegation_result' | 'broadcast' | 'system'
  payload: text('payload').notNull(),           // JSON-encoded
  status: text('status').notNull().default('queued'), // 'queued' | 'delivered' | 'expired'
  attempts: integer('attempts').notNull().default(0),
  createdAt: text('created_at').default(utcNow),
  deliveredAt: text('delivered_at'),
}, (table) => [
  index('idx_mq_target_status').on(table.targetAgentId, table.status),
]);

// ── Sessions (ACP session index) ─────────────────────────────────────

export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(),
  cwd: text('cwd').notNull(),
  projectName: text('project_name').notNull(),
  createdAt: text('created_at').notNull(),
  lastActiveAt: text('last_active_at').notNull(),
}, (table) => [
  index('idx_sessions_project').on(table.projectName),
]);

// ── Spec Hashes (change detection) ──────────────────────────────────

export const specHashes = sqliteTable('spec_hashes', {
  specId: text('spec_id').primaryKey(),
  contentHash: text('content_hash').notNull(),
  updatedAt: text('updated_at').notNull(),
});

// ── Task Events (state change audit log) ────────────────────────────

export const taskEvents = sqliteTable('task_events', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  taskId: text('task_id').notNull(),
  fromState: text('from_state'),
  toState: text('to_state').notNull(),
  agentId: text('agent_id'),
  reason: text('reason'),
  timestamp: text('timestamp').notNull().default(utcNow),
}, (table) => [
  index('idx_task_events_task').on(table.taskId),
  index('idx_task_events_ts').on(table.timestamp),
]);

// ── Task Comments (PR-style review thread) ────────────────────────

export const taskComments = sqliteTable('task_comments', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  taskId: text('task_id').notNull(),
  agentId: text('agent_id'),
  /** 'comment' | 'review' — review comments have a verdict */
  type: text('type').notNull().default('comment'),
  /** For review comments: 'approve' | 'request_changes' */
  verdict: text('verdict'),
  content: text('content').notNull(),
  timestamp: text('timestamp').notNull().default(utcNow),
}, (table) => [
  index('idx_task_comments_task').on(table.taskId),
]);

// ── Saved Sessions (gateway restart recovery) ─────────────────────

export const savedSessions = sqliteTable('saved_sessions', {
  agentId: text('agent_id').primaryKey(),
  role: text('role').notNull(),
  sessionId: text('session_id').notNull(),
  localSessionId: text('local_session_id'),
  runtime: text('runtime'),
  cwd: text('cwd'),
  model: text('model'),
  status: text('status').notNull().default('hibernated'),
  savedAt: text('saved_at').notNull().default(utcNow),
});

// ── Escalations (lead-to-human queue) ─────────────────────────────

export const escalations = sqliteTable('escalations', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  agentId: text('agent_id').notNull(),
  title: text('title').notNull(),
  description: text('description').notNull(),
  priority: text('priority').notNull().default('normal'),
  status: text('status').notNull().default('pending'),
  resolution: text('resolution'),
  createdAt: text('created_at').notNull().default(utcNow),
  resolvedAt: text('resolved_at'),
}, (table) => [
  index('idx_escalations_status').on(table.status),
]);

