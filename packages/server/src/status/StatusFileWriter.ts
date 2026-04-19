import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Task, Agent, GovernanceProfile } from '@flightdeck-ai/shared';

export interface StatusData {
  projectName: string;
  governance: GovernanceProfile;
  tasks: Task[];
  agents: Agent[];
  totalCost: number;
}

/**
 * Generates and writes `.flightdeck/status.md` for a project directory.
 * Synchronous — called from event handlers, must be fast.
 */
export class StatusFileWriter {
  private lastWriteTime = 0;
  private pending = false;
  private pendingData: { projectDir: string; data: StatusData } | null = null;

  /** Minimum interval between writes (ms). */
  private debounceMs: number;

  /** Optional state directory to also write status.md to. */
  private stateDir: string | undefined;

  constructor(debounceMs = 1000, stateDir?: string) {
    this.debounceMs = debounceMs;
    this.stateDir = stateDir;
  }

  /**
   * Write status.md with debouncing. If called within debounceMs of the last
   * write, schedules a deferred write instead.
   */
  writeStatus(projectDir: string, data: StatusData): void {
    const now = Date.now();
    const elapsed = now - this.lastWriteTime;

    if (elapsed >= this.debounceMs) {
      this.doWrite(projectDir, data);
    } else {
      // Debounce: store latest data and schedule if not already pending
      this.pendingData = { projectDir, data };
      if (!this.pending) {
        this.pending = true;
        setTimeout(() => {
          this.pending = false;
          if (this.pendingData) {
            this.doWrite(this.pendingData.projectDir, this.pendingData.data);
            this.pendingData = null;
          }
        }, this.debounceMs - elapsed);
      }
    }
  }

  /** Force immediate write (for testing). */
  writeStatusImmediate(projectDir: string, data: StatusData): void {
    this.doWrite(projectDir, data);
  }

  private doWrite(_projectDir: string, data: StatusData): void {
    // Only write to state directory — never write to project cwd
    if (!this.stateDir) {
      this.lastWriteTime = Date.now();
      return;
    }
    const md = StatusFileWriter.generateMarkdown(data);
    mkdirSync(this.stateDir, { recursive: true });
    writeFileSync(join(this.stateDir, 'status.md'), md);
    this.lastWriteTime = Date.now();
  }

  /**
   * Generate the status markdown content.
   */
  static generateMarkdown(data: StatusData): string {
    const { projectName, governance, tasks, agents, totalCost } = data;
    const lines: string[] = [];

    lines.push(`# Project Status: ${projectName}`);
    lines.push('');
    lines.push(`Updated: ${new Date().toISOString()}`);
    lines.push(`Governance: ${governance}`);
    lines.push('');

    // Task stats
    const total = tasks.length;
    const counts: Record<string, number> = {
      ready: 0, running: 0, in_review: 0, done: 0, failed: 0,
      pending: 0, blocked: 0, paused: 0, skipped: 0, cancelled: 0, gated: 0,
    };
    let staleCount = 0;
    for (const t of tasks) {
      counts[t.state] = (counts[t.state] ?? 0) + 1;
      if (t.stale) staleCount++;
    }

    lines.push('## Tasks');
    lines.push(`- Total: ${total}`);
    lines.push(`- Ready: ${counts.ready} | Running: ${counts.running} | In Review: ${counts.in_review} | Done: ${counts.done} | Failed: ${counts.failed}`);
    if (counts.pending > 0) lines.push(`- Pending: ${counts.pending}`);
    if (counts.blocked > 0) lines.push(`- Blocked: ${counts.blocked}`);
    if (counts.paused > 0) lines.push(`- Paused: ${counts.paused}`);
    if (staleCount > 0) lines.push(`- ⚠️ Stale: ${staleCount} (spec changed, may need re-planning)`);
    lines.push('');

    // Epics with progress
    const topLevel = tasks.filter(t => t.parentTaskId === null);
    const byParent = new Map<string, Task[]>();
    for (const t of tasks) {
      if (t.parentTaskId) {
        if (!byParent.has(t.parentTaskId)) byParent.set(t.parentTaskId, []);
        byParent.get(t.parentTaskId)!.push(t);
      }
    }
    const epics = topLevel.filter(t => byParent.has(t.id));
    if (epics.length > 0) {
      lines.push('## Epics');
      for (const epic of epics) {
        const children = byParent.get(epic.id)!;
        const doneCount = children.filter(c => c.state === 'done' || c.state === 'skipped').length;
        lines.push(`- ${epic.title} [${doneCount}/${children.length} done] — ${epic.state}`);
      }
      lines.push('');
    }

    // Active agents
    const activeAgents = agents.filter(a => !['hibernated', 'retired', 'errored'].includes(a.status));
    if (activeAgents.length > 0) {
      lines.push('## Active Agents');
      lines.push('| Agent | Role | Status | Current Task |');
      lines.push('|-------|------|--------|-------------|');
      for (const agent of activeAgents) {
        const currentTask = tasks.find(t => t.assignedAgent === agent.id && t.state === 'running');
        const taskLabel = currentTask ? currentTask.title : '—';
        lines.push(`| ${agent.id} | ${agent.role} | ${agent.status} | ${taskLabel} |`);
      }
      lines.push('');
    }

    // Recent completions
    const doneTasks = tasks
      .filter(t => t.state === 'done')
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, 5);
    if (doneTasks.length > 0) {
      lines.push('## Recent Completions');
      for (const t of doneTasks) {
        const ago = formatTimeAgo(t.updatedAt);
        lines.push(`- ${t.title} — completed ${ago}`);
      }
      lines.push('');
    }

    // Cost
    lines.push('## Cost');
    lines.push(`- Total: $${totalCost.toFixed(2)}`);
    lines.push('');

    return lines.join('\n');
  }
}

function formatTimeAgo(isoTimestamp: string): string {
  const diff = Date.now() - new Date(isoTimestamp).getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
