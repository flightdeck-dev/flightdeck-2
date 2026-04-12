/**
 * Lightweight Flightdeck 2.0 task management test
 * Only spawns ONE copilot agent (worker) to save memory
 */
import { Flightdeck } from './packages/server/src/facade.ts';
import { AcpAdapter } from './packages/server/src/agents/AcpAdapter.ts';
import type { AgentRole } from '@flightdeck-ai/shared';

const PROJECT = 'mini-calc';
const CWD = '/tmp/fd-miniproject';

async function main() {
  console.log('=== Task Management E2E ===\n');

  const fd = new Flightdeck(PROJECT);
  
  // Clean stale agents
  for (const a of fd.listAgents()) {
    if (a.status === 'busy' || a.status === 'idle') {
      fd.sqlite.updateAgentStatus(a.id as any, 'offline');
    }
  }

  // Create tasks via Flightdeck API
  console.log('1. Creating tasks...');
  const t1 = fd.addTask({ title: 'Create calc.py with basic arithmetic', description: 'Python CLI calculator: two args + operator, handle div by zero', role: 'worker' as AgentRole });
  const t2 = fd.addTask({ title: 'Write test_calc.py', description: 'Test all operators and edge cases', role: 'worker' as AgentRole, dependsOn: [t1.id] });
  console.log(`   Created: ${t1.id} (${t1.title}) [${t1.state}]`);
  console.log(`   Created: ${t2.id} (${t2.title}) [${t2.state}] depends on ${t1.id}`);

  // Spawn ONE worker via ACP
  console.log('\n2. Spawning worker agent...');
  const acpAdapter = new AcpAdapter(undefined, 'copilot');
  
  const meta = await acpAdapter.spawn({
    role: 'worker',
    cwd: CWD,
  });
  console.log(`   Worker spawned: ${meta.agentId} (session: ${meta.sessionId})`);
  
  // Register in SQLite
  fd.sqlite.insertAgent({
    id: meta.agentId as any,
    role: 'worker',
    runtime: 'acp',
    acpSessionId: meta.sessionId,
    status: 'busy',
    currentSpecId: null,
    costAccumulated: 0,
    lastHeartbeat: null,
  });

  // Wait for init
  await sleep(8000);

  // Test 1: Worker checks status
  console.log('\n3. Worker: check status via MCP...');
  const r1 = await acpAdapter.steer(meta.sessionId, {
    content: `You are agent "${meta.agentId}" (a worker). Call flightdeck_status() and flightdeck_task_list() to see the project. Report what you find. agentId is "${meta.agentId}".`
  });
  console.log(`   Response: ${r1.slice(0, 500)}`);

  // Test 2: Worker claims task
  console.log('\n4. Worker: claim first task...');
  const r2 = await acpAdapter.steer(meta.sessionId, {
    content: `Claim task "${t1.id}" using flightdeck_task_claim with taskId="${t1.id}" and agentId="${meta.agentId}". Then implement it: create calc.py in /tmp/fd-miniproject/ that takes 3 CLI args (num1 operator num2) and prints the result. Handle division by zero. Then submit the task with flightdeck_task_submit.`
  });
  console.log(`   Response: ${r2.slice(0, 500)}`);

  // Check file was created
  const { existsSync } = await import('fs');
  console.log(`\n5. File check: calc.py exists? ${existsSync('/tmp/fd-miniproject/calc.py')}`);

  // Test 3: Check task states
  console.log('\n6. Final task states:');
  const tasks = fd.listTasks();
  for (const t of tasks) {
    console.log(`   [${t.state.padEnd(10)}] ${t.id} — ${t.title}`);
  }

  // Cleanup
  console.log('\n=== Cleanup ===');
  acpAdapter.clear();
  fd.close();
  await sleep(2000);
  console.log('Done.');
  process.exit(0);
}

function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms));
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
