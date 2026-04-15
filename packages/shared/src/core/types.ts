// Branded types for type-safe IDs
declare const __brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [__brand]: B };

export type TaskId = Brand<string, 'TaskId'>;
export type SpecId = Brand<string, 'SpecId'>;
export type AgentId = Brand<string, 'AgentId'>;
export type ProjectId = Brand<string, 'ProjectId'>;
export type DecisionId = Brand<string, 'DecisionId'>;
export type MessageId = Brand<string, 'MessageId'>;

// Task states
export const TASK_STATES = [
  'pending', 'ready', 'running', 'in_review', 'done',
  'failed', 'blocked', 'paused', 'skipped', 'cancelled', 'gated',
] as const;
export type TaskState = typeof TASK_STATES[number];

// Gate types
export const GATE_TYPES = ['human_approval', 'ci_check', 'timer', 'external'] as const;
export type GateType = typeof GATE_TYPES[number];

// Agent roles
export const AGENT_ROLES = ['lead', 'planner', 'worker', 'reviewer', 'product-thinker', 'qa-tester', 'tech-writer', 'scout'] as const;
export type AgentRole = typeof AGENT_ROLES[number];

// Agent runtime types
export const AGENT_RUNTIMES = ['acp', 'pty'] as const;
export type AgentRuntime = typeof AGENT_RUNTIMES[number];

// Agent status
export const AGENT_STATUSES = ['idle', 'busy', 'offline', 'errored', 'suspended', 'hibernated', 'retired'] as const;
export type AgentStatus = typeof AGENT_STATUSES[number];

// Governance profiles
export const GOVERNANCE_PROFILES = ['autonomous', 'collaborative', 'supervised', 'custom'] as const;
export type GovernanceProfile = typeof GOVERNANCE_PROFILES[number];

// Decision types
export const DECISION_TYPES = ['architecture', 'implementation', 'dependency', 'api_design', 'tradeoff'] as const;
export type DecisionType = typeof DECISION_TYPES[number];

// Decision statuses
export const DECISION_STATUSES = [
  'auto_approved', 'pending_review', 'human_approved', 'human_rejected', 'human_modified',
] as const;
export type DecisionStatus = typeof DECISION_STATUSES[number];

// Isolation strategies
export const ISOLATION_STRATEGIES = ['git_worktree', 'directory', 'none'] as const;
export type IsolationStrategy = typeof ISOLATION_STRATEGIES[number];

// On-completion actions
export const ON_COMPLETION_ACTIONS = ['explore', 'stop', 'ask'] as const;
export type OnCompletionAction = typeof ON_COMPLETION_ACTIONS[number];

// ── Data types ──

export type TaskSource = 'planned' | 'adhoc' | 'escalation';

export interface Task {
  id: TaskId;
  specId: SpecId | null;
  parentTaskId: TaskId | null;
  title: string;
  description: string;
  state: TaskState;
  role: AgentRole;
  dependsOn: TaskId[];
  priority: number;
  assignedAgent: AgentId | null;
  acpSessionId: string | null;
  source: TaskSource;
  stale: boolean;
  compactedAt: string | null;
  createdAt: string; // ISO timestamp
  updatedAt: string;
}

export interface Agent {
  id: AgentId;
  role: AgentRole;
  runtime: AgentRuntime;
  /** Actual runtime name (e.g. 'opencode', 'codex', 'copilot'). May differ from `runtime` which is the adapter type. */
  runtimeName?: string | null;
  acpSessionId: string | null;
  status: AgentStatus;
  currentSpecId: SpecId | null;
  costAccumulated: number;
  lastHeartbeat: string | null;
}

export interface CostEntry {
  agentId: AgentId;
  specId: SpecId | null;
  tokensIn: number;
  tokensOut: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsd: number;
  timestamp: string;
}

export interface Decision {
  id: DecisionId;
  taskId: TaskId;
  agentId: AgentId;
  type: DecisionType;
  title: string;
  reasoning: string;
  alternatives: string[];
  confidence: number;
  reversible: boolean;
  timestamp: string;
  status: DecisionStatus;
  humanFeedback?: string;
}

export interface Message {
  id: MessageId;
  from: AgentId;
  to: AgentId | null; // null = channel message
  channel: string | null;
  content: string;
  timestamp: string;
}

export interface RoleModelConfig {
  runtime?: string;
  model?: string;   // tier name or specific model ID
}

export interface AgentsConfig {
  default_runtime?: string;
  default_model?: string;    // fallback tier/model for any role not specified
  roles?: Record<string, RoleModelConfig>;  // AgentRole or custom role names
}

export interface ProjectConfig {
  name: string;
  governance: GovernanceProfile;
  isolation: IsolationStrategy;
  onCompletion: OnCompletionAction;
  costThresholdPerDay?: number;
  maxConcurrentAgents?: number;
  agents?: AgentsConfig;
  /** Webhook notification configuration. */
  notifications?: {
    webhooks?: Array<{
      url: string;
      events: string[];
    }>;
  };
  /** The working directory where .flightdeck.json lives (project root). */
  cwd?: string;
}

export interface FlightdeckJson {
  project: string;
}

// ── State machine ──

type TransitionKey = `${TaskState}->${TaskState}`;

const VALID_TRANSITIONS = new Set<TransitionKey>([
  'pending->ready',
  'pending->blocked',
  'pending->skipped',
  'ready->skipped',
  'ready->running',
  'ready->gated',
  'ready->paused',
  'ready->cancelled',
  'running->in_review',
  'running->failed',
  'running->paused',
  'running->blocked',
  'running->cancelled',
  'in_review->done',
  'in_review->running', // reviewer rejects, back to worker
  'in_review->failed',
  'failed->ready', // retry
  'blocked->ready',
  'blocked->pending',
  'paused->ready',
  'paused->running',
  'gated->ready',
  'gated->running',
  'skipped->pending',
  'done->ready', // reopen
]);

// Side effects emitted on transitions
export type SideEffect =
  | { type: 'notify_agent'; agentId: AgentId; message: string }
  | { type: 'spawn_reviewer'; taskId: TaskId }
  | { type: 'resolve_dependents'; taskId: TaskId }
  | { type: 'block_dependents'; taskId: TaskId }
  | { type: 'unblock_dependents'; taskId: TaskId }
  | { type: 'clear_assignment'; taskId: TaskId }
  | { type: 'set_timestamp'; taskId: TaskId }
  | { type: 'escalate'; taskId: TaskId; reason: string }
  | { type: 'update_dag'; taskId: TaskId }
  | { type: 'log_decision'; decision: Decision };

export interface TransitionResult {
  newState: TaskState;
  effects: SideEffect[];
}

export function transition(
  current: TaskState,
  target: TaskState,
  context?: { taskId?: TaskId; agentId?: AgentId },
): TransitionResult {
  const key: TransitionKey = `${current}->${target}`;
  if (!VALID_TRANSITIONS.has(key)) {
    throw new Error(`Invalid state transition: ${current} -> ${target}`);
  }

  const effects: SideEffect[] = [];

  // Emit side effects based on transition
  if (target === 'in_review' && current === 'running' && context?.taskId) {
    effects.push({ type: 'spawn_reviewer', taskId: context.taskId });
  }
  if (target === 'done' && context?.taskId) {
    effects.push({ type: 'resolve_dependents', taskId: context.taskId });
    effects.push({ type: 'set_timestamp', taskId: context.taskId });
  }
  if (target === 'failed' && context?.taskId) {
    effects.push({ type: 'escalate', taskId: context.taskId, reason: 'Task failed' });
    effects.push({ type: 'block_dependents', taskId: context.taskId });
    effects.push({ type: 'clear_assignment', taskId: context.taskId });
  }
  if ((target === 'ready' && current === 'failed') && context?.taskId) {
    effects.push({ type: 'clear_assignment', taskId: context.taskId });
  }
  if (target === 'cancelled' && context?.taskId) {
    effects.push({ type: 'clear_assignment', taskId: context.taskId });
    effects.push({ type: 'block_dependents', taskId: context.taskId });
  }
  if (target === 'skipped' && context?.taskId) {
    effects.push({ type: 'resolve_dependents', taskId: context.taskId });
  }
  if (target === 'ready' && current === 'done' && context?.taskId) {
    effects.push({ type: 'clear_assignment', taskId: context.taskId });
  }

  return { newState: target, effects };
}

export function isValidTransition(from: TaskState, to: TaskState): boolean {
  return VALID_TRANSITIONS.has(`${from}->${to}` as TransitionKey);
}
