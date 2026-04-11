# Flightdeck 2.0

A next-generation multi-agent orchestration engine. Library-only — no HTTP server, no UI.

## Install

```bash
npm install
```

## Test

```bash
npm test
```

## Modules

| Module | Purpose |
|--------|---------|
| `core/` | Domain types, branded IDs, data-driven state machine |
| `dag/` | Task DAG with dependency resolution, file conflict detection, compaction |
| `specs/` | Spec & plan layer with change proposals and traceability |
| `comms/` | Persistent messaging with priority, threading, coalescing |
| `agents/` | Agent lifecycle, role registry, crash detection, cost tracking |
| `verification/` | Cross-model review, blocking quality gates, independent validation |
| `events/` | Priority-aware event pipeline with back-pressure |
| `persistence/` | SQLite schema via drizzle-orm |

## Quick Start

```typescript
import { TaskDAG, SpecStore, AgentRegistry, VerificationEngine, EventBus } from '@flightdeck/core';

// Create a DAG
const dag = new TaskDAG();
const task = dag.addTask({ title: 'Build auth', description: '...', role: 'role-dev' as any });

// State transitions flow through the state machine
dag.applyAction(task.id, 'start');   // ready → running
dag.applyAction(task.id, 'review');  // running → in_review (spawns reviewer)
dag.applyAction(task.id, 'approve'); // in_review → done (resolves dependents)

// Verification: cross-model review
const engine = new VerificationEngine();
const review = engine.requestReview({ taskId: task.id, writerAgent: 'ag-1' as any, writerModel: 'gpt-4' });
engine.assignReviewer(review.id, 'ag-2' as any, 'claude-3'); // Different model required
```

## Design Principles

1. **Data-driven state machine** — transition table as data, not scattered if-else
2. **Hash-based IDs** — conflict-free multi-agent task creation (from beads)
3. **Spec → Plan → Task traceability** — every task traces to a requirement
4. **Trust nothing** — cross-model review, fresh reviewer on retry, orchestrator validates
5. **Compaction** — completed tasks decay to summaries, saving context window
6. **File conflict detection** — tasks sharing files must have explicit dependencies
