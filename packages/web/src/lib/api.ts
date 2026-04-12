import type { Task, Agent, Decision, Spec, Activity, ProjectInfo } from './types.ts';

const PROJECT: ProjectInfo = {
  name: 'flightdeck-2',
  governance: 'lead-delegates',
  totalCost: 4.37,
};

const AGENTS: Agent[] = [
  { id: 'agent-lead-01', role: 'lead', status: 'working', model: 'claude-opus-4', cost: 1.82, sessionStart: '2026-04-12T01:15:00Z', currentTask: 'task-001' },
  { id: 'agent-dev-01', role: 'developer', status: 'working', model: 'claude-sonnet-4', cost: 0.94, sessionStart: '2026-04-12T01:22:00Z', currentTask: 'task-003' },
  { id: 'agent-dev-02', role: 'developer', status: 'idle', model: 'claude-sonnet-4', cost: 0.67, sessionStart: '2026-04-12T02:10:00Z' },
  { id: 'agent-review-01', role: 'reviewer', status: 'working', model: 'claude-sonnet-4', cost: 0.54, sessionStart: '2026-04-12T02:30:00Z', currentTask: 'task-005' },
  { id: 'agent-dev-03', role: 'developer', status: 'terminated', model: 'gemini-2.5-pro', cost: 0.40, sessionStart: '2026-04-12T01:45:00Z' },
];

const TASKS: Task[] = [
  { id: 'task-001', title: 'Design system architecture', state: 'running', role: 'lead', assignedAgent: 'agent-lead-01', priority: 1, source: 'user', description: 'Define the overall architecture for flightdeck-2 including package layout and API design.', dependsOn: [], createdAt: '2026-04-12T01:00:00Z', updatedAt: '2026-04-12T01:15:00Z' },
  { id: 'task-002', title: 'Set up shared types package', state: 'done', role: 'developer', assignedAgent: 'agent-dev-01', priority: 2, source: 'lead', description: 'Create @flightdeck-ai/shared with core TypeScript types.', dependsOn: ['task-001'], createdAt: '2026-04-12T01:10:00Z', updatedAt: '2026-04-12T02:00:00Z' },
  { id: 'task-003', title: 'Implement task state machine', state: 'running', role: 'developer', assignedAgent: 'agent-dev-01', priority: 2, source: 'lead', description: 'Build the task lifecycle state machine with valid transitions.', dependsOn: ['task-002'], createdAt: '2026-04-12T01:30:00Z', updatedAt: '2026-04-12T02:15:00Z' },
  { id: 'task-004', title: 'Create WebSocket server', state: 'ready', role: 'developer', priority: 3, source: 'lead', description: 'Set up WebSocket server for real-time communication between agents and UI.', dependsOn: ['task-002'], createdAt: '2026-04-12T01:35:00Z', updatedAt: '2026-04-12T01:35:00Z' },
  { id: 'task-005', title: 'Review shared types', state: 'in_review', role: 'reviewer', assignedAgent: 'agent-review-01', priority: 2, source: 'system', description: 'Code review for the shared types package.', claim: 'Checking type completeness and naming conventions.', dependsOn: ['task-002'], createdAt: '2026-04-12T02:05:00Z', updatedAt: '2026-04-12T02:30:00Z' },
  { id: 'task-006', title: 'Build CLI entry point', state: 'ready', role: 'developer', priority: 3, source: 'lead', description: 'Create the main CLI with subcommands for init, start, status.', dependsOn: ['task-001'], createdAt: '2026-04-12T01:40:00Z', updatedAt: '2026-04-12T01:40:00Z' },
  { id: 'task-007', title: 'Write governance engine', state: 'failed', role: 'developer', assignedAgent: 'agent-dev-03', priority: 2, source: 'lead', description: 'Implement the governance profile system (lead-delegates, consensus, etc).', dependsOn: ['task-002'], createdAt: '2026-04-12T01:50:00Z', updatedAt: '2026-04-12T03:00:00Z' },
  { id: 'task-008', title: 'Design web UI', state: 'running', role: 'developer', assignedAgent: 'agent-dev-02', priority: 3, source: 'lead', description: 'Create the Notion-inspired web dashboard for monitoring.', dependsOn: ['task-002'], createdAt: '2026-04-12T02:00:00Z', updatedAt: '2026-04-12T03:30:00Z' },
  { id: 'task-009', title: 'Add cost tracking', state: 'cancelled', role: 'developer', priority: 4, source: 'lead', description: 'Track token usage and cost per agent per task.', dependsOn: ['task-003'], createdAt: '2026-04-12T02:20:00Z', updatedAt: '2026-04-12T02:45:00Z' },
  { id: 'task-010', title: 'Integration tests', state: 'ready', role: 'developer', priority: 4, source: 'lead', description: 'Write integration tests for the core server loop.', dependsOn: ['task-003', 'task-004'], createdAt: '2026-04-12T02:30:00Z', updatedAt: '2026-04-12T02:30:00Z' },
];

const DECISIONS: Decision[] = [
  { id: 'dec-001', title: 'Use pnpm workspace monorepo', category: 'architecture', status: 'confirmed', rationale: 'pnpm workspaces provide efficient dependency management and are already used in the ecosystem. Monorepo keeps all packages in sync.', timestamp: '2026-04-12T01:05:00Z' },
  { id: 'dec-002', title: 'TypeScript strict mode everywhere', category: 'code-quality', status: 'confirmed', rationale: 'Strict mode catches more bugs at compile time. All packages should use strict: true in tsconfig.', timestamp: '2026-04-12T01:08:00Z' },
  { id: 'dec-003', title: 'WebSocket over REST for agent comms', category: 'architecture', status: 'recorded', rationale: 'Real-time bidirectional communication is essential for agent coordination. WebSocket reduces latency vs polling.', timestamp: '2026-04-12T01:20:00Z' },
  { id: 'dec-004', title: 'Reject Redis dependency', category: 'infrastructure', status: 'rejected', rationale: 'Redis adds operational complexity. SQLite or in-memory state is sufficient for single-machine deployments.', timestamp: '2026-04-12T02:00:00Z' },
];

const SPECS: Spec[] = [
  { id: 'spec-001', name: 'ARCHITECTURE.md', path: 'specs/ARCHITECTURE.md', content: '# Architecture\n\nFlightdeck 2.0 is a monorepo with three packages:\n\n- `@flightdeck-ai/shared` — Core types and utilities\n- `@flightdeck-ai/server` — Orchestration server\n- `@flightdeck-ai/web` — Monitoring dashboard\n\n## Communication\n\nAgents connect via WebSocket. The server maintains task state and delegates work based on the governance profile.', updatedAt: '2026-04-12T01:10:00Z' },
  { id: 'spec-002', name: 'GOVERNANCE.md', path: 'specs/GOVERNANCE.md', content: '# Governance Profiles\n\n## lead-delegates\nA single lead agent receives tasks from the user and delegates to worker agents.\n\n## consensus\nAll agents vote on task assignment and decisions.\n\n## human-in-the-loop\nRequires human approval for certain state transitions.', updatedAt: '2026-04-12T01:12:00Z' },
  { id: 'spec-003', name: 'TASK-LIFECYCLE.md', path: 'specs/TASK-LIFECYCLE.md', content: '# Task Lifecycle\n\nStates: ready → running → in_review → done\n\nAlternate paths:\n- ready → cancelled\n- running → failed\n- in_review → running (revisions needed)\n- failed → ready (retry)', updatedAt: '2026-04-12T01:30:00Z' },
];

const ACTIVITIES: Activity[] = [
  { id: 'act-001', taskId: 'task-008', taskTitle: 'Design web UI', from: 'ready', to: 'running', agent: 'agent-dev-02', timestamp: '2026-04-12T03:30:00Z' },
  { id: 'act-002', taskId: 'task-007', taskTitle: 'Write governance engine', from: 'running', to: 'failed', agent: 'agent-dev-03', timestamp: '2026-04-12T03:00:00Z' },
  { id: 'act-003', taskId: 'task-009', taskTitle: 'Add cost tracking', from: 'ready', to: 'cancelled', timestamp: '2026-04-12T02:45:00Z' },
  { id: 'act-004', taskId: 'task-005', taskTitle: 'Review shared types', from: 'ready', to: 'in_review', agent: 'agent-review-01', timestamp: '2026-04-12T02:30:00Z' },
  { id: 'act-005', taskId: 'task-003', taskTitle: 'Implement task state machine', from: 'ready', to: 'running', agent: 'agent-dev-01', timestamp: '2026-04-12T02:15:00Z' },
  { id: 'act-006', taskId: 'task-002', taskTitle: 'Set up shared types package', from: 'running', to: 'done', agent: 'agent-dev-01', timestamp: '2026-04-12T02:00:00Z' },
];

// Simulated API
export const api = {
  getProject: async (): Promise<ProjectInfo> => PROJECT,
  getTasks: async (): Promise<Task[]> => TASKS,
  getAgents: async (): Promise<Agent[]> => AGENTS,
  getDecisions: async (): Promise<Decision[]> => DECISIONS,
  getSpecs: async (): Promise<Spec[]> => SPECS,
  getActivities: async (): Promise<Activity[]> => ACTIVITIES,
};
