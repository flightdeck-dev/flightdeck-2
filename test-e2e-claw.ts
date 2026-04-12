/**
 * Flightdeck 2.0 E2E Test — Claw as supervisor
 *
 * Tests: spawn lead, steer lead, lead spawns worker, worker claims task
 */

import { Flightdeck } from './packages/server/src/facade.ts';
import { AcpAdapter } from './packages/server/src/agents/AcpAdapter.ts';
import { LeadManager } from './packages/server/src/lead/LeadManager.ts';

const PROJECT = 'e2e-test';
const CWD = '/tmp/flightdeck-e2e-test';

async function main() {
  console.log('=== Flightdeck 2.0 E2E Test ===\n');

  // 1. Init
  const fd = new Flightdeck(PROJECT);
  console.log('1. Project loaded:', fd.status().config.name);
  console.log('   Tasks:', JSON.stringify(fd.status().taskStats));

  // Mark any stale agents offline
  const staleAgents = fd.listAgents().filter(a => a.status === 'busy' || a.status === 'idle');
  for (const a of staleAgents) {
    fd.sqlite.updateAgentStatus(a.id as any, 'offline');
    console.log(`   Cleaned stale agent: ${a.id}`);
  }

  // 2. Create ACP adapter and LeadManager
  const acpAdapter = new AcpAdapter(undefined, 'copilot');
  const leadManager = new LeadManager({
    sqlite: fd.sqlite,
    project: fd.project,
    acpAdapter,
  });

  // 3. Spawn Lead
  console.log('\n2. Spawning Lead agent...');
  try {
    const leadSessionId = await leadManager.spawnLead();
    console.log(`   Lead spawned: ${leadSessionId}`);
  } catch (err: any) {
    console.error(`   Failed to spawn Lead: ${err.message}`);
    process.exit(1);
  }

  // Wait for Lead to initialize
  await sleep(5000);

  // 4. Check agent status
  const agents = fd.listAgents();
  console.log('\n3. Agent roster:');
  for (const a of agents) {
    if (a.status !== 'offline') {
      console.log(`   [${a.status}] ${a.id} (${a.role})`);
    }
  }

  // 5. Steer Lead — ask it to check status and claim a task
  console.log('\n4. Steering Lead: "Check project status and list ready tasks"...');
  try {
    const response = await leadManager.steerLead({
      type: 'user_message',
      message: {
        content: 'Check the project status using flightdeck_status and list ready tasks using flightdeck_task_list. Report what you find. Do NOT create or modify any files.',
        authorType: 'human',
        authorId: 'claw',
      }
    });
    console.log(`   Lead response (first 500 chars): ${response?.slice(0, 500)}`);
  } catch (err: any) {
    console.error(`   Steer failed: ${err.message}`);
  }

  // Wait for Lead to process
  await sleep(10000);

  // 6. Check updated status
  console.log('\n5. Updated status:');
  console.log('   Tasks:', JSON.stringify(fd.status().taskStats));
  const updatedAgents = fd.listAgents().filter(a => a.status !== 'offline');
  for (const a of updatedAgents) {
    console.log(`   [${a.status}] ${a.id} (${a.role})`);
  }

  // 7. Steer Lead — ask it to spawn a worker for a safe task
  console.log('\n6. Steering Lead: "Spawn a worker to list files"...');
  try {
    const response2 = await leadManager.steerLead({
      type: 'user_message',
      message: {
        content: `Spawn a worker agent to handle the "List all files in the project directory" task. The worker should work in ${CWD}. Do NOT let the worker create or modify any files — only read and report.`,
        authorType: 'human',
        authorId: 'claw',
      }
    });
    console.log(`   Lead response (first 500 chars): ${response2?.slice(0, 500)}`);
  } catch (err: any) {
    console.error(`   Steer failed: ${err.message}`);
  }

  // Wait for worker to do work
  await sleep(15000);

  // 8. Final status
  console.log('\n7. Final status:');
  console.log('   Tasks:', JSON.stringify(fd.status().taskStats));
  const finalAgents = fd.listAgents().filter(a => a.status !== 'offline');
  for (const a of finalAgents) {
    console.log(`   [${a.status}] ${a.id} (${a.role})`);
  }

  // 9. Read messages
  const messages = fd.readMessages('general');
  if (messages.length > 0) {
    console.log('\n8. Messages:');
    for (const m of messages.slice(-5)) {
      console.log(`   [${m.from}] ${m.content.slice(0, 100)}`);
    }
  }

  // Cleanup
  console.log('\n=== Cleaning up ===');
  leadManager.stop();
  acpAdapter.clear();
  fd.close();
  console.log('Done.');
  process.exit(0);
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
