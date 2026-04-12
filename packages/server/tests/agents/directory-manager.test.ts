import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DirectoryManager } from '../../src/agents/DirectoryManager.js';

describe('DirectoryManager (FR-013b)', () => {
  let dm: DirectoryManager;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'fd-dirman-'));
    dm = new DirectoryManager(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates a working directory for a task', () => {
    const { path } = dm.create('task-1');
    expect(existsSync(path)).toBe(true);
    expect(path).toContain('.flightdeck/workdirs/task-1');
  });

  it('lists active workdirs', () => {
    dm.create('task-1');
    dm.create('task-2');
    const list = dm.list();
    expect(list).toContain('task-1');
    expect(list).toContain('task-2');
  });

  it('copies files back to project root', () => {
    const { path } = dm.create('task-1');
    writeFileSync(join(path, 'result.txt'), 'hello');
    dm.copyBack('task-1');
    expect(readFileSync(join(tmpDir, 'result.txt'), 'utf-8')).toBe('hello');
  });

  it('skips .git and node_modules on copyBack', () => {
    const { path } = dm.create('task-1');
    mkdirSync(join(path, '.git'), { recursive: true });
    writeFileSync(join(path, '.git', 'config'), 'x');
    mkdirSync(join(path, 'node_modules'), { recursive: true });
    writeFileSync(join(path, 'node_modules', 'x.js'), 'y');
    writeFileSync(join(path, 'real.txt'), 'data');
    dm.copyBack('task-1');
    expect(existsSync(join(tmpDir, 'real.txt'))).toBe(true);
    expect(existsSync(join(tmpDir, '.git', 'config'))).toBe(false);
    expect(existsSync(join(tmpDir, 'node_modules', 'x.js'))).toBe(false);
  });

  it('removes a workdir', () => {
    const { path } = dm.create('task-1');
    expect(existsSync(path)).toBe(true);
    dm.remove('task-1');
    expect(existsSync(path)).toBe(false);
  });

  it('remove is idempotent', () => {
    dm.remove('nonexistent');
    // Should not throw
  });

  it('returns empty list when no workdirs exist', () => {
    expect(dm.list()).toEqual([]);
  });
});
