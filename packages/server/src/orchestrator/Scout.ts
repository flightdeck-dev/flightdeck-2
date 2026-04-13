import { randomUUID } from 'node:crypto';
import type { Flightdeck } from '../facade.js';
import type { SpecId, Task } from '@flightdeck-ai/shared';
import type { AgentAdapter, SpawnOptions, AgentMetadata } from '../agents/AgentAdapter.js';

// ── Suggestion types ──

export type SuggestionCategory = 'quality' | 'docs' | 'feature' | 'debt' | 'performance' | 'security';
export type SuggestionEffort = 'small' | 'medium' | 'large';
export type SuggestionImpact = 'low' | 'medium' | 'high';
export type SuggestionStatus = 'pending' | 'approved' | 'rejected';

export interface Suggestion {
  id: string;
  specId: string;
  title: string;
  description: string;
  category: SuggestionCategory;
  effort: SuggestionEffort;
  impact: SuggestionImpact;
  status: SuggestionStatus;
  createdAt: string;
}

const VALID_CATEGORIES = new Set<string>(['quality', 'docs', 'feature', 'debt', 'performance', 'security']);
const VALID_EFFORTS = new Set<string>(['small', 'medium', 'large']);
const VALID_IMPACTS = new Set<string>(['low', 'medium', 'high']);

/**
 * Parse the scout agent's output into structured suggestions.
 * Expects a JSON array in the agent output.
 */
export function parseSuggestions(output: string, specId: string): Suggestion[] {
  // Extract JSON array from output (may have surrounding text)
  const jsonMatch = output.match(/\[[\s\S]*\]/);
  if (!jsonMatch) return [];

  try {
    const raw = JSON.parse(jsonMatch[0]) as unknown[];
    if (!Array.isArray(raw)) return [];

    return raw
      .filter((item): item is Record<string, unknown> =>
        typeof item === 'object' && item !== null &&
        typeof (item as Record<string, unknown>).title === 'string' &&
        typeof (item as Record<string, unknown>).description === 'string',
      )
      .map(item => ({
        id: `sug-${randomUUID().slice(0, 8)}`,
        specId,
        title: item.title as string,
        description: item.description as string,
        category: VALID_CATEGORIES.has(item.category as string)
          ? (item.category as SuggestionCategory)
          : 'quality',
        effort: VALID_EFFORTS.has(item.effort as string)
          ? (item.effort as SuggestionEffort)
          : 'medium',
        impact: VALID_IMPACTS.has(item.impact as string)
          ? (item.impact as SuggestionImpact)
          : 'medium',
        status: 'pending' as const,
        createdAt: new Date().toISOString(),
      }));
  } catch {
    return [];
  }
}

/**
 * Build the prompt context for the scout agent.
 */
function buildScoutContext(fd: Flightdeck, specId: string): string {
  const tasks = fd.sqlite.listTasks(specId as SpecId);
  const completedTasks = tasks.filter(t => t.state === 'done');

  const taskSummaries = completedTasks.map(t =>
    `- ${t.id}: ${t.title} (role: ${t.role})`,
  ).join('\n');

  const specs = fd.specs.list();
  const currentSpec = specs.find(s => s.id === specId);

  // Recent decisions
  let decisionsText = '';
  try {
    const decisions = fd.decisions.list({ limit: 20 });
    if (decisions.length > 0) {
      decisionsText = '\n## Recent Decisions\n' + decisions.map(d =>
        `- ${d.title} (${d.status}, confidence: ${d.confidence})`,
      ).join('\n');
    }
  } catch { /* no decisions */ }

  return `# Scout Analysis Request

## Spec: ${currentSpec?.title ?? specId}
${currentSpec?.content ?? '(spec content not available)'}

## Completed Tasks (${completedTasks.length}/${tasks.length})
${taskSummaries || '(no completed tasks)'}
${decisionsText}

Analyze the completed work and generate improvement suggestions as a JSON array.
Focus on what's missing, what could be better, and what technical debt was introduced.`;
}

export interface ScoutOptions {
  /** Override adapter for testing */
  adapter?: AgentAdapter;
  /** Timeout in ms for the scout agent. Default: 120000 */
  timeoutMs?: number;
}

/**
 * Run the scout agent to analyze completed work and generate suggestions.
 *
 * In production, this spawns a real agent via AcpAdapter.
 * For testing, pass opts.adapter with a mock.
 */
export async function runScout(
  fd: Flightdeck,
  specId: string,
  opts?: ScoutOptions,
): Promise<Suggestion[]> {
  const context = buildScoutContext(fd, specId);
  const adapter = opts?.adapter;

  if (!adapter) {
    // No adapter — return empty (daemon must wire up the real adapter)
    return [];
  }

  // Spawn a scout agent
  let meta: AgentMetadata;
  try {
    meta = await adapter.spawn({
      role: 'scout' as SpawnOptions['role'],
      cwd: fd.project.path,
      systemPrompt: context,
    });
  } catch {
    return [];
  }

  // Steer it with the analysis request
  let output: string;
  try {
    output = await adapter.steer(meta.sessionId, { content: context });
  } catch {
    return [];
  }

  // Kill the scout agent
  try {
    await adapter.kill(meta.sessionId);
  } catch { /* best effort */ }

  return parseSuggestions(output, specId);
}
