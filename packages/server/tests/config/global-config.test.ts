import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('GlobalConfig', () => {
  let tmpDir: string;
  let origHome: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'fd-globalcfg-'));
    origHome = process.env.HOME!;
    process.env.HOME = tmpDir;
  });

  afterEach(() => {
    process.env.HOME = origHome;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('loadGlobalConfig reads config.yaml', async () => {
    const configDir = join(tmpDir, '.flightdeck', 'v2');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'config.yaml'), 'timezone: US/Pacific\n');

    const { loadGlobalConfig } = await import('../../src/config/GlobalConfig.js');
    const config = loadGlobalConfig();
    expect(config.timezone).toBe('US/Pacific');
  });

  it('saveGlobalConfig writes config.yaml', async () => {
    const { saveGlobalConfig, loadGlobalConfig } = await import('../../src/config/GlobalConfig.js');
    saveGlobalConfig({ timezone: 'Europe/Berlin' });
    const config = loadGlobalConfig();
    expect(config.timezone).toBe('Europe/Berlin');
  });

  it('migrates from global-config.json', async () => {
    const configDir = join(tmpDir, '.flightdeck', 'v2');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'global-config.json'), JSON.stringify({ defaultRuntime: 'claude' }));

    const { loadGlobalConfig } = await import('../../src/config/GlobalConfig.js');
    const config = loadGlobalConfig();
    expect(config.defaultRuntime).toBe('claude');
    // Old file should be deleted
    expect(existsSync(join(configDir, 'global-config.json'))).toBe(false);
  });
});
