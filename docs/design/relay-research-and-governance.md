# AgentWorkforce Relay Research & Governance Framework

> Research notes from 2026-06-15. Analyzing [AgentWorkforce Relay](https://github.com/agentworkforce/relay) (722⭐) and its implications for Flightdeck's governance layer.

## TL;DR

- **Relay** = hosted messaging + router for multi-agent communication
- **Flightdeck** = decision/orchestration layer (governance, task assignment, quality gates)
- **C2A Protocol** = the contract interface between them
- They're complementary, not competitive. Relay does transport; Flightdeck does policy.

## Relay Overview

Hosted messaging infrastructure for agent-to-agent communication. Think "Slack for agents" — channels, DMs, threads, presence.

**What Relay has that Flightdeck doesn't:**
- Hosted message relay/routing
- Agent discovery & presence
- Channel-based communication primitives
- C2A attention management protocol

**What Flightdeck has that Relay doesn't:**
- Hierarchical orchestration (Justin → Claw → Lead → Director → Workers)
- Atomic task checkout with ownership
- Budget hard stops
- Quality gates & review loops
- Governance-as-code (role/policy/flow/resource primitives)

## Message Envelope Format

What an agent receives from Relay:

```typescript
// message object
{
  messageId: string,        // unique, for reply/react
  text: string,
  kind: 'channel' | 'dm' | 'group_dm' | 'thread_reply',
  from: { id, name, handle, type: 'agent' | 'human' },
  to: { id, name },        // DM recipient
  channel: { id, name },   // channel messages only
  threadId: string,         // thread root messageId
  parentId: string,         // direct parent messageId
  mentions: string[],       // @'d agent handles
  attachments, reactions, createdAt
}

// envelope object
{
  from: { id, name, handle, type },
  to: { ... },             // DM
  channel: { id, name },   // channel only
  parent: messageId        // reply parent ref
}
```

### Key Design Decision: Thread Context

**Reply recipients only get the parent's messageId reference — no automatic thread history injection.**

Agents must explicitly pull context:
```ts
const thread = await agent.threads.get(messageId, { limit: 50 });
```

This puts "how much context to load" in the agent's hands. Smart — avoids context bloat.

## C2A Protocol (Computer-to-Agent)

The most interesting piece. Solves: "10 agents in one channel — who sees what, who responds?"

### Directedness (方向性)

| Value | Meaning | Action |
|-------|---------|--------|
| `to_me` | DM or direct @ | Inject into prompt |
| `to_my_role` | Role mention | Notify only |
| `ambient` | No one @'d | Store in mailbox, don't inject |
| `to_other` | Sent to someone else | Store in mailbox |

### Response Policy (回复策略)

| Value | Meaning |
|-------|---------|
| `must_respond` | Required to reply |
| `may_respond` | Reply if substantive help possible |
| `ack_only` | Can only react (emoji) |
| `must_not_respond` | Forbidden from replying |

### Injection Mode (注入方式)

| Value | Meaning |
|-------|---------|
| `immediate` | Urgent interrupt, inject now |
| `buffered` | Normal injection (merge consecutive) |
| `notify` | Send a knock (metadata only), content needs pull |
| `tool_mailbox` | Don't inject; agent uses tool to pull |
| `silent` | Persist only, LLM never sees it |

### Combined Examples

- **DM received** → `to_me` + `must_respond` + `buffered`
- **Channel msg, not @'d** → `ambient` + `must_not_respond` + `tool_mailbox`
- **Thread I'm in, new reply** → `to_my_role` + `may_respond` + `notify`

### MCP Integration

Agents without SDK can participate via MCP tools:
- `message_post` / `message_reply` / `message_dm_send`
- `thread_get` / `message_search` / `message_inbox_check`
- `channel_create` / `channel_join` / `channel_invite`

## Implications for Flightdeck

### C2A as Governance Output

Flightdeck's governance engine can **emit** C2A parameters:

```json
// Director decides "worker-3 must respond, others stay silent"
{ "target": "worker-3", "directedness": "to_me", "policy": "must_respond" }
{ "target": "*", "directedness": "ambient", "policy": "must_not_respond" }
```

**Governance layer decides → C2A params express the decision → Relay enforces delivery.**

### Governance Framework

Six operational modes, each a preset of governance primitives:

| Mode | Style | Autonomy | Use Case |
|------|-------|----------|----------|
| Military | Command chain | Low | Critical/compliant tasks |
| Laboratory | Hypothesis-driven | Medium | Research/exploration |
| Assembly Line | Pipeline stages | Low | Batch processing |
| Marketplace | Bid/auction | High | Resource allocation |
| Advisory | Consultation | Medium | Decision support |
| Autonomous Squad | Self-organizing | High | Creative/complex work |

### Four Governance Primitives

1. **Role** — Who can do what (permissions, capabilities, trust level)
2. **Policy** — Rules that constrain behavior (budget limits, approval gates, escalation triggers)
3. **Flow** — How work moves (task assignment, handoff, review loops)
4. **Resource** — What's available (compute budget, API keys, tool access, time)

### Product Positioning (refreshed 06-15)

> Flightdeck = the **interface layer** between humans and agent teams.
>
> Not just agent-to-agent coordination — it's about how the **trust boundary** between human and agents dynamically adjusts. From full autonomy to step-by-step approval, smooth sliding anywhere on that spectrum.
>
> **Differentiation:** AutoGen/CrewAI only do autonomous. Copilot/Cursor only do human-in-loop. Flightdeck does the whole spectrum.

## Team & Outreach

- **Khaliq Gant** — Oslo, Norway
- **Will Washburn** — Boston, MA
- Potential Twitter DM outreach for collaboration discussion

## References

- Relay repo: <https://github.com/agentworkforce/relay>
- Research file: `~/clawspace/relay-research/context-format.md`
- Related MEMORY.md entries on Flightdeck product positioning
