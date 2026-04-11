# Flightdeck 2.0 — Product Specification

**Status:** Draft
**Author:** Claw + Justin
**Created:** 2026-04-11

---

## Vision

A multi-agent orchestration platform that lets agent teams work autonomously for hours or days, with humans steering through specs, governance policies, and decision review — not micromanagement.

## Core Principle

**Agents are the workers. Flightdeck is the project manager. Humans are the executives.**

Humans define *what* (specs) and *how much freedom* (governance). Flightdeck translates that into *tasks*, assigns agents, enforces quality, and reports back. Agents do the actual work through whatever coding tool they use (Claude Code, Codex, Cursor, etc.).

---

## User Scenarios

### Scenario 1: Hands-Off Day (Priority: P1)

**User:** Senior dev who trusts agents but wants accountability.

1. Evening: user writes a spec ("Add OAuth2 support to the API")
2. Flightdeck generates a plan → task DAG (5-8 tasks with dependencies)
3. User sets `profile: autonomous`, goes to sleep
4. Overnight: agents pick up tasks in topo order, run tests, review each other's work
5. Morning: user gets a daily report in Discord:
   - 6/8 tasks done, 1 blocked (needs API key), 1 in review
   - 3 key decisions logged (chose PKCE over implicit flow, added refresh token rotation, used jose library)
   - $4.20 spent
6. User unblocks the gated task, adjusts one decision, agents continue

**Independent Test:** Can be tested with a mock spec + 3 stub agents. Verify: DAG progresses, gate blocks correctly, daily report generates.

### Scenario 2: Collaborative Session (Priority: P1)

**User:** PM or junior dev who wants to stay in the loop.

1. User creates spec, Flightdeck proposes a plan
2. User tweaks the plan (reorder priorities, remove a task, add a constraint)
3. Each task start triggers a notification: "Agent is about to implement X. Approach: Y. OK?"
4. User approves or suggests a different approach
5. After each task, user gets a summary + diff link

**Independent Test:** Verify: proposal→approval flow works, agent waits when gated on human approval.

### Scenario 3: Mid-Day Pivot (Priority: P2)

**User:** Startup founder who changes direction frequently.

1. Agents are running on a spec, 3/7 tasks done
2. User updates the spec (scope change)
3. Flightdeck detects affected tasks, marks them stale
4. Running agents get notified to pause
5. Flightdeck re-plans: some tasks survive, some get cancelled, new ones get created
6. Agents resume on the updated DAG

**Independent Test:** Verify: stale detection works, running agents get pause signal, DAG regenerates correctly.

### Scenario 4: Multi-Project (Priority: P3)

**User:** Team lead managing multiple repos/features.

1. Multiple specs running in parallel, each with their own DAG
2. Shared agent pool — Flightdeck assigns agents based on role + availability
3. Cross-project dependencies (Feature B depends on Feature A's API)
4. Unified dashboard showing all projects

---

## Architecture

### Three-Layer Model

```
Human Layer:  Specs → Governance Policies → Decision Review
                ↓              ↓                   ↑
Orchestration: Plan → Task DAG → Agent Assignment → Decision Log → Reports
                                    ↓         ↑
Agent Layer:   Agent executes → Reports progress via MCP → Gets next task
```

### Communication Model

```
Human ←→ Flightdeck:  CLI / Web UI / VSCode / Discord
Flightdeck → Agent:   ACP (spawn, steer, kill sessions)
Agent → Flightdeck:   MCP (report progress, read tasks, send messages)
Module ←→ Module:     Events (internal pub/sub, never direct calls)
```

### Module Responsibilities

Each module has ONE job. Modules communicate ONLY through the event bus.

| Module | Responsibility | Knows about |
|---|---|---|
| **core/** | Types + state machine | Nothing (pure) |
| **dag/** | Task dependency graph | Tasks and their deps |
| **specs/** | Requirements + plans | Specs and changes |
| **comms/** | Message delivery | Messages and recipients |
| **agents/** | Agent lifecycle | Agent sessions and health |
| **verification/** | Code review process | Review requests and verdicts |
| **governance/** | Policy enforcement | Rules and decisions |
| **decisions/** | Decision audit trail | Decisions and their context |
| **orchestrator/** | Coordination | Everything (only module that subscribes to all events) |
| **events/** | Internal pub/sub | Event types (no business logic) |
| **persistence/** | Storage | SQL schema (no business logic) |

### External Interfaces

| Interface | Protocol | Direction | Purpose |
|---|---|---|---|
| **CLI** | stdin/stdout | Human → Flightdeck | Local project management |
| **MCP Server** | stdio JSON-RPC | Agent → Flightdeck | Agents read/write state |
| **ACP Adapter** | ACP protocol | Flightdeck → Agent | Spawn/steer/kill agents |
| **Web API** | HTTP REST + WebSocket | UI → Flightdeck | Dashboard, real-time updates |
| **VSCode Extension** | Extension API | Human → Flightdeck | IDE integration |
| **Webhooks** | HTTP POST | Flightdeck → External | Notifications (Discord, Slack, etc.) |

---

## Governance System

### Profiles

Pre-built governance profiles that users can select and customize:

**`autonomous`** — Maximum agent freedom
- Agents make all implementation decisions
- Only gate on: public API changes, security-sensitive operations
- Report: daily summary
- Escalate: 5+ consecutive failures, cost > $50/day

**`collaborative`** — Human in the loop
- Gate before starting each task (propose-and-wait)
- Gate on: architecture decisions, dependency choices, API design
- Report: per-milestone + real-time notifications
- Escalate: 2+ failures, cost > $10/day

**`supervised`** — Training wheels
- Gate on everything except trivial tasks (tests, formatting)
- Human approves each step
- Report: per-task
- Escalate: any failure

**`custom`** — User defines their own rules

### Governance Policy Schema

```yaml
# .flightdeck/governance.yaml
profile: autonomous | collaborative | supervised | custom

# What requires human approval
approval_gates:
  - trigger: architecture_change | dependency_upgrade | public_api_change | 
             security_sensitive | cost_exceeds | implementation_start
    action: gate_human | propose_and_wait | log_and_continue | block
    threshold: <optional, e.g., cost amount>

# When to stop and escalate
escalation:
  consecutive_failures: <number>
  cost_threshold: <amount per day>
  uncertainty_threshold: <0.0-1.0, agent self-reported>
  stale_task_timeout: <duration>

# How to report
reporting:
  cadence: per_task | per_milestone | hourly | daily | on_demand
  channels:
    - type: discord | slack | email | webhook
      target: <channel-id or URL>
  include:
    - task_summary
    - decision_log
    - cost_breakdown
    - next_steps

# Cross-model verification
verification:
  enabled: true | false
  writer_reviewer_same_model: false  # enforce different models
  fresh_reviewer_on_retry: true
  independent_test_validation: true  # orchestrator runs tests, not agent
```

### Decision Log

Every non-trivial decision gets recorded:

```typescript
interface Decision {
  id: string;
  taskId: string;
  agentId: string;
  type: 'architecture' | 'implementation' | 'dependency' | 'api_design' | 'tradeoff';
  title: string;           // "Chose PKCE over implicit OAuth flow"
  reasoning: string;       // Why this choice
  alternatives: string[];  // What was considered
  confidence: number;      // 0-1, agent self-reported
  reversible: boolean;     // Can this be undone easily?
  timestamp: Date;
  
  // Governance response
  status: 'auto_approved' | 'pending_review' | 'human_approved' | 'human_rejected' | 'human_modified';
  humanFeedback?: string;
}
```

Users review decisions at their pace. High-confidence + reversible decisions auto-approve in autonomous mode. Low-confidence or irreversible decisions gate in all modes.

---

## Daily Report Format

Generated automatically at the configured cadence:

```markdown
# Flightdeck Daily Report — 2026-04-11

## Summary
- **Spec:** Add OAuth2 support to API
- **Progress:** 6/8 tasks complete (75%)
- **Status:** On track
- **Cost:** $4.20

## Completed Today
- ✅ task-a1b2: Set up OAuth2 middleware (architect → dev-1)
- ✅ task-c3d4: Implement PKCE flow (dev-1)
- ✅ task-e5f6: Add token refresh endpoint (dev-2)
- ✅ task-g7h8: Write integration tests (dev-1)
- ✅ task-i9j0: Code review (reviewer-1)  
- ✅ task-k1l2: Update API documentation (dev-2)

## Blocked
- ⏸ task-m3n4: Configure production OAuth provider
  - **Gate:** human_approval — needs API client ID/secret
  - **Waiting since:** 14:30 UTC

## In Review
- 🔍 task-o5p6: Security audit of token handling
  - **Reviewer:** reviewer-2 (different model from writer)

## Key Decisions
1. **Chose PKCE over implicit flow** (auto-approved, high confidence)
   - Reasoning: Implicit flow is deprecated in OAuth 2.1
   - Alternative: Authorization code without PKCE
2. **Used `jose` library over `jsonwebtoken`** (auto-approved)
   - Reasoning: Better ESM support, actively maintained, Web Crypto API
3. **Added refresh token rotation** (pending review)
   - Reasoning: Security best practice, prevents token replay
   - ⚠️ This adds complexity to the token storage layer

## Tomorrow's Plan
- Unblock task-m3n4 (needs human input)
- Complete security audit
- Final integration test pass

## Cost Breakdown
| Agent | Role | Tasks | Cost |
|---|---|---|---|
| dev-1 | developer | 3 | $1.80 |
| dev-2 | developer | 2 | $1.20 |
| reviewer-1 | code-reviewer | 1 | $0.60 |
| reviewer-2 | critical-reviewer | 1 | $0.60 |
```

---

## Requirements

### Functional Requirements

- **FR-001:** System MUST support the full Spec → Plan → Task DAG → Execution lifecycle
- **FR-002:** System MUST enforce governance policies (approval gates, escalation rules)
- **FR-003:** System MUST record all non-trivial decisions in an append-only decision log
- **FR-004:** System MUST generate periodic reports at configured cadence
- **FR-005:** System MUST expose MCP tools for agents to read/write state
- **FR-006:** System MUST expose ACP interface to spawn/steer/kill agent sessions
- **FR-007:** System MUST support cross-model verification (writer ≠ reviewer)
- **FR-008:** System MUST detect spec changes and mark affected tasks as stale
- **FR-009:** System MUST support task gating (human approval, CI check, timer, external)
- **FR-010:** System MUST support multiple governance profiles (autonomous, collaborative, supervised, custom)
- **FR-011:** System MUST NOT allow agents to self-certify test results (orchestrator validates independently)
- **FR-012:** System MUST persist all state in SQLite (survive restarts)
- **FR-013:** System MUST support concurrent agents on the same DAG with file-level conflict detection
- **FR-014:** System MUST provide CLI for all core operations
- **FR-015:** System MUST support task compaction (summarize completed tasks to save context)

### Non-Functional Requirements

- **NFR-001:** Zero external dependencies beyond SQLite, Zod, and MCP SDK
- **NFR-002:** Library-first architecture (CLI, MCP, ACP, Web are thin wrappers)
- **NFR-003:** Modules communicate only through events (no direct cross-module calls)
- **NFR-004:** State machine is the single source of truth for all state transitions
- **NFR-005:** All entity IDs are hash-based (conflict-free concurrent creation)

---

## Success Criteria

- **SC-001:** An agent team can run for 8+ hours on a multi-task spec without human intervention (in autonomous mode)
- **SC-002:** User can review all decisions made during autonomous run and override any of them
- **SC-003:** Switching governance profile mid-run takes effect within 1 task cycle
- **SC-004:** Daily report accurately reflects all work done, decisions made, and money spent
- **SC-005:** A new user can go from `flightdeck init` to agents running in < 10 minutes

---

## Open Questions

1. **Plan generation:** Should Flightdeck generate plans from specs using an LLM call, or should users/agents write plans manually? (Probably: LLM-assisted with human approval)
2. **Agent assignment:** Round-robin vs. capability-based matching vs. let agents self-select?
3. **Multi-repo support:** One Flightdeck instance per repo, or one instance managing multiple repos?
4. **Pricing model:** If this becomes a product, how to price? (Per agent-hour? Per task? Flat rate?)
5. **Offline mode:** Should agents be able to work without Flightdeck connection and sync later?

---

## Implementation Phases

### Phase 1: Core Engine (✅ Done — current POC)
- Types, state machine, DAG, specs, comms, agents, verification, events, persistence
- CLI + MCP server

### Phase 2: Governance + Orchestrator
- Governance policy engine
- Decision log
- Orchestrator (event-driven coordination)
- ACP adapter
- Daily report generation

### Phase 3: User Interfaces
- Web dashboard (task board, spec editor, decision review, agent monitor)
- VSCode extension
- Discord/Slack webhook integration

### Phase 4: Production Hardening
- Fix all code quality issues from POC
- State machine enforcement (no bypassing)
- Adjacency list optimization
- Proper error handling + retries
- Auth + multi-user support
