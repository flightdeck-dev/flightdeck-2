// M12 TODO: Normalize snake_case to camelCase at the API boundary (in lib/api.ts)
// to eliminate dual-field checks like `agent.currentTask ?? agent.current_task`.
// Types have both camelCase and snake_case for: assignedAgent/assigned_agent,
// dependsOn/depends_on, needsReview/needs_review, currentTask/current_task, etc.

// Types matching server-side data structures

export type TaskState = 'pending' | 'ready' | 'running' | 'in_review' | 'done' | 'failed' | 'cancelled' | 'paused' | 'skipped';
export type DecisionStatus = 'recorded' | 'confirmed' | 'rejected';

export interface Task {
  id: string;
  title: string;
  state: TaskState;
  role: string;
  assignedAgent?: string;
  assigned_agent?: string;
  priority: number;
  source: string;
  description: string;
  claim?: string;
  dependsOn?: string[];
  depends_on?: string;
  spec_id?: string;
  cost?: number;
  needsReview?: boolean;
  needs_review?: boolean;
  created_at?: string;
  updated_at?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface Agent {
  id: string;
  role: string;
  status: string;
  runtime?: string;
  runtimeName?: string;
  model?: string;
  cost?: number;
  acp_session_id?: string;
  current_task?: string;
  currentTask?: string;
  sessionStart?: string;
}

export interface Decision {
  id: string;
  title: string;
  category: string;
  status: DecisionStatus;
  rationale: string;
  timestamp: string;
}

export interface Spec {
  id: string;
  name?: string;
  filename?: string;
  title?: string;
  path?: string;
  content: string;
  updatedAt?: string;
}

export interface ChatMessage {
  id: string;
  threadId: string | null;
  parentId: string | null;
  parentIds?: string[] | null;
  taskId: string | null;
  task_id?: string | null;
  authorType: 'user' | 'lead' | 'agent' | 'system';
  authorId: string | null;
  content: string;
  metadata: string | null;
  createdAt: string;
  updatedAt: string | null;
}

export interface Thread {
  id: string;
  title: string | null;
  originId: string | null;
  createdAt: string;
  archivedAt: string | null;
}

export interface ProjectStatus {
  config: { name: string; governance: string; [k: string]: unknown };
  taskStats: Record<string, number>;
  agentCount: number;
  totalCost: number;
}

export interface Activity {
  id: string;
  taskId: string;
  taskTitle: string;
  from: string;
  to: string;
  agent?: string;
  timestamp: string;
}

export interface ProjectSummary {
  name: string;
  governance: string;
  agentCount: number;
  taskStats: Record<string, number>;
  totalCost: number;
}

export interface CronJob {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  schedule: { kind: string; expr: string; tz?: string };
  skill?: string;
  prompt: string;
  delivery?: { mode: string; webhookUrl?: string };
  state: {
    nextRunAt: string | null;
    lastRunAt: string | null;
    lastRunStatus: 'ok' | 'error' | null;
    lastDurationMs: number | null;
    consecutiveErrors: number;
    lastError?: string;
  };
}
