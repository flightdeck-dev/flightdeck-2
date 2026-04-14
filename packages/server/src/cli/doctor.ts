/**
 * `flightdeck doctor` — diagnostic checks for Flightdeck setup.
 *
 * Checks: Node.js version, pnpm, project config, database, providers,
 * gateway status, MCP server, agent status, disk usage, config validation.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { FD_HOME } from './constants.js';

interface CheckResult {
  name: string;
  status: 'pass' | 'warn' | 'fail';
  message: string;
  detail?: string;
}

interface ProviderResult {
  id: string;
  name: string;
  installed: boolean;
  version?: string;
}

interface DoctorReport {
  checks: CheckResult[];
  providers: ProviderResult[];
  warnings: string[];
  errors: string[];
  summary: { passed: number; warnings: number; errors: number };
}

const FD_DIR = FD_HOME;
const PID_FILE = join(FD_DIR, 'gateway.pid');
const PORT_FILE = join(FD_DIR, 'gateway.port');

function runCmd(cmd: string, args: string[]): string | null {
  try {
    return execFileSync(cmd, args, { stdio: 'pipe', timeout: 5000 }).toString().trim();
  } catch {
    return null;
  }
}

function checkBinary(cmd: string): boolean {
  return runCmd('which', [cmd]) !== null;
}

function checkNodeVersion(): CheckResult {
  const version = process.version; // e.g. v20.11.0
  const major = parseInt(version.slice(1).split('.')[0], 10);
  if (major >= 20) {
    return { name: 'Node.js', status: 'pass', message: `Node.js ${version} (>= 20 required)` };
  }
  return { name: 'Node.js', status: 'fail', message: `Node.js ${version} — version >= 20 required` };
}

function checkPnpm(): CheckResult {
  const version = runCmd('pnpm', ['--version']);
  if (version) {
    return { name: 'pnpm', status: 'pass', message: `pnpm ${version}` };
  }
  return { name: 'pnpm', status: 'fail', message: 'pnpm not found (install: https://pnpm.io)' };
}

function checkProjectConfig(cwd: string): CheckResult {
  const configPath = join(cwd, '.flightdeck.json');
  if (!existsSync(configPath)) {
    return { name: 'Project config', status: 'warn', message: 'No .flightdeck.json found in current directory' };
  }
  try {
    const data = JSON.parse(readFileSync(configPath, 'utf-8'));
    if (!data.project) {
      return { name: 'Project config', status: 'fail', message: '.flightdeck.json missing "project" field' };
    }
    return { name: 'Project config', status: 'pass', message: `Project: ${data.project} (.flightdeck.json valid)` };
  } catch (e) {
    return { name: 'Project config', status: 'fail', message: `.flightdeck.json invalid JSON: ${e}` };
  }
}

function checkDatabase(projectName: string | null): CheckResult {
  if (!projectName) {
    return { name: 'Database', status: 'warn', message: 'No project — skipping database check' };
  }
  const dbPath = join(FD_DIR, 'projects', projectName, 'state.sqlite');
  if (!existsSync(dbPath)) {
    return { name: 'Database', status: 'warn', message: `Database not found at ${dbPath}` };
  }
  try {
    const stat = statSync(dbPath);
    const sizeMB = (stat.size / 1024 / 1024).toFixed(1);
    // Try integrity check via sqlite3 CLI
    const integrity = runCmd('sqlite3', [dbPath, 'PRAGMA integrity_check;']);
    if (integrity && integrity !== 'ok') {
      return { name: 'Database', status: 'fail', message: `Database corrupt: ${integrity}`, detail: `Size: ${sizeMB} MB` };
    }
    // Count tasks and agents
    const taskCount = runCmd('sqlite3', [dbPath, 'SELECT COUNT(*) FROM tasks;']) || '?';
    const agentCount = runCmd('sqlite3', [dbPath, 'SELECT COUNT(*) FROM agents;']) || '?';
    return {
      name: 'Database',
      status: 'pass',
      message: `Database: ${taskCount} tasks, ${agentCount} agents, ${sizeMB} MB`,
    };
  } catch (e) {
    return { name: 'Database', status: 'fail', message: `Database error: ${e}` };
  }
}

function checkGateway(): CheckResult {
  if (!existsSync(PID_FILE)) {
    return { name: 'Gateway', status: 'warn', message: 'Gateway not running (no PID file)' };
  }
  const pid = parseInt(readFileSync(PID_FILE, 'utf-8').trim(), 10);
  if (isNaN(pid)) {
    return { name: 'Gateway', status: 'fail', message: 'Gateway PID file corrupt' };
  }
  // Check if process is alive
  try {
    process.kill(pid, 0);
  } catch {
    return { name: 'Gateway', status: 'warn', message: `Gateway PID ${pid} not running (stale PID file)` };
  }
  const port = existsSync(PORT_FILE) ? readFileSync(PORT_FILE, 'utf-8').trim() : '18800';
  return { name: 'Gateway', status: 'pass', message: `Gateway: running on port ${port} (PID ${pid})` };
}

function checkMcpServer(): CheckResult {
  const version = runCmd('npx', ['flightdeck-mcp', '--version']);
  if (version) {
    return { name: 'MCP server', status: 'pass', message: `MCP server: flightdeck-mcp ${version}` };
  }
  // Check if the binary exists at all
  if (checkBinary('flightdeck-mcp')) {
    return { name: 'MCP server', status: 'warn', message: 'flightdeck-mcp found but --version failed' };
  }
  return { name: 'MCP server', status: 'warn', message: 'flightdeck-mcp not found (install: npm i -g @flightdeck-ai/flightdeck)' };
}

function checkProviders(): ProviderResult[] {
  const providers: Array<{ id: string; name: string; commands: string[] }> = [
    { id: 'copilot', name: 'GitHub Copilot', commands: ['copilot', 'github-copilot'] },
    { id: 'claude', name: 'Claude Code', commands: ['claude'] },
    { id: 'cursor', name: 'Cursor', commands: ['cursor'] },
    { id: 'codex', name: 'Codex CLI', commands: ['codex-acp'] },
    { id: 'gemini', name: 'Gemini CLI', commands: ['gemini'] },
    { id: 'opencode', name: 'OpenCode', commands: ['opencode'] },
    { id: 'hermes', name: 'Hermes', commands: ['hermes'] },
    { id: 'kiro', name: 'Kiro', commands: ['kiro'] },
    { id: 'kilocode', name: 'Kilocode', commands: ['kilocode'] },
  ];

  return providers.map(p => {
    for (const cmd of p.commands) {
      if (checkBinary(cmd)) {
        const rawVersion = runCmd(cmd, ['--version']);
        // Extract just the first line / version number
        const version = rawVersion ? rawVersion.split('\n')[0].trim() : undefined;
        return { id: p.id, name: p.name, installed: true, version };
      }
    }
    return { id: p.id, name: p.name, installed: false };
  });
}

function checkAgentStatus(projectName: string | null): CheckResult {
  if (!projectName) {
    return { name: 'Agent status', status: 'warn', message: 'No project — skipping agent check' };
  }
  const dbPath = join(FD_DIR, 'projects', projectName, 'state.sqlite');
  if (!existsSync(dbPath)) {
    return { name: 'Agent status', status: 'warn', message: 'No database — skipping agent check' };
  }
  const stuck = runCmd('sqlite3', [dbPath, "SELECT COUNT(*) FROM agents WHERE status = 'working' AND updated_at < datetime('now', '-1 hour');"]);
  const stuckCount = stuck ? parseInt(stuck, 10) : 0;
  if (stuckCount > 0) {
    return { name: 'Agent status', status: 'warn', message: `${stuckCount} agent(s) possibly stuck (working > 1 hour)` };
  }
  return { name: 'Agent status', status: 'pass', message: 'No stuck agents detected' };
}

function checkDiskUsage(projectName: string | null): CheckResult {
  if (!projectName) {
    return { name: 'Disk usage', status: 'warn', message: 'No project — skipping disk check' };
  }
  const projectDir = join(FD_DIR, 'projects', projectName);
  if (!existsSync(projectDir)) {
    return { name: 'Disk usage', status: 'warn', message: `Project directory not found: ${projectDir}` };
  }

  // DB size
  const dbPath = join(projectDir, 'state.sqlite');
  let dbSize = 'N/A';
  if (existsSync(dbPath)) {
    dbSize = (statSync(dbPath).size / 1024 / 1024).toFixed(1) + ' MB';
  }

  // Count worktrees
  let worktreeCount = 0;
  const worktreeDir = join(projectDir, 'worktrees');
  if (existsSync(worktreeDir)) {
    try { worktreeCount = readdirSync(worktreeDir).length; } catch { /* ignore */ }
  }

  return { name: 'Disk usage', status: 'pass', message: `DB: ${dbSize}, Worktrees: ${worktreeCount}` };
}

function checkConfigValidation(cwd: string): CheckResult {
  const configDir = join(cwd, '.flightdeck');
  const issues: string[] = [];

  // Check governance.yaml
  const govPath = join(configDir, 'governance.yaml');
  if (existsSync(govPath)) {
    try {
      readFileSync(govPath, 'utf-8');
      // Basic YAML parse check — we just verify it's readable
    } catch (e) {
      issues.push(`governance.yaml unreadable: ${e}`);
    }
  }

  // Check workflow.yaml
  const wfPath = join(configDir, 'workflow.yaml');
  if (existsSync(wfPath)) {
    try {
      readFileSync(wfPath, 'utf-8');
    } catch (e) {
      issues.push(`workflow.yaml unreadable: ${e}`);
    }
  }

  // Check config.yaml
  const cfgPath = join(configDir, 'config.yaml');
  if (existsSync(cfgPath)) {
    try {
      readFileSync(cfgPath, 'utf-8');
    } catch (e) {
      issues.push(`config.yaml unreadable: ${e}`);
    }
  }

  if (!existsSync(configDir)) {
    return { name: 'Config validation', status: 'warn', message: 'No .flightdeck/ config directory found' };
  }

  if (issues.length > 0) {
    return { name: 'Config validation', status: 'fail', message: issues.join('; ') };
  }
  return { name: 'Config validation', status: 'pass', message: 'Config files readable' };
}

function getProjectName(cwd: string): string | null {
  const configPath = join(cwd, '.flightdeck.json');
  if (!existsSync(configPath)) return null;
  try {
    const data = JSON.parse(readFileSync(configPath, 'utf-8'));
    return data.project || null;
  } catch {
    return null;
  }
}

export async function runDoctor(opts: { json?: boolean; cwd?: string }): Promise<void> {
  const cwd = opts.cwd || process.cwd();
  const projectName = getProjectName(cwd);

  const checks: CheckResult[] = [
    checkNodeVersion(),
    checkPnpm(),
    checkProjectConfig(cwd),
    checkDatabase(projectName),
    checkGateway(),
    checkMcpServer(),
    checkAgentStatus(projectName),
    checkDiskUsage(projectName),
    checkConfigValidation(cwd),
  ];

  const providers = checkProviders();

  const warnings = checks.filter(c => c.status === 'warn').map(c => c.message);
  const errors = checks.filter(c => c.status === 'fail').map(c => c.message);
  const passed = checks.filter(c => c.status === 'pass').length;

  const report: DoctorReport = {
    checks,
    providers,
    warnings,
    errors,
    summary: { passed, warnings: warnings.length, errors: errors.length },
  };

  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printReport(report, providers);
  }

  process.exitCode = errors.length > 0 ? 1 : 0;
}

function printReport(report: DoctorReport, providers: ProviderResult[]): void {
  const icon = (status: 'pass' | 'warn' | 'fail') =>
    status === 'pass' ? '✅' : status === 'warn' ? '⚠️ ' : '❌';

  console.log('\nFlightdeck Doctor');
  console.log('=================\n');

  for (const c of report.checks) {
    console.log(`${icon(c.status)} ${c.message}`);
  }

  console.log('\nProviders:');
  for (const p of providers) {
    if (p.installed) {
      const ver = p.version ? ` (${p.version})` : '';
      console.log(`  ✅ ${p.id}${ver}`);
    } else {
      console.log(`  ❌ ${p.id} — not found`);
    }
  }

  if (report.warnings.length > 0) {
    console.log('\n⚠️  Warnings:');
    for (const w of report.warnings) {
      console.log(`  - ${w}`);
    }
  }

  if (report.errors.length > 0) {
    console.log('\n❌ Errors:');
    for (const e of report.errors) {
      console.log(`  - ${e}`);
    }
  }

  const { passed, warnings, errors } = report.summary;
  console.log(`\nSummary: ${passed} checks passed, ${warnings} warning(s), ${errors} error(s)\n`);
}
