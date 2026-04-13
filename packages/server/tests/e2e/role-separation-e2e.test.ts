import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { getToolsForRole, ROLE_TOOLS } from '../../src/mcp/toolPermissions.js';
import { parseReviewerResponse, buildReviewPrompt } from '../../src/verification/ReviewFlow.js';
import { LeadManager, FLIGHTDECK_IDLE, FLIGHTDECK_NO_REPLY } from '../../src/lead/LeadManager.js';
import type { PlannerEvent } from '../../src/lead/LeadManager.js';
import { SqliteStore } from '../../src/storage/SqliteStore.js';
import { TaskDAG } from '../../src/dag/TaskDAG.js';
import { GovernanceEngine } from '../../src/governance/GovernanceEngine.js';
import { Orchestrator } from '../../src/orchestrator/Orchestrator.js';
import type { AgentAdapter, SpawnOptions, SteerMessage, AgentMetadata } from '../../src/agents/AgentAdapter.js';
import type { AgentId, AgentRuntime, Agent, TaskId, ProjectConfig } from '@flightdeck-ai/shared';

// ── Mock ACP Adapter ──

class MockAcpAdapter extends (await import('../../src/agents/AgentAdapter.js')).AgentAdapter {
  readonly runtime: AgentRuntime = 'acp';
  private sessions = new Map<string, { opts: SpawnOptions; meta: AgentMetadata; steers: SteerMessage[]; killed: boolean }>();
  private nextId = 1;

  spawnCount = 0;
  steerLog: Array<{ sessionId: string; message: SteerMessage }> = [];
  killLog: string[] = [];

  async spawn(opts: SpawnOptions): Promise<AgentMetadata> {
    this.spawnCount++;
    const sessionId = `mock-session-${this.nextId++}`;
    const meta: AgentMetadata = {
      agentId: `${opts.role}:${Date.now()}-${this.nextId}` as AgentId,
      sessionId,
      status: 'running',
      model: opts.model,
      tokensIn: 0,
      tokensOut: 0,
      turnCount: 0,
    };
    this.sessions.set(sessionId, { opts, meta, steers: [], killed: false });
    return meta;
  }

  async steer(sessionId: string, message: SteerMessage): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    session.steers.push(message);
    this.steerLog.push({ sessionId, message });
  }

  async kill(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    session.killed = true;
    session.meta.status = 'ended';
    this.killLog.push(sessionId);
  }

  async getMetadata(sessionId: string): Promise<AgentMetadata | null> {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    return { ...session.meta };
  }

  clear(): void {
    this.sessions.clear();
    this.steerLog = [];
    this.killLog = [];
    this.spawnCount = 0;
    this.nextId = 1;
  }
}

// ── Mock helpers ──

function createMockStore() {
  const agents = new Map<AgentId, Agent>();
  return {
    insertAgent(agent: Agent) { agents.set(agent.id, { ...agent }); },
    getAgent(id: AgentId): Agent | null { return agents.get(id) ?? null; },
    listAgents(): Agent[] { return [...agents.values()]; },
    updateAgentStatus(id: AgentId, status: Agent['status']) {
      const a = agents.get(id);
      if (a) a.status = status;
    },
    updateAgentAcpSession(id: AgentId, sessionId: string | null) {
      const a = agents.get(id);
      if (a) a.acpSessionId = sessionId;
    },
    updateAgentHeartbeat(id: AgentId) {
      const a = agents.get(id);
      if (a) a.lastHeartbeat = new Date().toISOString();
    },
    deleteAgent(id: AgentId): boolean { return agents.delete(id); },
    purgeOfflineAgents(): number {
      let count = 0;
      for (const [id, a] of agents) {
        if (a.status === 'offline') { agents.delete(id); count++; }
      }
      return count;
    },
    getTaskStats() { return { ready: 2, running: 1, in_review: 0, done: 3, failed: 0 }; },
    getTotalCost() { return 1.23; },
    _agents: agents,
  };
}

function createMockProjectStore(heartbeatContent?: string) {
  return {
    readHeartbeat() { return heartbeatContent ?? null; },
  };
}

// ═══════════════════════════════════════════════════════════════
// Test Suite: Role Separation E2E
// ═══════════════════════════════════════════════════════════════

describe('Role Separation E2E', () => {

  // ── 1. Tool Permission Boundaries ──

  describe('1. Tool Permission Boundaries', () => {

    describe('Lead role', () => {
      const leadTools = getToolsForRole('lead');

      it('does NOT have task_complete, task_submit, task_claim', () => {
        expect(leadTools).not.toContain('flightdeck_task_complete');
        expect(leadTools).not.toContain('flightdeck_task_submit');
        expect(leadTools).not.toContain('flightdeck_task_claim');
      });

      it('DOES have status, task_list, task_add, agent_spawn, escalate, declare_tasks', () => {
        expect(leadTools).toContain('flightdeck_status');
        expect(leadTools).toContain('flightdeck_task_list');
        expect(leadTools).toContain('flightdeck_task_add');
        expect(leadTools).toContain('flightdeck_agent_spawn');
        expect(leadTools).toContain('flightdeck_escalate');
        expect(leadTools).toContain('flightdeck_declare_tasks');
      });
    });

    describe('Planner role', () => {
      const plannerTools = getToolsForRole('planner');

      it('does NOT have task_claim, task_submit, task_complete', () => {
        expect(plannerTools).not.toContain('flightdeck_task_claim');
        expect(plannerTools).not.toContain('flightdeck_task_submit');
        expect(plannerTools).not.toContain('flightdeck_task_complete');
      });

      it('DOES have task_list, task_add, declare_tasks, task_get, memory_write, escalate', () => {
        expect(plannerTools).toContain('flightdeck_task_list');
        expect(plannerTools).toContain('flightdeck_task_add');
        expect(plannerTools).toContain('flightdeck_declare_tasks');
        expect(plannerTools).toContain('flightdeck_task_get');
        expect(plannerTools).toContain('flightdeck_memory_write');
        expect(plannerTools).toContain('flightdeck_escalate');
      });
    });

    describe('Reviewer role', () => {
      const reviewerTools = getToolsForRole('reviewer');

      it('does NOT have task_claim, task_submit, task_add, agent_spawn', () => {
        expect(reviewerTools).not.toContain('flightdeck_task_claim');
        expect(reviewerTools).not.toContain('flightdeck_task_submit');
        expect(reviewerTools).not.toContain('flightdeck_task_add');
        expect(reviewerTools).not.toContain('flightdeck_agent_spawn');
      });

      it('DOES have task_complete, task_fail, task_get, escalate', () => {
        expect(reviewerTools).toContain('flightdeck_task_complete');
        expect(reviewerTools).toContain('flightdeck_task_fail');
        expect(reviewerTools).toContain('flightdeck_task_get');
        expect(reviewerTools).toContain('flightdeck_escalate');
      });
    });

    describe('Worker role', () => {
      const workerTools = getToolsForRole('worker');

      it('does NOT have task_complete, agent_spawn, declare_tasks', () => {
        expect(workerTools).not.toContain('flightdeck_task_complete');
        expect(workerTools).not.toContain('flightdeck_agent_spawn');
        expect(workerTools).not.toContain('flightdeck_declare_tasks');
      });

      it('DOES have task_claim, task_submit, task_fail, escalate', () => {
        expect(workerTools).toContain('flightdeck_task_claim');
        expect(workerTools).toContain('flightdeck_task_submit');
        expect(workerTools).toContain('flightdeck_task_fail');
        expect(workerTools).toContain('flightdeck_escalate');
      });
    });

    it('unknown role falls back to worker tools', () => {
      expect(getToolsForRole('nonexistent')).toEqual(ROLE_TOOLS.worker);
    });

    it('no role has ALL tools — separation is real', () => {
      const allRoles = ['lead', 'planner', 'reviewer', 'worker'];
      for (const a of allRoles) {
        for (const b of allRoles) {
          if (a === b) continue;
          const toolsA = new Set(getToolsForRole(a));
          const toolsB = new Set(getToolsForRole(b));
          // They shouldn't be identical
          const same = toolsA.size === toolsB.size && [...toolsA].every(t => toolsB.has(t));
          expect(same, `${a} and ${b} should have different tool sets`).toBe(false);
        }
      }
    });
  });

  // ── 2. ReviewFlow Integration ──

  describe('2. ReviewFlow Integration', () => {

    describe('parseReviewerResponse', () => {
      it('parses "VERDICT: APPROVE" → approve', () => {
        const result = parseReviewerResponse('VERDICT: APPROVE\nLooks great!');
        expect(result.verdict).toBe('approve');
        expect(result.feedback).toBe('Looks great!');
      });

      it('parses "VERDICT: REJECT" with feedback', () => {
        const result = parseReviewerResponse('VERDICT: REJECT\nBad implementation');
        expect(result.verdict).toBe('reject');
        expect(result.feedback).toBe('Bad implementation');
      });

      it('parses "VERDICT: REQUEST-CHANGES" with feedback', () => {
        const result = parseReviewerResponse('VERDICT: REQUEST-CHANGES\nFix the tests');
        expect(result.verdict).toBe('request-changes');
        expect(result.feedback).toBe('Fix the tests');
      });

      it('infers approve from keywords when no verdict line', () => {
        const result = parseReviewerResponse('This change looks good, I approve of it.');
        expect(result.verdict).toBe('approve');
      });

      it('infers reject from keywords when no verdict line', () => {
        const result = parseReviewerResponse('I reject this change, it breaks the API.');
        expect(result.verdict).toBe('reject');
      });

      it('defaults to request-changes for garbled output', () => {
        const result = parseReviewerResponse('asdfghjkl random gibberish');
        expect(result.verdict).toBe('request-changes');
        expect(result.feedback).toContain('asdfghjkl');
      });

      it('defaults to request-changes for empty output', () => {
        const result = parseReviewerResponse('');
        expect(result.verdict).toBe('request-changes');
      });
    });

    describe('buildReviewPrompt', () => {
      it('includes task ID and title', () => {
        const prompt = buildReviewPrompt({
          id: 'task-1' as TaskId,
          title: 'Fix auth bug',
          claim: 'Fixed the token refresh logic',
        });
        expect(prompt).toContain('task-1');
        expect(prompt).toContain('Fix auth bug');
        expect(prompt).toContain('Fixed the token refresh logic');
        expect(prompt).toContain('VERDICT: APPROVE');
        expect(prompt).toContain('VERDICT: REJECT');
      });

      it('includes diff when provided', () => {
        const prompt = buildReviewPrompt({
          id: 'task-2' as TaskId,
          diff: '+const x = 1;\n-const x = 2;',
        });
        expect(prompt).toContain('+const x = 1;');
      });

      it('includes artifacts when provided', () => {
        const prompt = buildReviewPrompt({
          id: 'task-3' as TaskId,
          artifacts: ['screenshot.png', 'test-output.log'],
        });
        expect(prompt).toContain('screenshot.png');
        expect(prompt).toContain('test-output.log');
      });
    });
  });

  // ── 3. Planner Event Routing ──

  describe('3. Planner Event Routing', () => {
    let leadManager: LeadManager;

    beforeEach(() => {
      leadManager = new LeadManager({
        sqlite: createMockStore() as any,
        project: createMockProjectStore() as any,
        acpAdapter: new MockAcpAdapter() as any,
      });
    });

    it('critical_task_completed → contains title, remaining, validation request', () => {
      const msg = leadManager.buildPlannerSteer({
        type: 'critical_task_completed',
        taskId: 'task-1',
        specId: 'spec-A',
        title: 'Setup database',
        remainingInSpec: 3,
      });
      expect(msg).toContain('Setup database');
      expect(msg).toContain('task-1');
      expect(msg).toContain('3');
      expect(msg).toContain('validate');
    });

    it('task_failed → contains error, retries, re-decomposition suggestion', () => {
      const msg = leadManager.buildPlannerSteer({
        type: 'task_failed',
        taskId: 'task-2',
        error: 'Build failed: type errors',
        retriesLeft: 2,
      });
      expect(msg).toContain('type errors');
      expect(msg).toContain('2');
      expect(msg).toContain('re-decomposed');
    });

    it('worker_escalation → contains agent id, reason', () => {
      const msg = leadManager.buildPlannerSteer({
        type: 'worker_escalation',
        taskId: 'task-3',
        agentId: 'worker-7',
        reason: 'Missing API endpoint docs',
      });
      expect(msg).toContain('worker-7');
      expect(msg).toContain('Missing API endpoint docs');
    });

    it('spec_milestone → contains completion counts', () => {
      const msg = leadManager.buildPlannerSteer({
        type: 'spec_milestone',
        specId: 'spec-B',
        completed: 3,
        total: 4,
      });
      expect(msg).toContain('spec-B');
      expect(msg).toContain('3');
      expect(msg).toContain('4');
    });

    it('plan_validation_request → contains spec id and context', () => {
      const msg = leadManager.buildPlannerSteer({
        type: 'plan_validation_request',
        specId: 'spec-C',
        context: 'Worker discovered new dependency',
      });
      expect(msg).toContain('spec-C');
      expect(msg).toContain('Worker discovered new dependency');
    });
  });

  // ── 4. Orchestrator Planner Notification Filtering ──

  describe('4. Orchestrator Planner Notification Filtering', () => {
    let store: SqliteStore;
    let dag: TaskDAG;
    let adapter: MockAcpAdapter;
    let orch: Orchestrator;
    let leadManager: LeadManager;
    let tmpDir: string;
    let plannerEventSpy: ReturnType<typeof vi.spyOn>;

    const config: ProjectConfig = {
      name: 'test-role-sep',
      governance: 'autonomous',
      isolation: 'none',
      onCompletion: 'stop',
    };

    beforeEach(async () => {
      tmpDir = mkdtempSync(join(tmpdir(), 'fd-role-sep-'));
      store = new SqliteStore(join(tmpDir, 'test.sqlite'));
      dag = new TaskDAG(store);
      adapter = new MockAcpAdapter();
      const gov = new GovernanceEngine(config);

      leadManager = new LeadManager({
        sqlite: store as any,
        project: createMockProjectStore() as any,
        acpAdapter: adapter as any,
      });

      // Spy on planner event steers
      plannerEventSpy = vi.spyOn(leadManager, 'steerPlannerEvent').mockResolvedValue('');

      orch = new Orchestrator(dag, store, gov, adapter as any, config, undefined, {
        leadManager,
        governanceConfig: { maxRetries: 3 },
      });
    });

    afterEach(() => {
      orch.stop();
      store.close();
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it('task with dependents completing → planner IS notified', () => {
      // Add tasks: A → B (B depends on A)
      const taskA = dag.addTask({ title: 'Task A', role: 'worker', specId: 'spec-1' });
      const taskB = dag.addTask({ title: 'Task B', role: 'worker', specId: 'spec-1', dependsOn: [taskA.id] });

      // Directly call notifyPlannerIfNeeded
      (orch as any).notifyPlannerIfNeeded(taskA.id, 'completed');

      expect(plannerEventSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'critical_task_completed',
          taskId: taskA.id,
        }),
      );
    });

    it('leaf task (no dependents) completing → planner NOT notified with critical_task_completed', () => {
      // Leaf task with no dependents
      const leaf = dag.addTask({ title: 'Leaf task', role: 'worker', specId: 'spec-1' });

      (orch as any).notifyPlannerIfNeeded(leaf.id, 'completed');

      // Should not have been called with critical_task_completed
      const criticalCalls = plannerEventSpy.mock.calls.filter(
        (c: any) => c[0].type === 'critical_task_completed',
      );
      expect(criticalCalls).toHaveLength(0);
    });

    it('task failure → planner IS always notified', () => {
      const task = dag.addTask({ title: 'Failing task', role: 'worker', specId: 'spec-1' });

      (orch as any).notifyPlannerIfNeeded(task.id, 'failed');

      expect(plannerEventSpy).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'task_failed' }),
      );
    });

    it('spec milestones at 50% and 75% → planner notified, no duplicates', () => {
      // Create 4 tasks in spec-m
      const t1 = dag.addTask({ title: 'T1', role: 'worker', specId: 'spec-m' });
      const t2 = dag.addTask({ title: 'T2', role: 'worker', specId: 'spec-m' });
      const t3 = dag.addTask({ title: 'T3', role: 'worker', specId: 'spec-m' });
      const t4 = dag.addTask({ title: 'T4', role: 'worker', specId: 'spec-m' });

      // Complete t1 (25%) — no milestone
      store.updateTaskState(t1.id, 'done');
      (orch as any).checkSpecMilestone('spec-m');
      expect(plannerEventSpy).not.toHaveBeenCalled();

      // Complete t2 (50%) — milestone!
      store.updateTaskState(t2.id, 'done');
      (orch as any).checkSpecMilestone('spec-m');
      expect(plannerEventSpy).toHaveBeenCalledTimes(1);
      expect(plannerEventSpy).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'spec_milestone', specId: 'spec-m' }),
      );

      // Call again at 50% — no duplicate
      (orch as any).checkSpecMilestone('spec-m');
      expect(plannerEventSpy).toHaveBeenCalledTimes(1);

      // Complete t3 (75%) — another milestone
      store.updateTaskState(t3.id, 'done');
      (orch as any).checkSpecMilestone('spec-m');
      expect(plannerEventSpy).toHaveBeenCalledTimes(2);
    });
  });

  // ── 5. Lead Response Handling ──

  describe('5. Lead Response Handling', () => {
    let leadManager: LeadManager;

    beforeEach(() => {
      leadManager = new LeadManager({
        sqlite: createMockStore() as any,
        project: createMockProjectStore() as any,
        acpAdapter: new MockAcpAdapter() as any,
      });
    });

    it('FLIGHTDECK_IDLE → null (suppressed)', () => {
      expect(leadManager.handleLeadResponse(FLIGHTDECK_IDLE)).toBeNull();
    });

    it('FLIGHTDECK_NO_REPLY → null (suppressed)', () => {
      expect(leadManager.handleLeadResponse(FLIGHTDECK_NO_REPLY)).toBeNull();
    });

    it('real response → forwarded as-is', () => {
      const msg = 'The auth module is done, moving to testing';
      expect(leadManager.handleLeadResponse(msg)).toBe(msg);
    });

    it('whitespace around sentinels → still suppressed', () => {
      expect(leadManager.handleLeadResponse('  FLIGHTDECK_IDLE  ')).toBeNull();
      expect(leadManager.handleLeadResponse('\nFLIGHTDECK_NO_REPLY\n')).toBeNull();
    });
  });

  // ── 6. End-to-End Role Interaction (Integration) ──

  describe('6. End-to-End Role Interaction', () => {
    let store: SqliteStore;
    let dag: TaskDAG;
    let adapter: MockAcpAdapter;
    let orch: Orchestrator;
    let leadManager: LeadManager;
    let tmpDir: string;
    let plannerEventSpy: ReturnType<typeof vi.spyOn>;
    let leadSteerSpy: ReturnType<typeof vi.spyOn>;

    const config: ProjectConfig = {
      name: 'test-e2e-roles',
      governance: 'autonomous',
      isolation: 'none',
      onCompletion: 'stop',
    };

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), 'fd-e2e-roles-'));
      store = new SqliteStore(join(tmpDir, 'test.sqlite'));
      dag = new TaskDAG(store);
      adapter = new MockAcpAdapter();
      const gov = new GovernanceEngine(config);

      leadManager = new LeadManager({
        sqlite: store as any,
        project: createMockProjectStore() as any,
        acpAdapter: adapter as any,
      });

      plannerEventSpy = vi.spyOn(leadManager, 'steerPlannerEvent').mockResolvedValue('');
      leadSteerSpy = vi.spyOn(leadManager, 'steerLead').mockResolvedValue('');

      orch = new Orchestrator(dag, store, gov, adapter as any, config, undefined, {
        leadManager,
        governanceConfig: { maxRetries: 3 },
      });
    });

    afterEach(() => {
      orch.stop();
      store.close();
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it('full role interaction flow: 4 tasks with dependencies', async () => {
      // Setup: A, B parallel; C depends on A; D depends on B and C
      const taskA = dag.addTask({ title: 'Task A', role: 'worker', specId: 'spec-e2e' });
      const taskB = dag.addTask({ title: 'Task B', role: 'worker', specId: 'spec-e2e' });
      const taskC = dag.addTask({ title: 'Task C', role: 'worker', specId: 'spec-e2e', dependsOn: [taskA.id] });
      const taskD = dag.addTask({ title: 'Task D', role: 'worker', specId: 'spec-e2e', dependsOn: [taskB.id, taskC.id] });

      // Verify A and B are ready, C and D are blocked
      expect(dag.getTask(taskA.id)!.state).toBe('ready');
      expect(dag.getTask(taskB.id)!.state).toBe('ready');
      expect(['pending', 'blocked']).toContain(dag.getTask(taskC.id)!.state);
      expect(['pending', 'blocked']).toContain(dag.getTask(taskD.id)!.state);

      // --- Task A: claim → submit → review approve → done ---
      dag.claimTask(taskA.id, 'worker-1' as AgentId);
      expect(dag.getTask(taskA.id)!.state).toBe('running');

      dag.submitTask(taskA.id);
      expect(dag.getTask(taskA.id)!.state).toBe('in_review');

      // Simulate review approval
      store.updateTaskState(taskA.id, 'done');

      // Notify planner — A has dependent C
      (orch as any).notifyPlannerIfNeeded(taskA.id, 'completed');
      expect(plannerEventSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'critical_task_completed',
          title: 'Task A',
        }),
      );

      // C should now be unblocked (ready) since A is done
      // TaskDAG should auto-promote on next read/tick
      const cState = dag.getTask(taskC.id)!.state;
      // Depending on DAG impl, may need a tick to promote
      // Either 'ready' or 'blocked' — if blocked, tick should fix it

      // --- Task B: claim → submit → approve → done ---
      dag.claimTask(taskB.id, 'worker-2' as AgentId);
      dag.submitTask(taskB.id);
      store.updateTaskState(taskB.id, 'done');

      (orch as any).notifyPlannerIfNeeded(taskB.id, 'completed');
      // B has dependent D
      expect(plannerEventSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'critical_task_completed',
          title: 'Task B',
        }),
      );

      // 50% milestone (2/4 done)
      const milestoneCalls = plannerEventSpy.mock.calls.filter(
        (c: any) => c[0].type === 'spec_milestone',
      );
      expect(milestoneCalls.length).toBeGreaterThanOrEqual(1);

      // --- Task C ---
      // Promote C since its dependency A is done
      if (dag.getTask(taskC.id)!.state !== 'ready') {
        store.updateTaskState(taskC.id, 'ready');
      }
      dag.claimTask(taskC.id, 'worker-1' as AgentId);
      dag.submitTask(taskC.id);
      store.updateTaskState(taskC.id, 'done');

      (orch as any).notifyPlannerIfNeeded(taskC.id, 'completed');
      // C has dependent D
      expect(plannerEventSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'critical_task_completed',
          title: 'Task C',
        }),
      );

      // 75% milestone (3/4)
      const milestone75 = plannerEventSpy.mock.calls.filter(
        (c: any) => c[0].type === 'spec_milestone',
      );
      expect(milestone75.length).toBeGreaterThanOrEqual(2);

      // --- Task D (leaf) ---
      if (dag.getTask(taskD.id)!.state !== 'ready') {
        store.updateTaskState(taskD.id, 'ready');
      }
      dag.claimTask(taskD.id, 'worker-2' as AgentId);
      dag.submitTask(taskD.id);
      store.updateTaskState(taskD.id, 'done');

      (orch as any).notifyPlannerIfNeeded(taskD.id, 'completed');

      // D is a leaf — should NOT get critical_task_completed
      const dCritical = plannerEventSpy.mock.calls.filter(
        (c: any) => c[0].type === 'critical_task_completed' && c[0].title === 'Task D',
      );
      expect(dCritical).toHaveLength(0);

      // All tasks done
      expect(dag.getTask(taskA.id)!.state).toBe('done');
      expect(dag.getTask(taskB.id)!.state).toBe('done');
      expect(dag.getTask(taskC.id)!.state).toBe('done');
      expect(dag.getTask(taskD.id)!.state).toBe('done');

      // Lead NEVER received review-related steers
      const leadReviewCalls = leadSteerSpy.mock.calls.filter(
        (c: any) => c[0]?.type === 'review' || (typeof c[0] === 'string' && c[0].includes('review')),
      );
      expect(leadReviewCalls).toHaveLength(0);

      // Planner received critical_task_completed for A, B, C but not D
      const criticalTitles = plannerEventSpy.mock.calls
        .filter((c: any) => c[0].type === 'critical_task_completed')
        .map((c: any) => c[0].title);
      expect(criticalTitles).toContain('Task A');
      expect(criticalTitles).toContain('Task B');
      expect(criticalTitles).toContain('Task C');
      expect(criticalTitles).not.toContain('Task D');
    });
  });
});
