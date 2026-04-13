/**
 * Flightdeck 2.0 — Lead + Worker E2E Collaboration Test
 *
 * Full flow:
 * 1. Spawn Lead via AcpAdapter (gets Flightdeck MCP tools)
 * 2. Steer Lead: "Check status and plan work"
 * 3. Spawn Worker via AcpAdapter (gets Flightdeck MCP tools)
 * 4. Steer Worker: "Claim a task and complete it"
 * 5. Steer Lead: "Check for completed tasks and report"
 * 6. Verify task state transitions in SQLite
 */

import { AcpAdapter } from './packages/server/src/agents/AcpAdapter.ts';
import { Flightdeck } from './packages/server/src/facade.ts';
import { agentId } from './packages/server/src/core/ids.ts';
import * as fs from 'node:fs';

const PROJECT = `e2e-collab-${Date.now().toString(36)}`;
const CWD = '/tmp/flightdeck-e2e-collab';

// ── Setup ──

function setup() {
  fs.mkdirSync(CWD, { recursive: true });
  fs.writeFileSync(`${CWD}/.flightdeck.json`, JSON.stringify({ project: PROJECT }));
  fs.writeFileSync(`${CWD}/README.md`, '# E2E Collaboration Test\nThis is a test project.');
  fs.writeFileSync(`${CWD}/hello.txt`, 'Hello from the test project!');

  // Initialize project + add tasks
  const fd = new Flightdeck(PROJECT);

  // Clean slate
  fd.sqlite.purgeOfflineAgents();

  // Add test tasks
  fd.addTask({
    title: 'Report project file listing',
    description: 'Use flightdeck_status to check the project, then report back with a summary. Do NOT modify any files.',
  });
  fd.addTask({
    title: 'Count files in the project',
    description: 'List and count all files in the project directory. Report the count via flightdeck_task_submit.',
  });

  const status = fd.status();
  console.log(`Project "${PROJECT}" initialized: ${JSON.stringify(status.taskStats)}`);
  fd.close();
}

// ── Helpers ──

async function waitForActive(adapter: AcpAdapter, sessionId: string, label: string, timeoutMs = 180_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const session = adapter.getSession(sessionId);
    if (!session) throw new Error(`${label}: Session disappeared`);
    if (session.status === 'active') return;
    if (session.status === 'ended') {
      throw new Error(`${label}: Session ended. Exit: ${session.exitCode}, Error: ${session.error?.slice(0, 500)}`);
    }
    await sleep(500);
  }
  const session = adapter.getSession(sessionId);
  throw new Error(`${label}: Timeout. Status: ${session?.status}, Error: ${session?.error?.slice(0, 500)}`);
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function memMB(): number {
  return Math.round(process.memoryUsage.rss() / 1024 / 1024);
}

// ── Main ──

async function main() {
  console.log('=== Flightdeck 2.0 — Lead + Worker Collaboration E2E ===\n');
  console.log(`Memory: ${memMB()}MB`);

  setup();

  const acpAdapter = new AcpAdapter(undefined, 'copilot');

  // ── 1. Spawn Lead ──
  console.log('\n── Step 1: Spawn Lead ──');
  const leadId = agentId('lead', Date.now().toString());

  // Register Lead in SQLite so MCP tools can find it
  const fd = new Flightdeck(PROJECT);
  fd.sqlite.insertAgent({
    id: leadId,
    role: 'lead',
    runtime: 'acp',
    acpSessionId: null,
    status: 'busy',
    currentSpecId: null,
    costAccumulated: 0,
    lastHeartbeat: null,
  });

  const leadMeta = await acpAdapter.spawn({
    role: 'lead',
    cwd: CWD,
    projectName: PROJECT,
    systemPrompt: `You are a Lead agent. Your agent ID is ${leadId}. Always pass agentId="${leadId}" to flightdeck_ tools. Only use flightdeck MCP tools. Do not modify files.`,
  });
  console.log(`   Lead spawned: ${leadMeta.sessionId} (agent: ${leadMeta.agentId})`);

  // Update SQLite with real session ID
  fd.sqlite.updateAgentAcpSession(leadId, leadMeta.sessionId);

  await waitForActive(acpAdapter, leadMeta.sessionId, 'Lead');
  console.log(`   Lead active. Memory: ${memMB()}MB`);

  // ── 2. Steer Lead: check status ──
  console.log('\n── Step 2: Lead checks project status ──');
  const t0 = Date.now();
  const leadResp1 = await acpAdapter.steer(leadMeta.sessionId, {
    content: `Check the project status using flightdeck_status (pass agentId="${leadId}") and list tasks using flightdeck_task_list (pass agentId="${leadId}"). Report what you find.`,
  });
  console.log(`   Response (${((Date.now() - t0) / 1000).toFixed(1)}s):`);
  console.log(`   ${leadResp1.slice(0, 600)}\n`);

  // ── 3. Spawn Worker ──
  console.log('── Step 3: Spawn Worker ──');
  const workerId = agentId('worker', Date.now().toString());
  fd.sqlite.insertAgent({
    id: workerId,
    role: 'worker',
    runtime: 'acp',
    acpSessionId: null,
    status: 'busy',
    currentSpecId: null,
    costAccumulated: 0,
    lastHeartbeat: null,
  });

  const workerMeta = await acpAdapter.spawn({
    role: 'worker',
    cwd: CWD,
    projectName: PROJECT,
    systemPrompt: `You are a Worker agent. Your agent ID is ${workerId}. Always pass agentId="${workerId}" to flightdeck_ tools. Claim a ready task, do the work, then submit.`,
  });
  console.log(`   Worker spawned: ${workerMeta.sessionId} (agent: ${workerMeta.agentId})`);
  fd.sqlite.updateAgentAcpSession(workerId, workerMeta.sessionId);

  await waitForActive(acpAdapter, workerMeta.sessionId, 'Worker');
  console.log(`   Worker active. Memory: ${memMB()}MB`);

  // ── 4. Steer Worker: claim and complete a task ──
  console.log('\n── Step 4: Worker claims and completes a task ──');
  const t1 = Date.now();
  const workerResp = await acpAdapter.steer(workerMeta.sessionId, {
    content: `List tasks with flightdeck_task_list (agentId="${workerId}"), claim one ready task with flightdeck_task_claim, then submit it with flightdeck_task_submit including a brief summary. Do NOT create or modify files.`,
  });
  console.log(`   Response (${((Date.now() - t1) / 1000).toFixed(1)}s):`);
  console.log(`   ${workerResp.slice(0, 800)}\n`);

  // ── 5. Check task state in SQLite ──
  console.log('── Step 5: Verify task states ──');
  const tasks = fd.sqlite.listTasks();
  for (const t of tasks) {
    console.log(`   [${t.state}] ${t.id}: ${t.title}`);
  }

  const doneOrReview = tasks.filter(t => t.state === 'done' || t.state === 'in_review');
  console.log(`\n   Tasks done/in_review: ${doneOrReview.length}`);

  // ── 6. Steer Lead: review completed work ──
  console.log('\n── Step 6: Lead reviews completed work ──');
  const t2 = Date.now();
  const leadResp2 = await acpAdapter.steer(leadMeta.sessionId, {
    content: `Check project status again using flightdeck_status (agentId="${leadId}") and flightdeck_task_list (agentId="${leadId}"). Report on any tasks that moved from ready to in_review or done.`,
  });
  console.log(`   Response (${((Date.now() - t2) / 1000).toFixed(1)}s):`);
  console.log(`   ${leadResp2.slice(0, 800)}\n`);

  // ── 7. Final state ──
  console.log('── Step 7: Final state ──');
  const finalTasks = fd.sqlite.listTasks();
  const finalAgents = fd.sqlite.listAgents();
  console.log(`   Tasks: ${JSON.stringify(fd.status().taskStats)}`);
  console.log(`   Agents: ${finalAgents.length}`);
  for (const a of finalAgents) {
    console.log(`     [${a.status}] ${a.id} (${a.role})`);
  }

  // ── Cleanup ──
  console.log('\n── Cleanup ──');
  await acpAdapter.kill(leadMeta.sessionId);
  await acpAdapter.kill(workerMeta.sessionId);
  acpAdapter.clear();
  fd.close();
  console.log(`   Done. Final memory: ${memMB()}MB`);

  // ── Verdict ──
  const passed = doneOrReview.length >= 1;
  console.log(`\n=== ${passed ? '✅ PASS' : '❌ FAIL'}: Worker ${passed ? 'completed' : 'did NOT complete'} at least 1 task ===`);
  process.exit(passed ? 0 : 1);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
