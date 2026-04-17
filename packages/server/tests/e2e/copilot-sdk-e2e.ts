/**
 * E2E test: CopilotSdkAdapter with real gateway
 *
 * Requires: daemon running on localhost:18800 with 'default' project
 */
import { CopilotSdkAdapter } from '../../src/agents/CopilotSdkAdapter.js';

async function main() {
  console.log('Creating adapter...');
  const adapter = new CopilotSdkAdapter({
    gatewayUrl: 'http://localhost:18800',
  });

  // Create a task via HTTP
  console.log('Creating task...');
  const taskRes = await fetch('http://localhost:18800/api/projects/default/tasks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: 'SDK E2E test',
      description: 'Create a file called sdk-test.txt with: Hello from CopilotSdkAdapter',
    }),
  });
  const task = await taskRes.json() as any;
  console.log(`Task: ${task.id}`);

  // Register the agent in DB
  await fetch('http://localhost:18800/api/projects/default/agents/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'worker-sdk-test', role: 'worker', status: 'idle' }),
  });

  console.log('Spawning agent...');
  const { agentId, sessionId } = await adapter.spawn({
    agentId: 'worker-sdk-test',
    role: 'worker',
    cwd: '/tmp/fd-e2e-test',
    projectName: 'default',
    systemPrompt: `You are a worker agent. Use flightdeck_task_list to find tasks, flightdeck_task_claim to claim one, do the work, then flightdeck_task_submit to submit.`,
  });

  console.log(`Agent: ${agentId} Session: ${sessionId}`);

  // Send the initial prompt
  console.log('Sending prompt...');
  const response = await adapter.steer(sessionId, 'Check for available tasks and complete them.');

  console.log(`Response: ${response.slice(0, 200)}`);

  // Check task state
  const tasksRes = await fetch('http://localhost:18800/api/projects/default/tasks');
  const tasks = await tasksRes.json() as any[];
  for (const t of tasks) {
    if (t.id === task.id) {
      console.log(`Task state: ${t.state}`);
    }
  }

  // Clean up
  await adapter.shutdown();
  console.log('Done!');
}

main().catch(e => { console.error(e); process.exit(1); });
