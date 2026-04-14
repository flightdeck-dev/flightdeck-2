import type { AgentId, AgentRole, Agent, IsolationStrategy } from '@flightdeck-ai/shared';
import { agentId as makeAgentId } from '@flightdeck-ai/shared';
import type { SqliteStore } from '../storage/SqliteStore.js';
import type { RoleRegistry } from '../roles/RoleRegistry.js';
import type { AgentAdapter, AgentMetadata } from './AgentAdapter.js';
import type { SkillManager } from '../skills/SkillManager.js';
import { type WorktreeManager } from './WorktreeManager.js';
import { DirectoryManager } from './DirectoryManager.js';
import type { MessageLog } from '../storage/MessageLog.js';
import { writeFileSync } from 'node:fs';

export interface SpawnAgentOptions {
  role: AgentRole;
  model?: string;
  task?: string;
  cwd: string;
  projectName?: string;
  runtime?: string;
  taskContext?: string;
  taskId?: string;
  isolation?: IsolationStrategy;
  mergeStrategy?: 'auto' | 'squash' | 'pr';
}

/**
 * Build a system prompt for a spawned agent based on its role and context.
 */
export function buildSystemPrompt(opts: {
  roleName: string;
  roleInstructions: string;
  agentId: string;
  projectName: string;
  permissions: Record<string, boolean>;
}): string {
  const permittedTools = Object.entries(opts.permissions)
    .filter(([, v]) => v)
    .map(([k]) => `flightdeck_${k}`);

  return `You are a ${opts.roleName} agent in Flightdeck project "${opts.projectName}".
Your agent ID is: ${opts.agentId}

${opts.roleInstructions}

## Available Flightdeck Tools
Based on your role permissions, you can use:
${permittedTools.map(t => `- ${t}`).join('\n')}

## Rules
- Always pass your agentId when calling Flightdeck tools
- Report task completion via flightdeck_task_submit
- If stuck, use flightdeck_escalate
- After completing a task, check flightdeck_task_list for more ready tasks and claim one with flightdeck_task_claim. Keep working until no tasks are available.
`;
}

/**
 * Central manager bridging MCP tools → AgentAdapter (ACP/PTY).
 * Handles spawn, terminate, interrupt, restart — keeping SQLite in sync.
 */
export class AgentManager {
  /** sessionId → agentId mapping for active agents */
  private sessionToAgent = new Map<string, AgentId>();
  /** agentId → sessionId mapping */
  private agentToSession = new Map<AgentId, string>();
  /** agentId → worktree taskId for cleanup */
  private agentWorktrees = new Map<AgentId, { taskId: string; mergeStrategy: 'auto' | 'squash' | 'pr' }>();
  /** agentId → directory taskId for cleanup */
  private agentWorkdirs = new Map<AgentId, string>();
  private adapter: AgentAdapter;
  private worktreeManager: WorktreeManager | null = null;
  private directoryManager: DirectoryManager | null = null;
  private messageLog: MessageLog | null = null;

  private skillManager: SkillManager | null;

  constructor(
    adapter: AgentAdapter,
    private store: SqliteStore,
    private roleRegistry: RoleRegistry,
    private projectName: string,
    skillManager?: SkillManager,
  ) {
    this.adapter = adapter;
    this.skillManager = skillManager ?? null;
  }

  /**
   * Set the WorktreeManager for git worktree isolation.
   */
  setWorktreeManager(wm: WorktreeManager): void {
    this.worktreeManager = wm;
  }

  /**
   * Set the DirectoryManager for directory-based isolation.
   */
  setDirectoryManager(dm: DirectoryManager): void {
    this.directoryManager = dm;
  }

  /**
   * Set the MessageLog for unread DM delivery on agent spawn.
   */
  setMessageLog(ml: MessageLog): void {
    this.messageLog = ml;
  }

  async spawnAgent(opts: SpawnAgentOptions): Promise<Agent> {
    // 1. Get role from registry
    const role = this.roleRegistry.get(opts.role);
    const roleName = role?.name ?? opts.role;
    const roleInstructions = role?.instructions ?? `You are a ${opts.role} agent. Complete your assigned tasks.`;
    const permissions = role?.permissions ?? {};

    // 2. Register in SQLite
    const newId = makeAgentId(opts.role, Date.now().toString());
    const agent: Agent = {
      id: newId,
      role: opts.role,
      runtime: this.adapter.runtime,
      runtimeName: opts.runtime ?? null,
      acpSessionId: null,
      status: 'idle',
      currentSpecId: null,
      costAccumulated: 0,
      lastHeartbeat: null,
    };
    this.store.insertAgent(agent);

    // 3. Build system prompt
    const systemPrompt = buildSystemPrompt({
      roleName,
      roleInstructions,
      agentId: newId,
      projectName: this.projectName,
      permissions,
    });

    // 4. Set up isolation if configured
    let effectiveCwd = opts.cwd;
    if (opts.isolation === 'git_worktree' && opts.taskId && this.worktreeManager) {
      try {
        if (this.worktreeManager.isGitRepo()) {
          const wt = this.worktreeManager.create(opts.taskId);
          effectiveCwd = wt.path;
          this.agentWorktrees.set(newId, {
            taskId: opts.taskId,
            mergeStrategy: opts.mergeStrategy ?? 'auto',
          });
        }
      } catch {
        // Worktree creation failed — fall back to shared cwd
        // Log but don't block agent spawn
      }
    } else if (opts.isolation === 'directory' && opts.taskId) {
      try {
        const dm = this.directoryManager ?? new DirectoryManager(opts.cwd);
        const wd = dm.create(opts.taskId);
        effectiveCwd = wd.path;
        this.agentWorkdirs.set(newId, opts.taskId);
        if (!this.directoryManager) this.directoryManager = dm;
      } catch {
        // Directory creation failed — fall back to shared cwd
      }
    }

    // 5. Write skill-based AGENTS.md and .mcp.json if SkillManager available
    if (this.skillManager) {
      try {
        const agentsMd = this.skillManager.generateAgentsMd(opts.role, opts.taskContext);
        writeFileSync(`${effectiveCwd}/AGENTS.md`, agentsMd);
        const mcpJson = this.skillManager.generateMcpJson(opts.role);
        writeFileSync(`${effectiveCwd}/.mcp.json`, mcpJson);
      } catch { /* best effort — skills are optional */ }
    }

    // 6. Spawn via adapter
    // For Claude Code runtime, inject role instructions via _meta.systemPrompt (append mode)
    // This provides stronger guidance than AGENTS.md alone
    const isClaudeCode = opts.runtime === 'claude' || opts.runtime === 'claude-code';
    try {
      const meta = await this.adapter.spawn({
        role: opts.role,
        cwd: effectiveCwd,
        model: opts.model,
        runtime: opts.runtime,
        projectName: opts.projectName ?? this.projectName,
        systemPrompt,
        ...(isClaudeCode ? { systemPromptMeta: { append: roleInstructions } } : {}),
      });

      // 6a. Update SQLite with session ID
      this.store.updateAgentAcpSession(newId, meta.sessionId);
      this.store.updateAgentStatus(newId, 'busy');
      agent.acpSessionId = meta.sessionId;
      agent.status = 'busy';

      // Track mappings
      this.sessionToAgent.set(meta.sessionId, newId);
      this.agentToSession.set(newId, meta.sessionId);

      // 7. Deliver any unread DMs to the newly spawned agent
      if (this.messageLog) {
        const unread = this.messageLog.getUnreadDMs(newId);
        if (unread.length > 0) {
          const dmSummary = unread.map(m => `[DM from ${m.from}]: ${m.content}`).join('\n');
          this.messageLog.markRead(newId);
          // Deliver async — don't block spawn on DM delivery
          this.adapter.steer(meta.sessionId, {
            content: `You have ${unread.length} unread message(s):\n\n${dmSummary}`,
            urgent: false,
          }).catch(() => { /* best effort — agent will see them via msg_inbox */ });
        }
      }

      return agent;
    } catch (err) {
      // Spawn failed — mark agent as errored
      this.store.updateAgentStatus(newId, 'errored');
      agent.status = 'errored';
      throw err;
    }
  }

  async terminateAgent(agentId: AgentId): Promise<void> {
    const agent = this.store.getAgent(agentId);
    if (!agent) throw new Error(`Agent not found: ${agentId}`);

    const sessionId = this.agentToSession.get(agentId) ?? agent.acpSessionId;
    if (sessionId) {
      try {
        await this.adapter.kill(sessionId);
      } catch {
        // Best effort — process may already be dead
      }
      this.sessionToAgent.delete(sessionId);
    }
    this.agentToSession.delete(agentId);

    // Clean up worktree or workdir if one was created
    await this.cleanupWorktree(agentId);
    this.cleanupWorkdir(agentId);

    this.store.updateAgentStatus(agentId, 'offline');
    this.store.updateAgentAcpSession(agentId, null);
  }

  /**
   * Merge and clean up a worktree for an agent.
   */
  async cleanupWorktree(agentId: AgentId, merge = true): Promise<void> {
    const wtInfo = this.agentWorktrees.get(agentId);
    if (!wtInfo || !this.worktreeManager) return;

    try {
      if (merge) {
        this.worktreeManager.merge(wtInfo.taskId, wtInfo.mergeStrategy);
      }
    } catch {
      // Merge failed — still clean up the worktree
    }

    try {
      this.worktreeManager.remove(wtInfo.taskId);
    } catch { /* best effort */ }

    this.agentWorktrees.delete(agentId);
  }

  /**
   * Copy results back and clean up a directory workdir for an agent.
   */
  cleanupWorkdir(agentId: AgentId, copyBack = true): void {
    const taskId = this.agentWorkdirs.get(agentId);
    if (!taskId || !this.directoryManager) return;

    try {
      if (copyBack) {
        this.directoryManager.copyBack(taskId);
      }
    } catch { /* copy failed — still clean up */ }

    try {
      this.directoryManager.remove(taskId);
    } catch { /* best effort */ }

    this.agentWorkdirs.delete(agentId);
  }

  async interruptAgent(agentId: AgentId, message: string): Promise<void> {
    const agent = this.store.getAgent(agentId);
    if (!agent) throw new Error(`Agent not found: ${agentId}`);

    // Suspended agents cannot be steered — they need to be resumed first
    if (agent.status === 'suspended') {
      throw new Error(`Agent ${agentId} is suspended. Resume it before steering.`);
    }

    const sessionId = this.agentToSession.get(agentId) ?? agent.acpSessionId;
    if (!sessionId) throw new Error(`No active session for agent: ${agentId}`);

    await this.adapter.steer(sessionId, { content: message, urgent: true });
  }

  /** Send a non-urgent message to an agent (queued, delivered after current turn) */
  async sendToAgent(agentId: AgentId, message: string): Promise<void> {
    const agent = this.store.getAgent(agentId);
    if (!agent) throw new Error(`Agent not found: ${agentId}`);
    if (agent.status === 'suspended') {
      throw new Error(`Agent ${agentId} is suspended. Resume it before sending.`);
    }
    const sessionId = this.agentToSession.get(agentId) ?? agent.acpSessionId;
    if (!sessionId) throw new Error(`No active session for agent: ${agentId}`);
    await this.adapter.steer(sessionId, { content: message, urgent: false });
  }

  async restartAgent(agentId: AgentId): Promise<Agent> {
    const agent = this.store.getAgent(agentId);
    if (!agent) throw new Error(`Agent not found: ${agentId}`);

    // Kill existing session
    const sessionId = this.agentToSession.get(agentId) ?? agent.acpSessionId;
    if (sessionId) {
      try {
        await this.adapter.kill(sessionId);
      } catch { /* best effort */ }
      this.sessionToAgent.delete(sessionId);
    }
    this.agentToSession.delete(agentId);

    // Re-spawn with same role/config
    const role = this.roleRegistry.get(agent.role);
    const systemPrompt = buildSystemPrompt({
      roleName: role?.name ?? agent.role,
      roleInstructions: role?.instructions ?? `You are a ${agent.role} agent.`,
      agentId,
      projectName: this.projectName,
      permissions: role?.permissions ?? {},
    });

    const meta = await this.adapter.spawn({
      role: agent.role,
      cwd: process.cwd(),
      model: undefined,
      systemPrompt,
    });

    this.store.updateAgentAcpSession(agentId, meta.sessionId);
    this.store.updateAgentStatus(agentId, 'busy');
    this.sessionToAgent.set(meta.sessionId, agentId);
    this.agentToSession.set(agentId, meta.sessionId);

    // Deliver any unread DMs to the restarted agent
    if (this.messageLog) {
      const unread = this.messageLog.getUnreadDMs(agentId);
      if (unread.length > 0) {
        const dmSummary = unread.map(m => `[DM from ${m.from}]: ${m.content}`).join('\n');
        this.messageLog.markRead(agentId);
        this.adapter.steer(meta.sessionId, {
          content: `You have ${unread.length} unread message(s):\n\n${dmSummary}`,
          urgent: false,
        }).catch(() => { /* best effort */ });
      }
    }

    return { ...agent, acpSessionId: meta.sessionId, status: 'busy' };
  }

  getAgent(agentId: AgentId): Agent | null {
    return this.store.getAgent(agentId);
  }

  listAgents(includeRetired = false): Agent[] {
    return this.store.listAgents(includeRetired);
  }

  async hibernateAgent(agentId: AgentId): Promise<void> {
    const agent = this.store.getAgent(agentId);
    if (!agent) throw new Error(`Agent not found: ${agentId}`);

    // Save session info for potential resume
    const sessionId = this.agentToSession.get(agentId) ?? agent.acpSessionId;

    // Kill the process (but preserve the session ID in DB for resume)
    if (sessionId) {
      try { await this.adapter.kill(sessionId); } catch { /* best effort */ }
      this.sessionToAgent.delete(sessionId);
    }
    this.agentToSession.delete(agentId);

    // Update DB: keep acpSessionId so we can resume later
    this.store.updateAgentStatus(agentId, 'hibernated');
    console.error(`[hibernate] Agent ${agentId} hibernated (session preserved: ${sessionId ?? 'none'})`);
  }

  async wakeAgent(agentId: AgentId): Promise<Agent> {
    const agent = this.store.getAgent(agentId);
    if (!agent) throw new Error(`Agent not found: ${agentId}`);
    if (agent.status !== 'hibernated') throw new Error(`Agent ${agentId} is not hibernated (status: ${agent.status})`);

    const savedSessionId = agent.acpSessionId;
    if (!savedSessionId) {
      // No saved session — can't resume, retire instead
      this.store.updateAgentStatus(agentId, 'retired');
      this.store.updateAgentAcpSession(agentId, null);
      throw new Error(`No saved session for hibernated agent ${agentId}. Agent has been retired.`);
    }

    try {
      // Try to resume the ACP session
      const meta = await this.adapter.resumeSession({
        previousSessionId: savedSessionId,
        cwd: process.cwd(),
        role: agent.role,
      });

      // Success — update mappings
      this.store.updateAgentAcpSession(agentId, meta.sessionId);
      this.store.updateAgentStatus(agentId, 'busy');
      this.sessionToAgent.set(meta.sessionId, agentId);
      this.agentToSession.set(agentId, meta.sessionId);

      console.error(`[wake] Agent ${agentId} resumed (session: ${meta.sessionId})`);
      return { ...agent, acpSessionId: meta.sessionId, status: 'busy' };
    } catch (err) {
      // Resume failed — retire the agent, don't retry
      console.error(`[wake] Resume failed for ${agentId}: ${(err as Error).message}. Retiring.`);
      this.store.updateAgentStatus(agentId, 'retired');
      this.store.updateAgentAcpSession(agentId, null);
      throw new Error(`Failed to resume agent ${agentId}: ${(err as Error).message}. Agent has been retired.`);
    }
  }

  async retireAgent(agentId: AgentId): Promise<void> {
    const agent = this.store.getAgent(agentId);
    if (!agent) throw new Error(`Agent not found: ${agentId}`);

    // Kill process if alive
    const sessionId = this.agentToSession.get(agentId) ?? agent.acpSessionId;
    if (sessionId && agent.status !== 'hibernated' && agent.status !== 'retired') {
      try { await this.adapter.kill(sessionId); } catch { /* best effort */ }
      this.sessionToAgent.delete(sessionId);
    }
    this.agentToSession.delete(agentId);

    // Clean up worktree/workdir
    await this.cleanupWorktree(agentId);
    this.cleanupWorkdir(agentId);

    this.store.updateAgentStatus(agentId, 'retired');
    this.store.updateAgentAcpSession(agentId, null);
    console.error(`[retire] Agent ${agentId} retired`);
  }

  async getAgentMetadata(agentId: AgentId): Promise<AgentMetadata | null> {
    const sessionId = this.agentToSession.get(agentId);
    if (!sessionId) return null;
    return this.adapter.getMetadata(sessionId);
  }
}
