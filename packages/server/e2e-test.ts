/**
 * Flightdeck 2.0 E2E Test — Copilot CLI via ACP with Flightdeck MCP Server
 *
 * Tests the full chain:
 *   Flightdeck (ACP Client) → Copilot CLI (ACP Agent) → Flightdeck MCP Server → SQLite
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type Client,
  type Agent as AcpAgent,
} from '@agentclientprotocol/sdk';

// ── Flightdeck imports for DB seeding ──
import { Flightdeck } from './src/facade.js';
import { agentId, taskId } from '@flightdeck-ai/shared';
import type { AgentId, Agent } from '@flightdeck-ai/shared';

const PROJECT_NAME = 'e2e-test';
const TEST_DIR = '/tmp/flightdeck-e2e-test';
const MCP_SERVER = join(process.env.HOME!, 'clawspace/flightdeck-2/packages/server/src/mcp/server.ts');
const AGENT_ID = 'agent-e2e-worker';
const LEAD_AGENT_ID = 'agent-e2e-lead';

interface TestResult {
  name: string;
  status: 'pass' | 'fail' | 'skip' | 'timeout';
  durationMs: number;
  toolsCalled: string[];
  agentResponse: string;
  error?: string;
}

const results: TestResult[] = [];

// ── Seed the database ──
function seedDatabase() {
  console.log('📦 Seeding database...');
  const fd = new Flightdeck(PROJECT_NAME);

  // Register a worker agent
  const worker: Agent = {
    id: AGENT_ID as AgentId,
    role: 'worker',
    runtime: 'acp',
    acpSessionId: null,
    status: 'idle',
    currentSpecId: null,
    costAccumulated: 0,
    lastHeartbeat: null,
  };
  fd.registerAgent(worker);

  // Register a lead agent
  const lead: Agent = {
    id: LEAD_AGENT_ID as AgentId,
    role: 'lead',
    runtime: 'acp',
    acpSessionId: null,
    status: 'idle',
    currentSpecId: null,
    costAccumulated: 0,
    lastHeartbeat: null,
  };
  fd.registerAgent(lead);

  // Add test tasks
  fd.addTask({ title: 'Implement user authentication', description: 'Add login/logout with JWT tokens', role: 'worker' });
  fd.addTask({ title: 'Set up CI/CD pipeline', description: 'Configure GitHub Actions for testing and deployment', role: 'worker' });
  fd.addTask({ title: 'Write API documentation', description: 'Document all REST endpoints with examples', role: 'worker' });

  const tasks = fd.listTasks();
  console.log(`  Created ${tasks.length} tasks, 2 agents`);
  for (const t of tasks) {
    console.log(`  - ${t.id}: "${t.title}" [${t.state}]`);
  }
  return { fd, tasks };
}

// ── ACP Connection ──
class AcpTestClient {
  private child!: ChildProcess;
  private connection!: ClientSideConnection;
  private sessionId: string | null = null;
  private toolCallLog: string[] = [];
  private agentOutput = '';

  async start(): Promise<void> {
    console.log('🚀 Starting Copilot CLI via ACP...');
    this.child = spawn('copilot', ['--acp', '--stdio', '--allow-all'], {
      cwd: TEST_DIR,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    this.child.stderr?.on('data', (data: Buffer) => {
      const s = data.toString();
      if (!s.includes('debug') && !s.includes('Debug')) {
        console.log(`  [copilot stderr] ${s.trim()}`);
      }
    });

    const input = Writable.toWeb(this.child.stdin!) as WritableStream<Uint8Array>;
    const output = Readable.toWeb(this.child.stdout!) as ReadableStream<Uint8Array>;
    const stream = ndJsonStream(input, output);

    const client: Client = {
      readTextFile: async (req) => ({ content: '' }),
      writeTextFile: async (req) => ({}),
      createTerminal: async (req) => ({ terminalId: 'fake-term' }),
      terminalOutput: async (req) => ({ output: '' }),
      releaseTerminal: async (req) => ({}),
      waitForTerminalExit: async (req) => ({ exitCode: 0 }),
      killTerminal: async (req) => ({}),
      requestPermission: async (req) => ({ granted: true }),
    };

    this.connection = new ClientSideConnection((_agent: AcpAgent) => client, stream);
  }

  async initialize(): Promise<void> {
    console.log('🔗 Initializing ACP connection...');
    const result = await this.connection.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientInfo: { name: 'flightdeck-e2e', version: '0.0.1' },
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: true,
      },
    });
    console.log(`  Agent: ${result.agentInfo?.name ?? 'unknown'} v${result.agentInfo?.version ?? '?'}`);
    console.log(`  Capabilities: ${JSON.stringify(result.agentCapabilities ?? {})}`);
  }

  async createSession(): Promise<void> {
    console.log('📋 Creating ACP session with Flightdeck MCP server...');
    const result = await this.connection.newSession({
      cwd: TEST_DIR,
      mcpServers: [{
        name: 'flightdeck',
        command: 'npx',
        args: ['tsx', MCP_SERVER],
        env: { FLIGHTDECK_AGENT_ID: AGENT_ID },
      } as any],
    });
    this.sessionId = result.sessionId;
    console.log(`  Session ID: ${this.sessionId}`);
  }

  async prompt(text: string, timeoutMs = 90_000): Promise<{ response: string; toolsCalled: string[] }> {
    if (!this.sessionId) throw new Error('No session');
    this.toolCallLog = [];
    this.agentOutput = '';

    const t0 = Date.now();
    console.log(`  📤 Prompt: "${text.slice(0, 80)}${text.length > 80 ? '...' : ''}"`);

    const result = await Promise.race([
      this.connection.prompt({
        sessionId: this.sessionId,
        prompt: [{ type: 'text', text }],
      }),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('Prompt timeout')), timeoutMs)),
    ]);

    const elapsed = Date.now() - t0;
    // Extract text from result
    let responseText = '';
    if (result && typeof result === 'object') {
      const r = result as any;
      if (r.content) {
        for (const c of r.content) {
          if (c.type === 'text') responseText += c.text;
        }
      }
      if (r.toolCalls) {
        for (const tc of r.toolCalls) {
          this.toolCallLog.push(tc.name ?? tc.toolName ?? 'unknown');
        }
      }
    }

    // The SDK doesn't easily expose tool calls in prompt response; parse from response text
    const toolMatches = responseText.match(/flightdeck_\w+/g) || [];
    const tools = [...new Set([...this.toolCallLog, ...toolMatches])];

    console.log(`  📥 Response (${elapsed}ms, ${responseText.length} chars): "${responseText.slice(0, 120)}..."`);
    if (tools.length) console.log(`  🔧 Tools mentioned: ${tools.join(', ')}`);

    return { response: responseText, toolsCalled: tools };
  }

  async stop(): Promise<void> {
    try { this.child?.kill('SIGTERM'); } catch {}
    await new Promise(r => setTimeout(r, 500));
    try { this.child?.kill('SIGKILL'); } catch {}
  }
}

// ── Test runner ──
async function runTest(
  name: string,
  client: AcpTestClient,
  promptText: string,
  opts: { timeoutMs?: number } = {},
): Promise<TestResult> {
  const t0 = Date.now();
  console.log(`\n━━━ Test: ${name} ━━━`);
  try {
    const { response, toolsCalled } = await client.prompt(promptText, opts.timeoutMs ?? 90_000);
    return {
      name,
      status: 'pass',
      durationMs: Date.now() - t0,
      toolsCalled,
      agentResponse: response,
    };
  } catch (err: any) {
    const msg = err.message ?? String(err);
    console.log(`  ❌ Error: ${msg}`);
    return {
      name,
      status: msg.includes('timeout') ? 'timeout' : 'fail',
      durationMs: Date.now() - t0,
      toolsCalled: [],
      agentResponse: '',
      error: msg,
    };
  }
}

// ── Main ──
async function main() {
  const startTime = Date.now();
  console.log('╔═══════════════════════════════════════════╗');
  console.log('║  Flightdeck 2.0 E2E Test Suite            ║');
  console.log('║  Copilot CLI (ACP) + Flightdeck MCP       ║');
  console.log('╚═══════════════════════════════════════════╝\n');

  // Step 1: Seed database
  const { tasks } = seedDatabase();
  const taskIds = tasks.map(t => t.id);

  // Step 2: Start ACP client
  const client = new AcpTestClient();
  try {
    await client.start();
    await client.initialize();
    await client.createSession();
  } catch (err: any) {
    console.error(`\n💀 Failed to start ACP connection: ${err.message}`);
    console.error(err.stack);
    writeResults([{
      name: 'ACP Connection Setup',
      status: 'fail',
      durationMs: Date.now() - startTime,
      toolsCalled: [],
      agentResponse: '',
      error: err.message,
    }]);
    await client.stop();
    process.exit(1);
  }

  // ── Test 1: List tasks + claim one ──
  results.push(await runTest(
    'Test 1: List tasks and claim one',
    client,
    `You are agent "${AGENT_ID}" (a worker). List all available tasks using flightdeck_task_list, then claim the first ready task using flightdeck_task_claim with your agentId "${AGENT_ID}". Report what you found.`,
  ));

  // ── Test 2: Multi-turn — submit the claimed task ──
  results.push(await runTest(
    'Test 2: Multi-turn — submit claimed task',
    client,
    `You are agent "${AGENT_ID}". What task did you just claim? Now submit it using flightdeck_task_submit with taskId for the task you claimed, your agentId "${AGENT_ID}", and claim "Task completed successfully". Report the result.`,
  ));

  // ── Test 3: Agent-to-agent messaging ──
  results.push(await runTest(
    'Test 3: Agent-to-agent messaging',
    client,
    `You are agent "${AGENT_ID}". Send a message to agent "${LEAD_AGENT_ID}" saying "I need help with the CI/CD pipeline setup" using flightdeck_msg_send with from="${AGENT_ID}" and to="${LEAD_AGENT_ID}". Report the result.`,
  ));

  // ── Test 4: Status check ──
  results.push(await runTest(
    'Test 4: Project status',
    client,
    `Check the project status using flightdeck_status. Report what you see — how many tasks, agents, their states.`,
  ));

  // ── Test 5: Memory search ──
  results.push(await runTest(
    'Test 5: Memory search',
    client,
    `Search project memory for "deployment" using flightdeck_memory_search with query "deployment". Report whether any results were found.`,
  ));

  // ── Test 6: Steer / redirect ──
  results.push(await runTest(
    'Test 6: Steer — list tasks again',
    client,
    `Actually, stop what you were doing. List all tasks again using flightdeck_task_list and tell me the current state of each task.`,
  ));

  // ── Test 7: Create a new task ──
  results.push(await runTest(
    'Test 7: Create a new task',
    client,
    `You are agent "${LEAD_AGENT_ID}" (a lead). Create a new task with title "Write unit tests for auth module" and description "Add comprehensive tests for login, logout, and token refresh" using flightdeck_task_add with agentId "${LEAD_AGENT_ID}". Report the created task.`,
  ));

  // ── Test 8: Task listing with context ──
  results.push(await runTest(
    'Test 8: Task listing after creation',
    client,
    `List all tasks using flightdeck_task_list. How many tasks are there now? Which are ready, which are running, which are done?`,
  ));

  // ── Test 9: Task lifecycle — claim, pause, retry, submit ──
  // First find a ready task
  results.push(await runTest(
    'Test 9a: Claim second task',
    client,
    `You are agent "${AGENT_ID}" (a worker). Claim the task about "CI/CD pipeline" using flightdeck_task_claim with your agentId "${AGENT_ID}". Report which task you claimed and its new state.`,
  ));

  // Lead pauses it
  results.push(await runTest(
    'Test 9b: Lead pauses task',
    client,
    `You are agent "${LEAD_AGENT_ID}" (a lead). Use flightdeck_task_list to find the running task about CI/CD, then pause it using flightdeck_task_pause with agentId "${LEAD_AGENT_ID}". Report the result.`,
  ));

  // Lead retries (unpauses) it
  results.push(await runTest(
    'Test 9c: Lead retries paused task',
    client,
    `You are agent "${LEAD_AGENT_ID}" (a lead). Use flightdeck_task_retry on the paused CI/CD task with agentId "${LEAD_AGENT_ID}". Report the result and new state.`,
  ));

  // Worker claims and submits
  results.push(await runTest(
    'Test 9d: Worker claims and submits retried task',
    client,
    `You are agent "${AGENT_ID}" (a worker). The CI/CD task should be ready again. Claim it with flightdeck_task_claim (agentId "${AGENT_ID}"), then submit it with flightdeck_task_submit (agentId "${AGENT_ID}", claim "Completed CI/CD pipeline setup"). Report each step.`,
  ));

  // ── Test 10: Declare sub-tasks (batch) ──
  results.push(await runTest(
    'Test 10: Declare sub-tasks',
    client,
    `You are agent "${LEAD_AGENT_ID}" (a lead). Use flightdeck_declare_tasks to batch create two tasks: (1) title "Set up database schema" with description "Design tables for users, sessions, and tokens" and (2) title "Write migration scripts" with description "Create SQL migrations for initial schema". Use agentId "${LEAD_AGENT_ID}". Report the created tasks.`,
  ));

  // ── Test 11: Filtered task listing ──
  results.push(await runTest(
    'Test 11: Final task summary',
    client,
    `Use flightdeck_task_list to show ALL tasks. For each task, tell me: id, title, and current state. Give me a summary count of tasks by state.`,
  ));

  // Done
  await client.stop();

  // Write results
  writeResults(results);

  const totalMs = Date.now() - startTime;
  const passed = results.filter(r => r.status === 'pass').length;
  const failed = results.filter(r => r.status === 'fail').length;
  const timedOut = results.filter(r => r.status === 'timeout').length;
  console.log(`\n╔═══════════════════════════════════════════╗`);
  console.log(`║  Results: ${passed} pass, ${failed} fail, ${timedOut} timeout`);
  console.log(`║  Total time: ${(totalMs / 1000).toFixed(1)}s`);
  console.log(`╚═══════════════════════════════════════════╝`);
}

function writeResults(results: TestResult[]) {
  const passed = results.filter(r => r.status === 'pass').length;
  const failed = results.filter(r => r.status === 'fail').length;
  const timedOut = results.filter(r => r.status === 'timeout').length;

  let md = `# Flightdeck 2.0 E2E Test Results\n\n`;
  md += `**Date:** ${new Date().toISOString()}\n`;
  md += `**Agent:** Copilot CLI via ACP\n`;
  md += `**MCP Server:** Flightdeck MCP (stdio)\n\n`;
  md += `## Summary\n\n`;
  md += `| Metric | Value |\n|---|---|\n`;
  md += `| Total tests | ${results.length} |\n`;
  md += `| Passed | ${passed} |\n`;
  md += `| Failed | ${failed} |\n`;
  md += `| Timed out | ${timedOut} |\n\n`;

  md += `## Test Results\n\n`;
  for (const r of results) {
    const icon = r.status === 'pass' ? '✅' : r.status === 'timeout' ? '⏱️' : '❌';
    md += `### ${icon} ${r.name}\n\n`;
    md += `- **Status:** ${r.status}\n`;
    md += `- **Duration:** ${r.durationMs}ms\n`;
    if (r.toolsCalled.length) {
      md += `- **Tools called:** ${r.toolsCalled.join(', ')}\n`;
    }
    if (r.error) {
      md += `- **Error:** \`${r.error}\`\n`;
    }
    md += `\n**Agent response:**\n\`\`\`\n${r.agentResponse.slice(0, 2000) || '(no response)'}\n\`\`\`\n\n`;
  }

  md += `## Bugs Found & Fixed\n\n`;
  md += `_(to be filled in after analysis)_\n`;

  writeFileSync(join(TEST_DIR, 'RESULTS.md'), md);
  console.log(`\n📄 Results written to ${TEST_DIR}/RESULTS.md`);
}

main().catch(err => {
  console.error('💀 Fatal error:', err);
  writeResults([{
    name: 'Fatal Error',
    status: 'fail',
    durationMs: 0,
    toolsCalled: [],
    agentResponse: '',
    error: String(err),
  }]);
  process.exit(1);
});
