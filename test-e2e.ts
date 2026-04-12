/**
 * Flightdeck 2.0 — End-to-End ACP Test
 *
 * Spawns a real Copilot CLI agent via AcpAdapter, injects the Flightdeck
 * MCP server, and verifies the agent can call Flightdeck MCP tools.
 *
 * Safety: uses /tmp/fd-e2e-sandbox as cwd, writeTextFile is blocked.
 */
import { AcpAdapter } from './src/agents/AcpAdapter.js';
import { Flightdeck } from './src/facade.js';
import { ProjectStore } from './src/storage/ProjectStore.js';
import type { AgentId, TaskId } from './src/core/types.js';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SANDBOX = '/tmp/fd-e2e-sandbox';
const PROJECT = 'e2e-test';
const MCP_SERVER = path.join(__dirname, 'src', 'mcp', 'server.ts');

async function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms));
}

async function main() {
  console.log('🚀 Flightdeck 2.0 E2E Test');
  console.log('===========================\n');

  // 1. Setup project state
  console.log('1. Setting up project...');
  const fd = new Flightdeck(PROJECT);

  // Register a worker agent
  const workerId = 'worker-copilot-1' as AgentId;
  try {
    fd.sqlite.registerAgent(workerId, 'worker');
    console.log(`   ✅ Registered agent: ${workerId}`);
  } catch {
    console.log(`   ℹ️  Agent ${workerId} already registered`);
  }

  // Create a simple task
  const task = fd.addTask({
    title: 'List project status via MCP',
    description: 'Call flightdeck_status and flightdeck_task_list to verify MCP connectivity. Do NOT modify any files. Report what you find.',
    role: 'worker',
  });
  console.log(`   ✅ Created task: ${task.id} — "${task.title}"`);

  // 2. Setup ACP adapter with Copilot runtime
  console.log('\n2. Creating AcpAdapter (Copilot)...');
  const adapter = new AcpAdapter(
    {
      copilot: {
        command: 'copilot',
        args: ['--acp', '--stdio'],
        adapter: 'acp',
      },
    },
    'copilot',
  );

  // 3. Spawn agent
  console.log('\n3. Spawning Copilot agent via ACP...');
  const systemPrompt = `You are a Flightdeck worker agent.
Your agent ID is: ${workerId}

IMPORTANT RULES:
1. Do NOT modify, create, or delete any files
2. Do NOT run any shell commands that modify the filesystem
3. ONLY use the flightdeck MCP tools to interact with the project

Your task: Call flightdeck_status() and flightdeck_task_list() to check the project state. Then call flightdeck_task_claim() to claim your task, and flightdeck_task_submit() when done. Report what you see.`;

  const meta = await adapter.spawn({
    role: 'worker',
    cwd: SANDBOX,
    systemPrompt,
    model: 'claude-sonnet-4',
    mcpServers: [
      {
        name: 'flightdeck',
        command: '/home/linuxbrew/.linuxbrew/bin/npx',
        args: ['tsx', MCP_SERVER],
        env: {
          FLIGHTDECK_AGENT_ID: workerId,
          PATH: '/home/linuxbrew/.linuxbrew/bin:/usr/local/bin:/usr/bin:/bin',
          HOME: '/home/chuby9726',
        },
      } as any,
    ],
  });

  console.log(`   ✅ Spawned: ${meta.sessionId} (agent: ${meta.agentId})`);
  console.log(`   Status: ${meta.status}`);

  // 4. Monitor the session
  console.log('\n4. Monitoring session (max 120s)...');
  const startTime = Date.now();
  const maxWait = 120_000;
  let lastOutputLen = 0;

  while (Date.now() - startTime < maxWait) {
    await sleep(5000);

    const session = adapter.getSession(meta.sessionId);
    if (!session) {
      console.log('   ❌ Session lost!');
      break;
    }

    const elapsed = Math.round((Date.now() - startTime) / 1000);

    // Print new output if any
    if (session.output.length > lastOutputLen) {
      const newOutput = session.output.slice(lastOutputLen);
      console.log(`   [${elapsed}s] [${session.status}] New output:\n${newOutput.split('\n').map(l => '     ' + l).join('\n')}`);
      lastOutputLen = session.output.length;
    } else {
      console.log(`   [${elapsed}s] [${session.status}] tokens: ${session.tokensIn}/${session.tokensOut}, turns: ${session.turnCount}`);
    }

    if (session.status === 'ended') {
      console.log(`   Session ended (exit code: ${session.exitCode})`);
      if (session.error) {
        console.log(`   Errors: ${session.error.slice(0, 500)}`);
      }
      break;
    }
  }

  // 5. Final status
  console.log('\n5. Final results:');
  const finalSession = adapter.getSession(meta.sessionId);
  if (finalSession) {
    console.log(`   Status: ${finalSession.status}`);
    console.log(`   Exit code: ${finalSession.exitCode}`);
    console.log(`   Turns: ${finalSession.turnCount}`);
    console.log(`   Output length: ${finalSession.output.length} chars`);
    if (finalSession.output) {
      console.log(`\n   === Agent Output ===`);
      console.log(finalSession.output.slice(0, 2000));
      if (finalSession.output.length > 2000) console.log('   ... (truncated)');
    }
    if (finalSession.error) {
      console.log(`\n   === Errors ===`);
      console.log(finalSession.error.slice(0, 1000));
    }
  }

  // Check if task was claimed/submitted
  const finalTask = fd.sqlite.getTask(task.id);
  console.log(`\n   Task state: ${finalTask?.state ?? 'unknown'}`);
  if (finalTask?.state === 'submitted') {
    console.log('   🎉 SUCCESS — Agent completed the MCP round-trip!');
  } else if (finalTask?.state === 'running') {
    console.log('   🟡 PARTIAL — Agent claimed but did not submit');
  } else {
    console.log('   ⚠️  Agent did not interact with the task');
  }

  // Cleanup
  console.log('\n6. Cleanup...');
  adapter.clear();
  console.log('   Done.');
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
