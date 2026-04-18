-- Flightdeck 2 — unified schema
-- All tables use CREATE TABLE IF NOT EXISTS for idempotency.
-- Drop your DB and restart to apply cleanly.

CREATE TABLE IF NOT EXISTS `tasks` (
  `id` text PRIMARY KEY NOT NULL,
  `spec_id` text,
  `parent_task_id` text,
  `title` text NOT NULL,
  `description` text NOT NULL DEFAULT '',
  `state` text NOT NULL DEFAULT 'pending',
  `role` text NOT NULL DEFAULT 'worker',
  `depends_on` text NOT NULL DEFAULT '[]',
  `priority` integer NOT NULL DEFAULT 0,
  `assigned_agent` text,
  `acp_session_id` text,
  `claim` text,
  `source` text NOT NULL DEFAULT 'planned',
  `cost` real DEFAULT 0,
  `stale` integer NOT NULL DEFAULT 0,
  `needs_review` integer NOT NULL DEFAULT 1,
  `compacted_at` text,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL
);

CREATE INDEX IF NOT EXISTS `idx_tasks_state` ON `tasks` (`state`);
CREATE INDEX IF NOT EXISTS `idx_tasks_assigned_agent` ON `tasks` (`assigned_agent`);
CREATE INDEX IF NOT EXISTS `idx_tasks_spec` ON `tasks` (`spec_id`);
CREATE INDEX IF NOT EXISTS `idx_tasks_parent` ON `tasks` (`parent_task_id`);

CREATE TABLE IF NOT EXISTS `agents` (
  `id` text PRIMARY KEY NOT NULL,
  `role` text NOT NULL,
  `runtime` text NOT NULL DEFAULT 'acp',
  `runtime_name` text,
  `acp_session_id` text,
  `status` text NOT NULL DEFAULT 'idle',
  `current_spec_id` text,
  `cost_accumulated` real NOT NULL DEFAULT 0,
  `last_heartbeat` text
);

CREATE INDEX IF NOT EXISTS `idx_agents_status` ON `agents` (`status`);
CREATE INDEX IF NOT EXISTS `idx_agents_role` ON `agents` (`role`);

CREATE TABLE IF NOT EXISTS `cost_entries` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `agent_id` text NOT NULL,
  `spec_id` text,
  `model` text,
  `tokens_in` integer NOT NULL DEFAULT 0,
  `tokens_out` integer NOT NULL DEFAULT 0,
  `cache_read_tokens` integer NOT NULL DEFAULT 0,
  `cache_write_tokens` integer NOT NULL DEFAULT 0,
  `cost_usd` real NOT NULL DEFAULT 0,
  `duration_ms` integer,
  `timestamp` text NOT NULL
);

CREATE INDEX IF NOT EXISTS `idx_cost_entries_agent` ON `cost_entries` (`agent_id`);
CREATE INDEX IF NOT EXISTS `idx_cost_entries_spec` ON `cost_entries` (`spec_id`);

CREATE TABLE IF NOT EXISTS `spec_hashes` (
  `spec_id` text PRIMARY KEY NOT NULL,
  `content_hash` text NOT NULL,
  `updated_at` text NOT NULL
);

CREATE TABLE IF NOT EXISTS `file_locks` (
  `file_path` text PRIMARY KEY NOT NULL,
  `agent_id` text NOT NULL,
  `agent_role` text NOT NULL,
  `reason` text DEFAULT '',
  `acquired_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  `expires_at` text NOT NULL
);

CREATE INDEX IF NOT EXISTS `idx_file_locks_agent` ON `file_locks` (`agent_id`);

CREATE TABLE IF NOT EXISTS `activity_log` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `agent_id` text NOT NULL,
  `agent_role` text NOT NULL,
  `action_type` text NOT NULL,
  `summary` text NOT NULL,
  `details` text DEFAULT '{}',
  `timestamp` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX IF NOT EXISTS `idx_activity_agent` ON `activity_log` (`agent_id`);
CREATE INDEX IF NOT EXISTS `idx_activity_type` ON `activity_log` (`action_type`);

CREATE TABLE IF NOT EXISTS `message_queue` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `target_agent_id` text NOT NULL,
  `source_agent_id` text,
  `message_type` text NOT NULL,
  `payload` text NOT NULL,
  `status` text NOT NULL DEFAULT 'queued',
  `attempts` integer NOT NULL DEFAULT 0,
  `created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  `delivered_at` text
);

CREATE INDEX IF NOT EXISTS `idx_mq_target_status` ON `message_queue` (`target_agent_id`, `status`);

CREATE TABLE IF NOT EXISTS `messages` (
  `id` text PRIMARY KEY NOT NULL,
  `thread_id` text,
  `parent_id` text,
  `parent_ids` text,
  `task_id` text,
  `author_type` text NOT NULL,
  `author_id` text,
  `content` text NOT NULL,
  `metadata` text,
  `channel` text,
  `recipient` text,
  `created_at` text NOT NULL,
  `updated_at` text
);

CREATE INDEX IF NOT EXISTS `idx_messages_thread` ON `messages` (`thread_id`);
CREATE INDEX IF NOT EXISTS `idx_messages_task` ON `messages` (`task_id`);
CREATE INDEX IF NOT EXISTS `idx_messages_author_type` ON `messages` (`author_type`);
CREATE INDEX IF NOT EXISTS `idx_messages_channel` ON `messages` (`channel`);
CREATE INDEX IF NOT EXISTS `idx_messages_recipient` ON `messages` (`recipient`);

CREATE VIRTUAL TABLE IF NOT EXISTS `messages_fts` USING fts5(
  id UNINDEXED,
  author_type UNINDEXED,
  author_id UNINDEXED,
  content,
  tokenize='porter unicode61'
);

CREATE TABLE IF NOT EXISTS `threads` (
  `id` text PRIMARY KEY NOT NULL,
  `title` text,
  `origin_id` text,
  `created_at` text NOT NULL,
  `archived_at` text
);

CREATE TABLE IF NOT EXISTS `read_state` (
  `agent_id` text PRIMARY KEY NOT NULL,
  `last_read_at` text NOT NULL
);

CREATE TABLE IF NOT EXISTS `sessions` (
  `id` text PRIMARY KEY NOT NULL,
  `cwd` text NOT NULL,
  `project_name` text NOT NULL,
  `created_at` text NOT NULL,
  `last_active_at` text NOT NULL
);

CREATE INDEX IF NOT EXISTS `idx_sessions_project` ON `sessions` (`project_name`);

-- Task Events (state change audit log)
CREATE TABLE IF NOT EXISTS `task_events` (
  `id` integer PRIMARY KEY AUTOINCREMENT,
  `task_id` text NOT NULL,
  `from_state` text,
  `to_state` text NOT NULL,
  `agent_id` text,
  `reason` text,
  `timestamp` text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX IF NOT EXISTS `idx_task_events_task` ON `task_events` (`task_id`);
CREATE INDEX IF NOT EXISTS `idx_task_events_ts` ON `task_events` (`timestamp`);

-- Task Comments (PR-style comment thread per task)
CREATE TABLE IF NOT EXISTS `task_comments` (
  `id` integer PRIMARY KEY AUTOINCREMENT,
  `task_id` text NOT NULL,
  `agent_id` text,
  `type` text NOT NULL DEFAULT 'comment',
  `verdict` text,
  `content` text NOT NULL,
  `timestamp` text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX IF NOT EXISTS `idx_task_comments_task` ON `task_comments` (`task_id`);

-- Saved Sessions (for gateway restart recovery)
CREATE TABLE IF NOT EXISTS `saved_sessions` (
  `agent_id` text PRIMARY KEY NOT NULL,
  `role` text NOT NULL,
  `session_id` text NOT NULL,
  `local_session_id` text,
  `runtime` text,
  `cwd` text,
  `model` text,
  `status` text NOT NULL DEFAULT 'hibernated',
  `saved_at` text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
