import type { SqliteStore } from '../storage/SqliteStore.js';
import type { DecisionLog } from '../storage/DecisionLog.js';
import type { SuggestionStore } from '../storage/SuggestionStore.js';

export interface DailyReportOptions {
  since?: string; // ISO date string, defaults to start of today
}

export class DailyReport {
  constructor(
    private sqlite: SqliteStore,
    private decisions?: DecisionLog,
    private suggestions?: SuggestionStore,
  ) {}

  generate(opts?: DailyReportOptions): string {
    const since = opts?.since ?? new Date(new Date().setHours(0, 0, 0, 0)).toISOString();
    const now = new Date();
    const dateStr = now.toISOString().split('T')[0];

    const allTasks = this.sqlite.listTasks();
    const agents = this.sqlite.listAgents();
    const totalCost = this.sqlite.getTotalCost();

    // Categorize tasks
    const completed = allTasks.filter(t => t.state === 'done' && t.updatedAt >= since);
    const blocked = allTasks.filter(t => t.state === 'blocked' || t.state === 'gated');
    const inReview = allTasks.filter(t => t.state === 'in_review');
    const running = allTasks.filter(t => t.state === 'running');
    const totalDone = allTasks.filter(t => t.state === 'done').length;
    const totalTasks = allTasks.length;
    const progress = totalTasks > 0 ? Math.round((totalDone / totalTasks) * 100) : 0;

    // Determine status
    let status = 'In progress';
    if (totalDone === totalTasks && totalTasks > 0) status = 'Complete';
    else if (blocked.length > 0 && running.length === 0) status = 'Blocked';

    // Get decisions
    const recentDecisions = this.decisions
      ? this.decisions.list({ since })
      : [];

    // Cost by agent
    const costByAgent = this.sqlite.getCostByAgent();

    // Build report
    const lines: string[] = [];
    lines.push(`# Flightdeck Daily Report - ${dateStr}`);
    lines.push('');

    // Summary
    lines.push('## Summary');
    lines.push(`- **Progress:** ${totalDone}/${totalTasks} tasks complete (${progress}%)`);
    lines.push(`- **Status:** ${status}`);
    lines.push(`- **Cost:** $${totalCost.toFixed(2)}`);
    lines.push(`- **Active agents:** ${agents.filter(a => a.status === 'busy' || a.status === 'idle').length}`);
    lines.push('');

    // Completed today
    if (completed.length > 0) {
      lines.push('## Completed Today');
      for (const t of completed) {
        lines.push(`- ✅ ${t.id}: ${t.title}${t.assignedAgent ? ` (${t.assignedAgent})` : ''}`);
      }
      lines.push('');
    }

    // Blocked
    if (blocked.length > 0) {
      lines.push('## Blocked');
      for (const t of blocked) {
        lines.push(`- ⏸ ${t.id}: ${t.title} [${t.state}]`);
      }
      lines.push('');
    }

    // In Review
    if (inReview.length > 0) {
      lines.push('## In Review');
      for (const t of inReview) {
        lines.push(`- 🔍 ${t.id}: ${t.title}${t.assignedAgent ? ` (assigned: ${t.assignedAgent})` : ''}`);
      }
      lines.push('');
    }

    // Key Decisions
    if (recentDecisions.length > 0) {
      lines.push('## Key Decisions');
      for (const d of recentDecisions) {
        const statusLabel = d.status === 'auto_approved' ? 'auto-approved' :
          d.status === 'pending_review' ? '⚠️ pending review' :
          d.status === 'human_approved' ? 'approved' :
          d.status === 'human_rejected' ? '❌ rejected' : d.status;
        lines.push(`- **${d.title}** (${statusLabel}, confidence: ${d.confidence})`);
        if (d.reasoning) lines.push(`  - ${d.reasoning}`);
      }
      lines.push('');
    }

    // Tomorrow's Plan
    const ready = allTasks.filter(t => t.state === 'ready');
    const pending = allTasks.filter(t => t.state === 'pending');
    if (ready.length > 0 || blocked.length > 0 || pending.length > 0) {
      lines.push("## Tomorrow's Plan");
      for (const t of ready) {
        lines.push(`- Execute: ${t.id} — ${t.title}`);
      }
      for (const t of blocked) {
        lines.push(`- Unblock: ${t.id} — ${t.title}`);
      }
      if (pending.length > 0) {
        lines.push(`- ${pending.length} tasks pending dependency resolution`);
      }
      lines.push('');
    }

    // Next Steps (scout suggestions)
    if (this.suggestions) {
      const pending = this.suggestions.list({ status: 'pending' });
      if (pending.length > 0) {
        lines.push('## Next Steps (Scout Suggestions)');
        const sorted = [...pending].sort((a, b) => {
          const impactOrder = { high: 0, medium: 1, low: 2 };
          const effortOrder = { small: 0, medium: 1, large: 2 };
          return (impactOrder[a.impact] - impactOrder[b.impact]) ||
                 (effortOrder[a.effort] - effortOrder[b.effort]);
        });
        for (const s of sorted) {
          const emoji = { quality: '🔧', docs: '📝', feature: '✨', debt: '🏗️', performance: '⚡', security: '🔒' }[s.category] ?? '💡';
          lines.push(`- ${emoji} **${s.title}** [${s.category}] (effort: ${s.effort}, impact: ${s.impact})`);
          lines.push(`  ${s.description}`);
          lines.push(`  → ID: \`${s.id}\` — approve or reject via suggestion tools`);
        }
        lines.push('');
      }
    }

    // Cost Breakdown
    if (costByAgent.length > 0 && costByAgent.some(c => c.cost > 0)) {
      lines.push('## Cost Breakdown');
      lines.push('| Agent | Role | Cost |');
      lines.push('|---|---|---|');
      for (const entry of costByAgent) {
        const agent = agents.find(a => a.id === entry.agentId);
        const role = agent?.role ?? 'unknown';
        lines.push(`| ${entry.agentId} | ${role} | $${entry.cost.toFixed(2)} |`);
      }
      lines.push('');
    }

    return lines.join('\n');
  }
}
