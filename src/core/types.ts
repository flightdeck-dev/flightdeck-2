// Core domain types for Flightdeck 2.0
// Inspired by: beads (hash IDs, gates, compaction), Flightdeck 1.0 (roles, state machine),
// sudocode (spec↔issue), OpenSpec (spec/change separation)

import { z } from 'zod';
import { createHash } from 'crypto';

// ============================================================================
// Branded Types — prevent mixing IDs across entity types
// ============================================================================

declare const __brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [__brand]: B };

export type TaskId = Brand<string, 'TaskId'>;
export type SpecId = Brand<string, 'SpecId'>;
export type PlanId = Brand<string, 'PlanId'>;
export type AgentId = Brand<string, 'AgentId'>;
export type MessageId = Brand<string, 'MessageId'>;
export type GateId = Brand<string, 'GateId'>;
export type EventId = Brand<string, 'EventId'>;
export type RoleId = Brand<string, 'RoleId'>;
export type ChangeId = Brand<string, 'ChangeId'>;

// ============================================================================
// Hash-based ID generation (from beads — conflict-free multi-agent)
// ============================================================================

export function generateId<T extends string>(prefix: string, seed?: string): Brand<string, T> {
  const input = seed ?? `${Date.now()}-${Math.random()}`;
  const hash = createHash('sha256').update(input).digest('hex').slice(0, 8);
  return `${prefix}-${hash}` as Brand<string, T>;
}

export const taskId = (seed?: string): TaskId => generateId<'TaskId'>('tk', seed);
export const specId = (seed?: string): SpecId => generateId<'SpecId'>('sp', seed);
export const planId = (seed?: string): PlanId => generateId<'PlanId'>('pl', seed);
export const agentId = (seed?: string): AgentId => generateId<'AgentId'>('ag', seed);
export const messageId = (seed?: string): MessageId => generateId<'MessageId'>('mg', seed);
export const gateId = (seed?: string): GateId => generateId<'GateId'>('gt', seed);
export const eventId = (seed?: string): EventId => generateId<'EventId'>('ev', seed);
export const changeId = (seed?: string): ChangeId => generateId<'ChangeId'>('ch', seed);

// ============================================================================
// Task States & Transitions (data-driven state machine)
// ============================================================================

export const TASK_STATES = [
  'pending', 'ready', 'running', 'in_review', 'done',
  'failed', 'blocked', 'paused', 'skipped', 'gated',
] as const;
export type TaskState = typeof TASK_STATES[number];

export const TASK_ACTIONS = [
  'start', 'complete', 'fail', 'review', 'approve', 'reject',
  'pause', 'resume', 'retry', 'skip', 'block', 'unblock',
  'gate', 'clear_gate', 'reopen',
] as const;
export type TaskAction = typeof TASK_ACTIONS[number];

// ============================================================================
// Side Effects — discriminated unions for what happens after a transition
// ============================================================================

export type SideEffect =
  | { type: 'resolve_dependents'; taskId: TaskId }
  | { type: 'block_dependents'; taskId: TaskId }
  | { type: 'notify'; targets: string[]; message: string }
  | { type: 'mark_stale'; taskIds: TaskId[] }
  | { type: 'emit_event'; eventType: string; payload: Record<string, unknown> }
  | { type: 'compact'; taskId: TaskId }
  | { type: 'spawn_reviewer'; taskId: TaskId };

export interface TransitionResult {
  newState: TaskState;
  sideEffects: SideEffect[];
}

// The transition table: [fromState][action] → TransitionResult
// This is THE beating heart. All state changes flow through here.
const T = (newState: TaskState, ...sideEffects: SideEffect[]): TransitionResult => ({ newState, sideEffects });

type TransitionTable = Partial<Record<TaskState, Partial<Record<TaskAction, (taskId: TaskId) => TransitionResult>>>>;

export const TRANSITION_TABLE: TransitionTable = {
  pending: {
    start: (id) => T('ready'),
    block: (id) => T('blocked'),
    skip: (id) => T('skipped'),
    gate: (id) => T('gated'),
    pause: (id) => T('paused'),
  },
  ready: {
    start: (id) => T('running', { type: 'emit_event', eventType: 'task.started', payload: { taskId: id } }),
    block: (id) => T('blocked'),
    skip: (id) => T('skipped'),
    pause: (id) => T('paused'),
    gate: (id) => T('gated'),
  },
  running: {
    complete: (id) => T('done', { type: 'resolve_dependents', taskId: id }, { type: 'compact', taskId: id }),
    fail: (id) => T('failed', { type: 'block_dependents', taskId: id }),
    review: (id) => T('in_review', { type: 'spawn_reviewer', taskId: id }),
    pause: (id) => T('paused'),
    skip: (id) => T('skipped'),
  },
  in_review: {
    approve: (id) => T('done', { type: 'resolve_dependents', taskId: id }, { type: 'compact', taskId: id }),
    reject: (id) => T('failed', { type: 'block_dependents', taskId: id }),
    complete: (id) => T('done', { type: 'resolve_dependents', taskId: id }),
  },
  done: {
    reopen: (id) => T('ready'),
  },
  failed: {
    retry: (id) => T('ready'),
    skip: (id) => T('skipped'),
    reopen: (id) => T('ready'),
  },
  blocked: {
    unblock: (id) => T('ready'),
    skip: (id) => T('skipped'),
  },
  paused: {
    resume: (id) => T('ready'),
    skip: (id) => T('skipped'),
  },
  skipped: {
    reopen: (id) => T('pending'),
  },
  gated: {
    clear_gate: (id) => T('ready', { type: 'emit_event', eventType: 'gate.cleared', payload: { taskId: id } }),
    fail: (id) => T('failed'),
    skip: (id) => T('skipped'),
  },
};

export interface TransitionError {
  taskId: TaskId;
  currentState: TaskState;
  action: TaskAction;
  reason: string;
}

export function transition(taskId: TaskId, currentState: TaskState, action: TaskAction): TransitionResult | TransitionError {
  const stateTransitions = TRANSITION_TABLE[currentState];
  if (!stateTransitions) {
    return { taskId, currentState, action, reason: `No transitions defined for state '${currentState}'` };
  }
  const transitionFn = stateTransitions[action];
  if (!transitionFn) {
    return { taskId, currentState, action, reason: `Action '${action}' not valid from state '${currentState}'` };
  }
  return transitionFn(taskId);
}

export function isTransitionError(result: TransitionResult | TransitionError): result is TransitionError {
  return 'reason' in result;
}

// ============================================================================
// Gate primitives (from beads — async coordination)
// ============================================================================

export const GATE_TYPES = ['ci_check', 'pr_review', 'timer', 'human_approval', 'external'] as const;
export type GateType = typeof GATE_TYPES[number];

export interface Gate {
  id: GateId;
  taskId: TaskId;
  awaitType: GateType;
  awaitId: string;
  timeout?: number; // ms
  cleared: boolean;
  clearedAt?: Date;
  createdAt: Date;
}

// ============================================================================
// Core Entity Types
// ============================================================================

export interface Task {
  id: TaskId;
  title: string;
  description: string;
  state: TaskState;
  role: RoleId;
  files: string[];
  dependsOn: TaskId[];
  priority: number;
  specRequirementId?: string; // Traceability: links to spec requirement
  planId?: PlanId;
  assignedAgent?: AgentId;
  model?: string;
  gate?: Gate;
  stale: boolean;
  compacted: boolean;
  compactedSummary?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface Requirement {
  id: string;
  type: 'functional' | 'non_functional';
  description: string;
  acceptanceCriteria: string[];
}

export interface UserScenario {
  id: string;
  title: string;
  steps: string[];
  expectedOutcome: string;
}

export interface Spec {
  id: SpecId;
  title: string;
  requirements: Requirement[];
  userScenarios: UserScenario[];
  createdAt: Date;
  updatedAt: Date;
}

export type ChangeStatus = 'proposed' | 'approved' | 'rejected' | 'merged';

export interface Change {
  id: ChangeId;
  specId: SpecId;
  title: string;
  description: string;
  status: ChangeStatus;
  diff: Partial<Pick<Spec, 'title' | 'requirements' | 'userScenarios'>>;
  createdAt: Date;
  updatedAt: Date;
}

export interface Plan {
  id: PlanId;
  specId: SpecId;
  title: string;
  taskIds: TaskId[];
  requirementMapping: Record<string, TaskId[]>; // requirement ID → task IDs
  createdAt: Date;
  updatedAt: Date;
}

export type MessageType = 'direct' | 'group' | 'broadcast' | 'system';
export type MessagePriority = 'critical' | 'normal' | 'low';
export type DeliveryStatus = 'sent' | 'delivered' | 'read';

export interface Message {
  id: MessageId;
  type: MessageType;
  priority: MessagePriority;
  from: AgentId;
  to: AgentId[];
  content: string;
  threadId?: MessageId;
  replyTo?: MessageId;
  deliveryStatus: DeliveryStatus;
  createdAt: Date;
  readAt?: Date;
}

export type AgentStatus = 'idle' | 'busy' | 'crashed' | 'terminated';

export interface Agent {
  id: AgentId;
  name: string;
  role: RoleId;
  model: string;
  status: AgentStatus;
  capabilities: string[];
  costAccumulated: number;
  lastHeartbeat?: Date;
  sessionId?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface Role {
  id: RoleId;
  name: string;
  systemPrompt: string;
  capabilities: string[];
}

// ============================================================================
// Event Types (discriminated unions)
// ============================================================================

export type FlightdeckEvent =
  | { type: 'task.created'; taskId: TaskId; timestamp: Date }
  | { type: 'task.state_changed'; taskId: TaskId; from: TaskState; to: TaskState; action: TaskAction; timestamp: Date }
  | { type: 'task.started'; taskId: TaskId; timestamp: Date }
  | { type: 'task.completed'; taskId: TaskId; timestamp: Date }
  | { type: 'task.failed'; taskId: TaskId; reason?: string; timestamp: Date }
  | { type: 'gate.created'; gateId: GateId; taskId: TaskId; timestamp: Date }
  | { type: 'gate.cleared'; gateId: GateId; taskId: TaskId; timestamp: Date }
  | { type: 'agent.spawned'; agentId: AgentId; role: RoleId; timestamp: Date }
  | { type: 'agent.crashed'; agentId: AgentId; timestamp: Date }
  | { type: 'agent.heartbeat'; agentId: AgentId; timestamp: Date }
  | { type: 'message.sent'; messageId: MessageId; from: AgentId; timestamp: Date }
  | { type: 'spec.changed'; specId: SpecId; changeId: ChangeId; timestamp: Date }
  | { type: 'review.requested'; taskId: TaskId; reviewerAgent?: AgentId; timestamp: Date }
  | { type: 'review.completed'; taskId: TaskId; approved: boolean; reviewerAgent: AgentId; timestamp: Date };

export type EventType = FlightdeckEvent['type'];
