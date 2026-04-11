import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Flightdeck } from '../../src/facade.js';

describe('Flightdeck Facade', () => {
  let fd: Flightdeck;

  beforeEach(() => {
    fd = new Flightdeck({ dbPath: ':memory:' });
  });

  afterEach(() => {
    fd.close();
  });

  // Tasks
  it('adds and lists tasks', () => {
    const t = fd.addTask({ title: 'Test task', role: 'dev' });
    expect(t.id).toMatch(/^tk-/);
    expect(t.state).toBe('ready');
    const list = fd.listTasks();
    expect(list).toHaveLength(1);
  });

  it('handles task lifecycle: add → start → complete', () => {
    const t = fd.addTask({ title: 'Task', role: 'dev' });
    fd.registerAgent('a1', 'dev');
    const started = fd.startTask(t.id, 'a1');
    expect(started.state).toBe('running');
    const done = fd.completeTask(t.id);
    expect(done.state).toBe('done');
  });

  it('resolves dependents when task completes', () => {
    const t1 = fd.addTask({ title: 'First', role: 'dev' });
    const t2 = fd.addTask({ title: 'Second', role: 'dev', dependsOn: [t1.id] });
    expect(t2.state).toBe('pending');
    fd.registerAgent('a1', 'dev');
    fd.startTask(t1.id, 'a1');
    fd.completeTask(t1.id);
    const updated = fd.getTask(t2.id);
    expect(updated?.state).toBe('ready');
  });

  it('fails a running task', () => {
    const t = fd.addTask({ title: 'Task', role: 'dev' });
    fd.registerAgent('a1', 'dev');
    fd.startTask(t.id, 'a1');
    const failed = fd.failTask(t.id, 'oops');
    expect(failed.state).toBe('failed');
  });

  it('gates a task', () => {
    const t = fd.addTask({ title: 'Task', role: 'dev' });
    const gate = fd.gateTask(t.id, 'ci_check', 'run-123');
    expect(gate.awaitType).toBe('ci_check');
    expect(fd.getTask(t.id)?.state).toBe('gated');
  });

  it('filters tasks by status', () => {
    fd.addTask({ title: 'A', role: 'dev' });
    const t2 = fd.addTask({ title: 'B', role: 'dev' });
    fd.registerAgent('a1', 'dev');
    fd.startTask(t2.id, 'a1');
    expect(fd.listTasks({ status: 'running' })).toHaveLength(1);
    expect(fd.listTasks({ status: 'ready' })).toHaveLength(1);
  });

  it('returns topo sort', () => {
    const t1 = fd.addTask({ title: 'A', role: 'dev' });
    fd.addTask({ title: 'B', role: 'dev', dependsOn: [t1.id] });
    const order = fd.topoSort();
    expect(order).toHaveLength(2);
    expect(order[0]).toBe(t1.id);
  });

  // Specs
  it('creates and lists specs', () => {
    const s = fd.createSpec('My Spec');
    expect(s.id).toMatch(/^sp-/);
    expect(fd.listSpecs()).toHaveLength(1);
  });

  it('proposes and approves changes', () => {
    const s = fd.createSpec('Spec');
    const c = fd.proposeChange(s.id);
    expect(c.status).toBe('proposed');
    const approved = fd.approveChange(c.id);
    expect(approved.status).toBe('approved');
  });

  // Agents
  it('registers and lists agents', () => {
    fd.registerAgent('agent-1', 'dev');
    const agents = fd.listAgents();
    expect(agents).toHaveLength(1);
    expect(agents[0].role).toBe('dev');
  });

  it('sends heartbeat', () => {
    fd.registerAgent('a1', 'dev');
    expect(fd.agentHeartbeat('a1')).toBe(true);
    expect(fd.agentHeartbeat('nonexistent')).toBe(false);
  });

  // Messages
  it('sends and retrieves messages', () => {
    const msg = fd.sendMessage('agent-1', 'Hello!', { priority: 'critical' });
    expect(msg.id).toMatch(/^mg-/);
    const inbox = fd.getInbox('agent-1');
    expect(inbox).toHaveLength(1);
    expect(inbox[0].priority).toBe('critical');
  });

  it('lists messages by thread', () => {
    const m1 = fd.sendMessage('a1', 'Hi');
    fd.sendMessage('a1', 'Reply', { threadId: m1.id });
    const thread = fd.listMessages({ threadId: m1.id });
    expect(thread).toHaveLength(1); // only the reply has threadId set
  });

  // Verification
  it('requests and decides review', () => {
    const t = fd.addTask({ title: 'Task', role: 'dev' });
    const rev = fd.requestReview(t.id, 'reviewer-1');
    expect(rev.id).toMatch(/^rev-/);
    const decided = fd.decideReview(rev.id, 'approve', 'LGTM');
    expect(decided.verdict).toBe('approve');
  });

  // Status
  it('returns overall status', () => {
    fd.addTask({ title: 'A', role: 'dev' });
    fd.registerAgent('a1', 'dev');
    const s = fd.status();
    expect(s.tasks.total).toBe(1);
    expect(s.agents.total).toBe(1);
  });

  // DAG stats
  it('returns dag stats', () => {
    fd.addTask({ title: 'A', role: 'dev' });
    const stats = fd.dagStats();
    expect(stats.total).toBe(1);
    expect(stats.byState.ready).toBe(1);
  });
});
