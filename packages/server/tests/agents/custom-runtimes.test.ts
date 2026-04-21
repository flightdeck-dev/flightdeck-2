import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';

// We need to mock loadGlobalConfig before importing runtimes
describe('Custom runtimes', () => {
  let tmpDir: string;
  let origHome: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'fd-runtimes-'));
    origHome = process.env.HOME!;
  });

  afterEach(() => {
    process.env.HOME = origHome;
    rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('loadCustomRuntimes loads from config and cleans up on reload', async () => {
    // Set up fake home with config.yaml containing custom runtimes
    const fakeHome = tmpDir;
    const configDir = join(fakeHome, '.flightdeck', 'v2');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'config.yaml'), `
customRuntimes:
  my-custom:
    name: My Custom Runtime
    command: my-custom-cmd
    args: ["--flag"]
`);
    process.env.HOME = fakeHome;

    // Dynamically import to get fresh module state
    const { RUNTIME_REGISTRY, loadCustomRuntimes } = await import('../../src/agents/runtimes.js');

    // Verify built-in runtimes exist
    const builtInKeys = Object.keys(RUNTIME_REGISTRY);
    expect(builtInKeys.length).toBeGreaterThan(0);

    loadCustomRuntimes();
    expect(RUNTIME_REGISTRY['my-custom']).toBeDefined();
    expect(RUNTIME_REGISTRY['my-custom'].name).toBe('My Custom Runtime');
    expect(RUNTIME_REGISTRY['my-custom'].command).toBe('my-custom-cmd');

    // Built-in runtimes still present
    for (const key of builtInKeys) {
      expect(RUNTIME_REGISTRY[key]).toBeDefined();
    }

    // Reload with empty config clears custom runtimes
    writeFileSync(join(configDir, 'config.yaml'), '{}');
    loadCustomRuntimes();
    expect(RUNTIME_REGISTRY['my-custom']).toBeUndefined();

    // Built-in runtimes still present after reload
    for (const key of builtInKeys) {
      expect(RUNTIME_REGISTRY[key]).toBeDefined();
    }
  });
});
