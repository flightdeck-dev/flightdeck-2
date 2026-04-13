/**
 * Flightdeck 2.0 — Lead-only E2E Test
 * 
 * Tests: spawn copilot as Lead → steer with user message → Lead calls MCP tools
 * Lead has NO file/shell tools — only Flightdeck MCP tools.
 */

import { AcpAdapter } from './packages/server/src/agents/AcpAdapter.ts';

const CWD = '/tmp/flightdeck-e2e-test';

// Ensure project config exists
import * as fs from 'node:fs';
fs.mkdirSync(`${CWD}/.flightdeck`, { recursive: true });
fs.writeFileSync(`${CWD}/.flightdeck/project.json`, JSON.stringify({
  name: 'e2e-test',
  description: 'E2E test project',
  cwd: CWD,
}));

async function main() {
  console.log('=== Flightdeck 2.0 Lead E2E Test ===\n');
  console.log(`Memory: ${Math.round(process.memoryUsage.rss() / 1024 / 1024)}MB RSS`);

  // 1. Create ACP adapter targeting copilot
  const acpAdapter = new AcpAdapter(undefined, 'copilot');
  console.log('1. ACP adapter created (copilot runtime)\n');

  // 2. Spawn Lead — no file/shell tools, only Flightdeck MCP
  console.log('2. Spawning Lead agent...');
  const leadPrompt = `You are the Lead agent for project "e2e-test". 
Your ONLY tools are the Flightdeck MCP tools (flightdeck_status, flightdeck_task_list, etc).
Do NOT create, modify, or delete any files. Do NOT run shell commands.
Only use Flightdeck tools to check project status and manage tasks.`;

  const meta = await acpAdapter.spawn({
    role: 'lead',
    cwd: CWD,
    systemPrompt: leadPrompt,
  });
  console.log(`   Lead spawned: ${meta.sessionId} (agent: ${meta.agentId})`);

  // Wait for ACP init + initial prompt to complete
  console.log('   Waiting for initialization...');
  await waitForActive(acpAdapter, meta.sessionId, 120_000);
  console.log(`   Lead is active. Memory: ${Math.round(process.memoryUsage.rss() / 1024 / 1024)}MB\n`);

  // 3. Steer Lead — ask it to check status
  console.log('3. Steering Lead: "Check project status"...');
  const t0 = Date.now();
  const response = await acpAdapter.steer(meta.sessionId, {
    content: 'Check the project status using flightdeck_status. Report what you find.',
  });
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`   Response (${elapsed}s, ${response.length} chars):`);
  console.log(`   ${response.slice(0, 800)}`);
  console.log();

  // 4. Check session metadata
  const metadata = await acpAdapter.getMetadata(meta.sessionId);
  console.log('4. Session metadata:', JSON.stringify(metadata, null, 2));
  console.log();

  // 5. Second steer — list tasks
  console.log('5. Steering Lead: "List ready tasks"...');
  const t1 = Date.now();
  const response2 = await acpAdapter.steer(meta.sessionId, {
    content: 'List all tasks using flightdeck_task_list and tell me which are ready.',
  });
  const elapsed2 = ((Date.now() - t1) / 1000).toFixed(1);
  console.log(`   Response (${elapsed2}s, ${response2.length} chars):`);
  console.log(`   ${response2.slice(0, 800)}`);
  console.log();

  // 6. Cleanup
  console.log('6. Cleaning up...');
  await acpAdapter.kill(meta.sessionId);
  acpAdapter.clear();
  console.log('   Done.\n');

  console.log(`=== Final memory: ${Math.round(process.memoryUsage.rss() / 1024 / 1024)}MB ===`);
  process.exit(0);
}

async function waitForActive(adapter: AcpAdapter, sessionId: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const session = adapter.getSession(sessionId);
    if (!session) throw new Error('Session disappeared');
    if (session.status === 'active') return;
    if (session.status === 'ended') {
      throw new Error(`Session ended prematurely. Exit: ${session.exitCode}, Error: ${session.error?.slice(0, 500)}`);
    }
    await new Promise(r => setTimeout(r, 500));
  }
  const session = adapter.getSession(sessionId);
  throw new Error(`Timeout waiting for active. Status: ${session?.status}, Error: ${session?.error?.slice(0, 500)}`);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
