# Flightdeck 2.0 SPEC Review Notes

**Reviewed by:** Claw
**Date:** 2026-04-11 (after Justin went to sleep)

---

## Issues Found

### 1. FR numbering is out of order
FR-021 appears between FR-013 and FR-014. Should be renumbered sequentially.
**Fix:** Renumber in next SPEC update.

### 2. Scenario 2 (Collaborative) doesn't mention lead agent
The collaborative flow says "Flightdeck proposes a plan" and "user tweaks the plan" — but who generates the plan? This should explicitly mention: user → lead → planner → plan → user approves.
**Fix:** Update scenario to show lead as intermediary.

### 3. "Planner agent on-demand" vs "who generates the initial plan"
FR-019 says planner is on-demand. But Scenario 1 says "Flightdeck generates a plan → task DAG". Flightdeck can't generate plans (it's code, not LLM). Should say: Flightdeck spawns planner → planner generates plan.
**Fix:** Clarify in scenarios.

### 4. ACP adapter is listed but not designed
External interfaces table lists ACP adapter, but there's no design section for how Flightdeck uses ACP to control agents. Needs:
- What ACP operations does Flightdeck use? (spawn, steer, kill, heartbeat)
- How does Flightdeck discover available ACP-compatible agents?
- How does the steer message format look for different interrupt types?
**Fix:** Add ACP integration design section.

### 5. Agent assignment strategy is an open question but used in design
The design says "Auto-assign workers by role + priority" but Open Question 2 asks "how to assign agents?" — this should be resolved, at least for the default.
**Suggestion:** Default to role-matching + priority order. Add capability-matching later.

### 6. Lead agent has no system prompt design
We defined lead's role but not how it's set up. Lead needs:
- System prompt explaining its role (user proxy, judgment only, no scheduling)
- MCP tools it should use
- Examples of good vs bad lead behavior
**Fix:** Add lead agent prompt design section.

### 7. Compaction uses "fast model" — but NFR-001 says zero external deps
Compaction summary_model: fast implies an LLM call. This is fine (it's an agent operation, not a library dependency) but should be explicit: compaction is done by spawning a short-lived agent, not by Flightdeck code.
**Fix:** Clarify compaction is agent-driven, not code-driven.

### 8. Group chat: who starts it?
The design says agents can create group chats via `flightdeck_discuss()`. But should any worker be able to start a group chat? Or only lead/planner?
**Suggestion:** Any agent can request a discussion, but governance can gate it (to prevent token waste).

### 9. Stall detection and review are in Success Criteria section
Stall detection, compaction, and hierarchical DAGs are under "Success Criteria" heading but they're design sections, not criteria.
**Fix:** Move them to Architecture section.

### 10. Missing: how does Flightdeck know which models are available?
Verification requires "different model from worker." But how does Flightdeck know what models it can use? Needs a model registry or config.
**Fix:** Add model configuration to governance.yaml.

---

## Borrowing from OpenClaw — Analysis for Justin

### What makes OpenClaw's memory system great

1. **Plain markdown files** — MEMORY.md, memory/YYYY-MM-DD.md, USER.md, SOUL.md, TOOLS.md
   - Human-readable: you can `cat MEMORY.md` and understand everything
   - Human-writable: you can edit any file and the agent picks it up
   - Git-friendly: all memory is diffable, committable, reviewable
   - No proprietary format, no binary database for memory

2. **Workspace context injection** — key files are injected into the system prompt automatically
   - Agent always sees AGENTS.md, SOUL.md, USER.md, MEMORY.md at session start
   - No need to "remember to load context" — it's automatic
   - Truncated if too big, but always present

3. **Semantic memory search** — `memory_search` finds relevant notes even when wording differs
   - Hybrid: vector similarity + keyword matching
   - Agent doesn't need to remember where it wrote something

4. **Compaction + memory flush** — before compacting conversation, agent is reminded to save important notes to files
   - Context can be lost (compaction summarizes), but memory files persist
   - Belt and suspenders: context in window + memory on disk

5. **Session continuity** — sessions are per-channel, conversation history persists
   - You can pick up where you left off
   - But agent also knows it "wakes up fresh" and reads files for continuity

### How Flightdeck 2.0 can adopt these patterns

**1. Project memory as markdown files (.flightdeck/)**

```
.flightdeck/
├── PROJECT.md          # Project context (like AGENTS.md) — auto-injected to all agents
├── DECISIONS.md        # Decision log in markdown (human-readable summary)
├── memory/
│   ├── YYYY-MM-DD.md   # Daily project diary (what happened today)
│   └── context/
│       ├── auth.md     # Domain knowledge: auth system decisions
│       └── api.md      # Domain knowledge: API design decisions
├── governance.yaml     # Governance config
├── flightdeck.db       # SQLite (structured state — tasks, agents, messages)
└── specs/
    └── *.md            # Specs in markdown
```

**Dual storage:**
- **Markdown** for context that agents need to read (human-readable, injectable, git-friendly)
- **SQLite** for structured state that Flightdeck daemon needs to query (tasks, status, deps)

Agents always get PROJECT.md + relevant memory/*.md injected. They read markdown, not SQL.

**2. Auto-injection into agent context**

When Flightdeck spawns/steers an agent via ACP, it injects:
```
System prompt addition:
- PROJECT.md (always)
- Relevant spec section (for this task)
- Recent decisions (from DECISIONS.md) 
- Task-specific context (from memory/context/*.md)
- Compacted milestone summaries
```

Agent doesn't need to "remember to read Flightdeck state." It's already in their context.

**3. Agent-maintained memory files**

Workers can write to memory/context/*.md:
```
Agent finishes auth task → appends to memory/context/auth.md:
"## 2026-04-11: OAuth2 Implementation
- Chose PKCE flow (PKCE > implicit, see decision dec-a1b2)
- Used jose library for JWT handling
- Refresh token rotation enabled with 15min TTL
- Test coverage: 85% on auth module"
```

Next agent working on related code gets this injected automatically.

**4. Memory search for agents**

Flightdeck MCP should expose:
```
flightdeck_memory_search(query) → relevant snippets from memory/*.md
flightdeck_memory_write(file, content) → append to a memory file
```

This lets agents search project knowledge even when it's not in their immediate context.

**5. Compaction writes to markdown, not just SQLite**

When tasks are compacted:
- SQLite stores the structured summary (for daemon queries)
- Markdown version goes to memory/milestones/milestone-N.md (for agent reading)

Both representations exist. Daemon reads SQL. Agents read markdown.

### Summary: the OpenClaw philosophy for Flightdeck

**"Everything the agent needs to know should be in readable text files that are automatically injected."**

- SQLite for the daemon (structured queries, state machine)
- Markdown for agents (context injection, human-readable, git-friendly)
- Auto-injection (agents don't need to remember to check Flightdeck)
- Memory search (agents can find relevant context even when not injected)

This also solves Justin's concern about "agent not remembering to use Flightdeck" — if project context is injected into the agent's prompt, the agent can't NOT know about the project. The context is there whether the agent remembers or not.
