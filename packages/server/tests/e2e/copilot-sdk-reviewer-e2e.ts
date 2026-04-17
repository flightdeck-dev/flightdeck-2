/**
 * Test: CopilotSdkAdapter reviewer flow
 * Directly spawn a reviewer using the SDK adapter to verify review_submit tool works.
 */
import { CopilotSdkAdapter } from '../../src/agents/CopilotSdkAdapter.js';

const GATEWAY = 'http://localhost:18800';
const PROJECT = 'default';

async function main() {
  // Find the in_review task
  const tasksRes = await fetch(`${GATEWAY}/api/projects/${PROJECT}/tasks`);
  const tasks = (await tasksRes.json()) as any[];
  const reviewTask = tasks.find((t: any) => t.state === 'in_review');
  
  if (!reviewTask) {
    console.log('No in_review task found. Create one first.');
    process.exit(1);
  }
  
  console.log(`Found in_review task: ${reviewTask.id} "${reviewTask.title}"`);
  console.log(`Claim: ${reviewTask.claim ?? '(none)'}`);
  
  // Spawn reviewer via SDK adapter
  const adapter = new CopilotSdkAdapter({ gatewayUrl: GATEWAY });
  
  console.log('Spawning reviewer...');
  const { agentId, sessionId } = await adapter.spawn({
    agentId: `reviewer-sdk-${Date.now().toString(36)}`,
    role: 'reviewer',
    cwd: '/tmp/fd-e2e-test',
    projectName: PROJECT,
    systemPrompt: `You are a code reviewer. Review this task and call flightdeck_review_submit to approve or request changes.

Task: ${reviewTask.title}
Task ID: ${reviewTask.id}
Worker claim: ${reviewTask.claim ?? 'No claim provided'}

Call flightdeck_review_submit with verdict="approve" if the work looks acceptable, or verdict="request_changes" with feedback.`,
  });
  
  console.log(`Reviewer: ${agentId} Session: ${sessionId}`);
  
  // Steer the reviewer to do the review
  console.log('Sending review prompt...');
  const response = await adapter.steer(sessionId, `Review task ${reviewTask.id} and call flightdeck_review_submit.`);
  
  console.log(`Response: ${response.slice(0, 300)}`);
  
  // Check task state
  const afterRes = await fetch(`${GATEWAY}/api/projects/${PROJECT}/tasks`);
  const afterTasks = (await afterRes.json()) as any[];
  const updated = afterTasks.find((t: any) => t.id === reviewTask.id);
  console.log(`Task state after review: ${updated?.state}`);
  
  // Check comments
  const commentsRes = await fetch(`${GATEWAY}/api/projects/${PROJECT}/tasks/${reviewTask.id}/comments`);
  const comments = (await commentsRes.json()) as any[];
  for (const c of comments) {
    console.log(`Comment: [${c.type}] verdict=${c.verdict ?? '-'} | ${(c.content ?? '').slice(0, 100)}`);
  }
  
  await adapter.shutdown();
  console.log('Done!');
}

main().catch(e => { console.error(e); process.exit(1); });
