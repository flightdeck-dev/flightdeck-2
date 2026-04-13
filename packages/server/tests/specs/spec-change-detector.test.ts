import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SqliteStore } from '../../src/storage/SqliteStore.js';
import { SpecStore } from '../../src/storage/SpecStore.js';
import { SpecChangeDetector } from '../../src/specs/SpecChangeDetector.js';
import { TaskDAG } from '../../src/dag/TaskDAG.js';
import { GovernanceEngine } from '../../src/governance/GovernanceEngine.js';
import { AcpAdapter } from '../../src/agents/AcpAdapter.js';
import { Orchestrator } from '../../src/orchestrator/Orchestrator.js';
import type { ProjectConfig, SpecId } from '@flightdeck-ai/shared';
import { specId as makeSpecId } from '@flightdeck-ai/shared';

describe('SpecChangeDetector', () => {
  let tmpDir: string;
  let specsDir: string;
  let store: SqliteStore;
  let specStore: SpecStore;
  let detector: SpecChangeDetector;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'fd-spec-'));
    specsDir = join(tmpDir, 'specs');
    mkdirSync(specsDir, { recursive: true });
    store = new SqliteStore(join(tmpDir, 'test.sqlite'));
    specStore = new SpecStore(specsDir);
    detector = new SpecChangeDetector(specStore, store);
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('detects new spec files', () => {
    writeFileSync(join(specsDir, 'auth.md'), '# Auth\nImplement auth');
    const changes = detector.checkForChanges();
    expect(changes).toHaveLength(1);
    expect(changes[0].isNew).toBe(true);
    expect(changes[0].filename).toBe('auth.md');
  });

  it('detects no changes on second check', () => {
    writeFileSync(join(specsDir, 'auth.md'), '# Auth\nImplement auth');
    detector.checkForChanges(); // first check seeds hash
    const changes = detector.checkForChanges(); // second check
    expect(changes).toHaveLength(0);
  });

  it('detects content change', () => {
    writeFileSync(join(specsDir, 'auth.md'), '# Auth\nVersion 1');
    detector.checkForChanges(); // seed

    writeFileSync(join(specsDir, 'auth.md'), '# Auth\nVersion 2 — updated requirements');
    const changes = detector.checkForChanges();
    expect(changes).toHaveLength(1);
    expect(changes[0].isNew).toBe(false);
    expect(changes[0].oldHash).toBeTruthy();
    expect(changes[0].newHash).toBeTruthy();
    expect(changes[0].oldHash).not.toBe(changes[0].newHash);
  });

  it('seedHashes does not report changes', () => {
    writeFileSync(join(specsDir, 'auth.md'), '# Auth\nContent');
    detector.seedHashes();
    const changes = detector.checkForChanges();
    expect(changes).toHaveLength(0);
  });

  it('hashContent is deterministic', () => {
    const h1 = SpecChangeDetector.hashContent('hello');
    const h2 = SpecChangeDetector.hashContent('hello');
    const h3 = SpecChangeDetector.hashContent('world');
    expect(h1).toBe(h2);
    expect(h1).not.toBe(h3);
  });
});

describe('Task staleness (FR-008)', () => {
  let tmpDir: string;
  let specsDir: string;
  let store: SqliteStore;
  let dag: TaskDAG;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'fd-stale-'));
    specsDir = join(tmpDir, 'specs');
    mkdirSync(specsDir, { recursive: true });
    store = new SqliteStore(join(tmpDir, 'test.sqlite'));
    dag = new TaskDAG(store);
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('marks tasks stale by specId', () => {
    const t1 = dag.addTask({ title: 'Implement auth', specId: 'auth.md' as SpecId });
    const t2 = dag.addTask({ title: 'Write tests', specId: 'auth.md' as SpecId });
    const t3 = dag.addTask({ title: 'Other task', specId: 'other.md' as SpecId });

    expect(t1.stale).toBe(false);

    const marked = store.markTasksStaleBySpec('auth.md' as SpecId);
    expect(marked).toBe(2);

    const updated1 = store.getTask(t1.id);
    const updated2 = store.getTask(t2.id);
    const updated3 = store.getTask(t3.id);
    expect(updated1!.stale).toBe(true);
    expect(updated2!.stale).toBe(true);
    expect(updated3!.stale).toBe(false);
  });

  it('does not mark done tasks as stale', () => {
    const t1 = dag.addTask({ title: 'Done task', specId: 'auth.md' as SpecId });
    dag.claimTask(t1.id, 'agent-1' as any);
    dag.submitTask(t1.id);
    dag.completeTask(t1.id);

    const marked = store.markTasksStaleBySpec('auth.md' as SpecId);
    expect(marked).toBe(0);
  });

  it('clearTaskStale clears the flag', () => {
    const t1 = dag.addTask({ title: 'Task', specId: 'auth.md' as SpecId });
    store.markTasksStaleBySpec('auth.md' as SpecId);
    expect(store.getTask(t1.id)!.stale).toBe(true);

    store.clearTaskStale(t1.id);
    expect(store.getTask(t1.id)!.stale).toBe(false);
  });
});

describe('Orchestrator spec change detection', () => {
  let tmpDir: string;
  let specsDir: string;
  let store: SqliteStore;
  let dag: TaskDAG;
  let orch: Orchestrator;

  const config: ProjectConfig = {
    name: 'test',
    governance: 'autonomous',
    isolation: 'none',
    onCompletion: 'stop',
  };

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'fd-orch-spec-'));
    specsDir = join(tmpDir, 'specs');
    mkdirSync(specsDir, { recursive: true });
    store = new SqliteStore(join(tmpDir, 'test.sqlite'));
    dag = new TaskDAG(store);
    const adapter = new AcpAdapter();
    const gov = new GovernanceEngine(config);
    const specStore = new SpecStore(specsDir);
    orch = new Orchestrator(dag, store, gov, adapter, config, undefined, {
      specStore,
    });
  });

  afterEach(() => {
    orch.stop();
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('detects spec changes and marks tasks stale during tick', async () => {
    // Create spec and task
    writeFileSync(join(specsDir, 'auth.md'), '# Auth\nVersion 1');
    dag.addTask({ title: 'Implement auth', specId: makeSpecId('auth.md') });

    // First tick: seeds the hash (new spec, no stale marking)
    let result = await orch.tick();
    expect(result.specChangesDetected).toBe(1);
    expect(result.tasksMarkedStale).toBe(0); // new specs don't mark stale

    // Modify spec
    writeFileSync(join(specsDir, 'auth.md'), '# Auth\nVersion 2 — changed requirements');

    // Second tick: detects change and marks tasks stale
    result = await orch.tick();
    expect(result.specChangesDetected).toBe(1);
    expect(result.tasksMarkedStale).toBe(1);

    // Verify task is stale
    const tasks = dag.listTasks();
    expect(tasks[0].stale).toBe(true);
  });

  it('getRecentSpecChanges returns change history', async () => {
    writeFileSync(join(specsDir, 'auth.md'), '# Auth\nV1');
    await orch.tick();

    writeFileSync(join(specsDir, 'auth.md'), '# Auth\nV2');
    await orch.tick();

    const changes = orch.getRecentSpecChanges();
    expect(changes.length).toBeGreaterThanOrEqual(1);
    expect(changes[0].filename).toBe('auth.md');
  });
});
