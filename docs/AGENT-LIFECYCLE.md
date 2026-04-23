# Agent Lifecycle, Communication Patterns & Task State Transitions

> Auto-generated from source code analysis. All file references are relative to `packages/server/src/`.

---

## 1. Agent Lifecycle

### Agent Statuses

All agents share a common status enum (`core/types.ts:37`):

```
idle | busy | offline | errored
```

Additionally, agents may be **hibernated** (persisted to SQLite, no live ACP session) — this is tracked via `updateAgentStatus(..., 'hibernated')` in the Orchestrator's recovery path (`orchestrator/Orchestrator.ts:recoverOrphanedTasks`).

---

### 1.1 Lead Agent

The Lead is the user-facing orchestration agent — the "project manager."

| Aspect | Detail |
|---|---|
| **Spawn trigger** | On-demand when first `steerLead()` is called (`lead/LeadManager.ts:steerLead`) |
| **Enforced singleton** | `spawnLead()` checks for existing lead with `status ∈ {busy, idle}` — skips if one exists (`lead/LeadManager.ts:spawnLead`) |
| **Runtime re-read** | On spawn, `ModelConfig` is re-read to pick up runtime changes (e.g. copilot → claude) |
| **Session persistence** | Session saved to per-project SQLite; on daemon restart, `setSuspendedLead()` stores the old session ID for lazy resume |
| **Resume** | `resumeLead(previousAcpSessionId, cwd, model)` attempts ACP `session/resume`; falls back to fresh spawn on failure |
| **Heartbeat** | Configurable timer sends periodic `{ type: 'heartbeat' }` steers; conditions: tasks_completed, idle_duration, time_window |

**Lifecycle diagram:**

```
                    ┌─────────────────────────────────┐
                    │         No Lead exists           │
                    └──────────────┬──────────────────┘
                                   │ steerLead() called
                                   ▼
                    ┌──────────────────────────────────┐
                    │  spawnLead() / resumeLead()       │
                    │  → ACP session created            │
                    │  → Registered in SQLite (busy)    │
                    └──────────────┬──────────────────┘
                                   │
                          ┌────────┴────────┐
                          ▼                 ▼
                       [busy]           [idle]
                     (processing      (awaiting
                      steer)           next steer)
                          │                 │
                          └────────┬────────┘
                                   │ daemon shutdown
                                   ▼
                             [hibernated]
                          (session saved to SQLite,
                           no live ACP session)
                                   │
                                   │ next steerLead()
                                   ▼
                          [auto-resumed / re-spawned]
```

---

### 1.2 Director Agent

The Director handles task decomposition and plan management.

| Aspect | Detail |
|---|---|
| **Spawn trigger** | On-demand when Lead steers Director via `steerDirector()` (`lead/LeadManager.ts:steerDirector`) |
| **Spawn method** | `spawnDirector()` — creates ACP session, registers in SQLite |
| **States** | Same as Lead: busy → idle → hibernated → resumed |
| **Session persistence** | Like Lead: `setSuspendedDirector()` + `resumeDirector()` for lazy resume on restart |
| **Events received** | `DirectorEvent`: critical_task_completed, task_failed, worker_escalation, spec_milestone, plan_validation_request, file_conflict |

---

### 1.3 Worker Agent

Workers are disposable execution agents that implement individual tasks.

| Aspect | Detail |
|---|---|
| **Spawn trigger 1** | Orchestrator `autoAssignReadyTasks()` — when a ready task has no idle worker, `agentManager.spawnAgent()` is called (`orchestrator/Orchestrator.ts:autoAssignReadyTasks`) |
| **Spawn trigger 2** | Director/Lead via `flightdeck_agent_spawn` MCP tool (`mcp/server.ts:502`) |
| **Assignment** | `dag.claimTask(taskId, agentId)` — task transitions ready → running |
| **Task context** | On assignment, worker receives system message with task title, description, acceptance criteria, dependencies |
| **Isolation** | `file_lock` (default) or `git_worktree` — configured per project (`core/types.ts:IsolationStrategy`) |
| **Session persistence** | **Not persisted** across restarts — workers are disposable |
| **Max concurrency** | `config.maxConcurrentWorkers` (default: 30) |

**Lifecycle diagram:**

```
     [spawn]
        │
        ▼
     [idle] ◄──────────────────────────┐
        │                               │
        │ Orchestrator assigns task     │ task_submit (done/in_review)
        ▼                               │
     [busy] ───────────────────────────┘
        │
        │ session crash / task_fail
        ▼
    [offline]
   (terminated)
```

**On daemon restart:** Running tasks with no live ACP session are failed → retried → back to ready. Worker agents are marked offline/hibernated (`Orchestrator.recoverOrphanedTasks`).

---

### 1.4 Reviewer Agent

Reviewers validate completed work before marking tasks done.

| Aspect | Detail |
|---|---|
| **Spawn trigger** | `spawn_reviewer` side effect when task transitions running → in_review (`core/types.ts:transition`), handled by `processReview()` in `verification/ReviewFlow.ts` |
| **Fallback spawn** | Orchestrator `spawnMissingReviewers()` catches in_review tasks without active reviewers each tick |
| **Pool reuse** | Idle reviewers can be re-steered with new reviews |
| **Lifecycle** | busy (reviewing) → idle (done) → reused for next review or retired |
| **Verdict** | `flightdeck_review_submit` MCP tool: approve → done, request_changes → running (back to worker) |

---

## 2. Communication Patterns

### Communication Flow Diagram

```
                         ┌─────────┐
                         │  User   │
                         └────┬────┘
                              │ Chat API (POST /chat)
                              ▼
                         ┌─────────┐
              ┌─────────►│  Lead   │◄──────────┐
              │          └────┬────┘            │
              │               │                 │
     steerLead events    flightdeck_send    steerLead events
     (task_failure,      (MCP tool)         (spec_completed,
      escalation,            │               budget_warning)
      budget_warning)        │                  │
              │               ▼                 │
              │          ┌─────────┐            │
              │          │ Director │            │
              │          └────┬────┘     ┌──────┴──────┐
              │               │          │ Orchestrator │
              │          plan tasks      │  (tick loop) │
              │               │          └──────┬──────┘
              │               ▼                 │
              │          ┌─────────┐            │ auto-assign
              └──────────│ Workers │◄───────────┘
                         └────┬────┘
                              │ task_submit
                              ▼
                         ┌──────────┐
                         │ Reviewer │
                         └──────────┘
```

### 2.1 User → Lead

| Path | Code |
|---|---|
| User sends message via chat API | `LeadManager.steerLead({ type: 'user_message', message })` |
| Message format | Timestamped header + source + content (`LeadManager.buildSteer`) |
| Task comments | `steerLead({ type: 'task_comment', taskId, message })` |

### 2.2 Lead → Director

| Path | Code |
|---|---|
| Lead calls `flightdeck_send` MCP tool with `to: <director_id>` | `mcp/server.ts:619` → `client.sendMessage()` |
| Orchestrator triggers | `LeadManager.steerDirectorEvent(event)` → `steerDirector(message)` |
| Event types | `DirectorEvent`: critical_task_completed, task_failed, worker_escalation, spec_milestone, plan_validation_request, file_conflict |

### 2.3 Orchestrator → Lead

The Orchestrator steers the Lead on significant events (NOT for normal completions):

| Event | Trigger | Code path |
|---|---|---|
| `task_failure` | Task failed after max retries | `Orchestrator.detectStalls` → `leadManager.steerLead()` |
| `escalation` | Worker escalates | `Orchestrator.handleEffect(escalate)` → `leadManager.steerLead()` |
| `spec_completed` | All tasks in spec done | `Orchestrator.checkSpecCompletions()` → `leadManager.steerLead()` |
| `budget_warning` | Cost exceeds threshold | `Orchestrator.checkBudget()` → `leadManager.steerLead()` |
| `spec_changed` | Spec file modified | `Orchestrator.checkSpecChanges()` → `leadManager.steerLead()` |
| `worker_recovery` | Orphaned tasks recovered on startup | `leadManager.steerLead()` |

### 2.4 Orchestrator → Director

| Event | Trigger | Code path |
|---|---|---|
| `critical_task_completed` | Task with dependents completes | `Orchestrator.notifyDirectorIfNeeded('completed')` |
| `task_failed` | Task fails after retries exhausted | `Orchestrator.notifyDirectorIfNeeded('failed')` |
| `worker_escalation` | Worker escalates | `Orchestrator.notifyDirectorIfNeeded('escalated')` |
| `spec_milestone` | 50%/75% of spec tasks done | `Orchestrator.checkSpecMilestone()` |
| `file_conflict` | Merge conflict detected | `store.on('merge-conflict')` → `leadManager.steerDirectorEvent()` |

### 2.5 Orchestrator → Worker

| Path | Code |
|---|---|
| Task assignment | `agentManager.sendToAgent(agentId, contextMessage)` with task details (`Orchestrator.autoAssignReadyTasks`) |
| Stall reminder | `adapter.steer(sessionId, { content: "submit or escalate" })` (`Orchestrator.detectStalls`) |
| Auto-spawn + assign | `agentManager.spawnAgent({ role, taskContext })` → `dag.claimTask()` |

### 2.6 Worker → Orchestrator

All via MCP tools → HTTP API:

| Action | MCP Tool | Effect |
|---|---|---|
| Submit work | `flightdeck_task_submit` (`mcp/server.ts:255`) | running → in_review (or done if needsReview=false) |
| Report failure | `flightdeck_task_fail` (`mcp/server.ts:269`) | running → failed |
| Escalate | `flightdeck_escalate` (`mcp/server.ts:948`) | Triggers escalation event → Lead + Director notified |

### 2.7 Reviewer → Task

| Action | MCP Tool | Effect |
|---|---|---|
| Approve | `flightdeck_review_submit` verdict=approve (`mcp/server.ts:361`) | in_review → done |
| Request changes | `flightdeck_review_submit` verdict=request_changes | in_review → running (worker re-steered) |

### 2.8 Agent → Agent (Peer Communication)

| Tool | Purpose | Code |
|---|---|---|
| `flightdeck_send` | DMs (to agent), task comments (taskId), channel posts | `mcp/server.ts:619` |
| `flightdeck_discuss` | Create group discussion channel with invitees | `mcp/server.ts:961` |
| `flightdeck_read` | Read DM inbox or channel messages | `mcp/server.ts:641` |

---

## 3. Task State Transitions

### State Machine Diagram

```
                                    ┌──────────┐
                                    │ planned  │
                                    └────┬─────┘
                             ┌───────────┼───────────┐
                             ▼           ▼           ▼
                        [pending]   [cancelled]  [skipped]
                             │                       │
                      ┌──────┼──────┐                │
                      ▼      ▼      ▼                │
                  [ready] [blocked] [skipped]         │
                      │      │                       │
               ┌──────┤      │                       │
               ▼      ▼      │                       │
           [running] [gated] │                       │
               │      │      │                       │
        ┌──────┼──────┤      │                       │
        ▼      ▼      ▼      │                       │
  [in_review] [failed] [paused]                      │
        │      │       │                             │
        ▼      ▼       ▼                             │
     [done]  [ready] [running]                       │
        │                                            │
        └────────────────────────────────────────────┘
                        (reopen)
```

### Transition Table

| From | To | Who triggers | How | Side effects |
|---|---|---|---|---|
| **planned → pending** | Lead | `flightdeck_plan_review` verdict=approve (`mcp/server.ts:976`) | Transitions all planned tasks (optionally filtered by specId) to pending |
| **planned → cancelled** | Lead | `flightdeck_plan_review` verdict=reject | Planned tasks cancelled; `clear_assignment`, `block_dependents` |
| **planned → skipped** | Director | `flightdeck_task_skip` or plan adjustment | `resolve_dependents` (treated as "done" for dep resolution) |
| **pending → ready** | Orchestrator | `promoteReadyTasks()` — all deps done/skipped/cancelled (`Orchestrator.ts:promoteReadyTasks`) | Task becomes eligible for assignment |
| **pending → blocked** | Orchestrator | `promoteReadyTasks()` — deps not yet resolved (stays pending; explicit block via code) | Waits for dep completion |
| **pending → skipped** | Director/Lead | Direct state update | `resolve_dependents` |
| **pending → cancelled** | Lead/Director | Direct state update | `clear_assignment`, `block_dependents` |
| **ready → running** | Orchestrator | `autoAssignReadyTasks()` → `dag.claimTask()` (`Orchestrator.ts:autoAssignReadyTasks`) | Worker spawned/assigned, receives task context message |
| **ready → gated** | Orchestrator | `governance.shouldGateTaskStart()` returns true (`Orchestrator.ts:autoAssignReadyTasks`) | Task awaits human approval (supervised/collaborative modes) |
| **ready → paused** | Director | `flightdeck_task_pause` MCP tool | — |
| **ready → cancelled** | Lead/Director | Direct state update | `clear_assignment`, `block_dependents` |
| **gated → running** | Lead/User | Governance approval (via API) | Worker assigned |
| **gated → ready** | System | Governance config change / gate removed | Re-enters assignment pool |
| **running → in_review** | Worker | `flightdeck_task_submit` (`mcp/server.ts:255`) | `spawn_reviewer` effect → reviewer agent spawned |
| **running → done** | Worker | `flightdeck_task_submit` with review disabled | `resolve_dependents`, `set_timestamp` |
| **running → failed** | Worker / Orchestrator | `flightdeck_task_fail` or session ended without submit (stall detection) | `escalate`, `block_dependents`, `clear_assignment`; Lead notified |
| **running → paused** | Director | `flightdeck_task_pause` (conflict resolution) | Worker suspended |
| **running → blocked** | System | External dependency blocks progress | — |
| **running → cancelled** | Lead | Direct cancellation | `clear_assignment`, `block_dependents` |
| **in_review → done** | Reviewer | `flightdeck_review_submit` verdict=approve (`mcp/server.ts:361`) | `resolve_dependents`, `set_timestamp`; webhook notification |
| **in_review → running** | Reviewer | `flightdeck_review_submit` verdict=request_changes | Worker re-steered with review feedback |
| **in_review → failed** | System | Reviewer session crashes | `escalate`, `block_dependents`, `clear_assignment` |
| **failed → ready** | Orchestrator | Auto-retry if `retries < maxRetries` (`Orchestrator.ts:detectStalls`) | `clear_assignment`, `unblock_dependents`; retry context appended to task description |
| **blocked → ready** | Orchestrator | `promoteReadyTasks()` — blocking deps now resolved | Re-enters assignment pool |
| **blocked → pending** | System | Dependency state changed | — |
| **blocked → cancelled** | Lead/Director | Direct cancellation | `clear_assignment`, `block_dependents` |
| **paused → running** | Director | `flightdeck_task_resume` (`mcp/server.ts:312`) | Worker re-steered |
| **paused → ready** | Director | Resume without specific worker | Re-enters assignment pool |
| **paused → cancelled** | Lead | Direct cancellation | `clear_assignment`, `block_dependents` |
| **done → ready** | Lead | `flightdeck_task_reopen` (`mcp/server.ts:391`) | `clear_assignment`; task re-enters the pipeline |
| **skipped → pending** | Lead/Director | Un-skip a task | Re-evaluated by Orchestrator |

### Side Effects Reference

Defined in `core/types.ts:transition()`:

| Effect | Triggered on | Description |
|---|---|---|
| `spawn_reviewer` | running → in_review | Spawns a reviewer agent for the task |
| `resolve_dependents` | → done, → skipped | Unblocks downstream tasks |
| `block_dependents` | → failed, → cancelled | Blocks downstream tasks |
| `unblock_dependents` | failed → ready (retry) | Reverses dependent blocking |
| `clear_assignment` | → failed, → cancelled, done → ready, failed → ready | Removes agent assignment |
| `set_timestamp` | → done | Records completion timestamp |
| `escalate` | → failed | Notifies Lead about failure |

---

## 4. Governance Modes

Governance controls how much autonomy agents have. Configured per-project via `config.governance`.

Source: `governance/GovernanceEngine.ts`

### 4.1 Autonomous Mode

> Maximum agent autonomy. Agents auto-assign, auto-approve plans, and self-manage.

| Behavior | Detail |
|---|---|
| **Task gating** | `shouldGateTaskStart()` → `false` — no gating, ready → running directly |
| **Plan approval** | `shouldAutoApprovePlan()` → `true` — Lead auto-approves plans |
| **Approval gates** | Only `public_api_change` and `security_sensitive` require human approval |
| **Escalation** | After 5 consecutive failures; cost threshold $50/day |
| **Stale timeout** | 4 hours |
| **Reporting** | Daily cadence |
| **On completion** | `explore` — Scout agent analyzes for further improvements |

### 4.2 Supervised Mode

> Human approves task starts, but reviews are autonomous.

| Behavior | Detail |
|---|---|
| **Task gating** | `shouldGateTaskStart()` → `true` for all roles except `reviewer` — ready → gated → needs human approval |
| **Plan approval** | `shouldAutoApprovePlan()` → `false` — user must approve plans |
| **Approval gates** | All action types gated: implementation_start, architecture_change, dependency_upgrade, public_api_change, security_sensitive; cost_exceeds blocked at $5 |
| **Escalation** | After 1 failure; cost threshold $5/day |
| **Stale timeout** | 30 minutes |
| **Reporting** | Per-task cadence |
| **On completion** | `ask` — awaits user decision |

### 4.3 Collaborative Mode

> Everything needs human approval. Maximum oversight.

| Behavior | Detail |
|---|---|
| **Task gating** | `shouldGateTaskStart()` → `true` for ALL roles (including reviewers) — every task start needs approval |
| **Plan approval** | `shouldAutoApprovePlan()` → `false` |
| **Approval gates** | implementation_start uses `propose_and_wait`; architecture_change, dependency_upgrade, public_api_change all `gate_human` |
| **Escalation** | After 2 failures; cost threshold $10/day |
| **Stale timeout** | 1 hour |
| **Reporting** | Per-milestone cadence |
| **On completion** | `ask` — awaits user decision |

### Governance Comparison Matrix

```
                    autonomous    supervised    collaborative
                    ──────────    ──────────    ─────────────
Task gating:        none          all except    all roles
                                  reviewer
Plan approval:      auto          manual        manual
Cost threshold:     $50/day       $5/day        $10/day
Failure escalate:   5 failures    1 failure     2 failures
Stale timeout:      4h            30m           1h
On completion:      explore       ask           ask
Reporting:          daily         per-task      per-milestone
```

---

## Appendix: Key Source Files

| File | Purpose |
|---|---|
| `core/types.ts` | Task states, agent statuses, VALID_TRANSITIONS, transition() with side effects |
| `lead/LeadManager.ts` | Lead + Director spawn, resume, steer, heartbeat |
| `orchestrator/Orchestrator.ts` | Tick loop: promote, assign, stall detection, budget, spec completions |
| `governance/GovernanceEngine.ts` | Governance profiles, gating, cost thresholds, escalation rules |
| `mcp/server.ts` | MCP tool definitions (all agent-callable tools) |
| `verification/ReviewFlow.ts` | Review process: spawn reviewer, handle verdict |
| `agents/AgentManager.ts` | Agent spawn, steer, session management |
| `dag/TaskDAG.ts` | Task graph, claimTask, failTask, retryTask |
| `acp/SessionStore.ts` | Session persistence for Lead/Director transcripts |


## Role Responsibilities

| Role | Responsibilities | Does NOT do | MCP Tools |
|------|-----------------|-------------|-----------|
| **Lead** | User communication, high-level decisions, plan approval/rejection, escalation handling, status reporting | Task breakdown, agent spawning, code implementation, code review | plan_review, task_add (trivial only), task_cancel, task_skip, send, read, search, status, spec_create, role_list |
| **Director** | Task breakdown (declare_tasks), dependency management, conflict resolution, agent spawning, task pause/resume/retry | User communication, architecture decisions, code implementation | declare_tasks, agent_spawn, task_pause, task_resume, task_skip, task_fail, task_retry, task_complete, send, search |
| **Orchestrator** | Auto-assign ready tasks to idle workers, auto-spawn workers (up to maxConcurrentWorkers), auto-spawn reviewers, promote blocked→ready (event-driven), stall detection, budget monitoring | No LLM calls — pure code logic | N/A (code, not an agent) |
| **Worker** | Code implementation, testing, task_submit, escalate when blocked | Task planning, agent management, code review | task_list, task_claim, task_submit, task_fail, escalate, file_lock, search, memory_write |
| **Reviewer** | Code review, approve/request_changes via review_submit | Implementation, task planning | task_list, task_get, task_complete, task_fail, review_submit, search |
| **Scout** | Read-only codebase analysis, suggest improvements | Write files, create tasks, modify anything | task_list, spec_list, search, decision_list, learning_search (all read-only) |
| **QA Tester** | End-to-end testing, bug reporting, verify fixes | Code implementation, architecture decisions | task_claim, task_submit, task_fail, search, memory_write |
| **Tech Writer** | Documentation, README, API guides, examples | Code implementation, testing | task_claim, task_submit, task_fail, search, memory_write, spec_list |
| **Product Thinker** | UX perspective, feature evaluation, scope decisions | Code implementation, task management | task_list, task_add, send, discuss, search, memory_write |

### Key Principle: Separation of Concerns

```
User ↔ Lead (decisions) → Director (planning) → Orchestrator (execution) → Workers (implementation) → Reviewers (quality)
```

- **Lead** conserves tokens — only speaks when needed (user messages, approvals, escalations)
- **Director** owns the execution plan — breaks down, sequences, resolves conflicts
- **Orchestrator** is pure code — no token cost, handles mechanical assignment/spawning
- **Workers** are disposable — spawn, implement, submit, done
- **Reviewers** are pooled — reused across tasks to reduce spawn overhead
