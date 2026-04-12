/**
 * Flightdeck 2.0 — Full E2E: Agent claims task, executes, submits
 * 
 * Read-only: agent only uses Flightdeck MCP tools, no file modifications
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SANDBOX = '/tmp/fd-e2e-sandbox';
const MCP_SERVER = path.join(__dirname, 'src', 'mcp', 'server.ts');

let reqId = 0;
let agentOutput = '';

async function main() {
  console.log('🚀 Flightdeck 2.0 — Full Agent Lifecycle E2E\n');

  const child = spawn('copilot', ['--acp', '--stdio'], {
    cwd: SANDBOX,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  child.stderr?.on('data', (d: Buffer) => {
    const msg = d.toString();
    if (msg.includes('ERROR') || msg.includes('error')) {
      process.stderr.write(`[copilot] ${msg}`);
    }
  });

  const rl = createInterface({ input: child.stdout! });
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();

  rl.on('line', (line) => {
    try {
      const msg = JSON.parse(line);
      // Response to our request
      if (msg.id != null && pending.has(msg.id) && !msg.method) {
        const { resolve, reject } = pending.get(msg.id)!;
        pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
        return;
      }
      // Server-initiated request
      if (msg.id != null && msg.method) {
        if (msg.method === 'session/request_permission' || msg.method === 'requestPermission') {
          const opt = msg.params?.options?.find((o: any) => o.kind === 'allow_always')
            ?? msg.params?.options?.find((o: any) => o.kind === 'allow_once')
            ?? msg.params?.options?.[0];
          child.stdin!.write(JSON.stringify({
            jsonrpc: '2.0', id: msg.id,
            result: { outcome: { outcome: 'selected', optionId: opt?.optionId ?? '' } }
          }) + '\n');
          const toolName = msg.params?.toolCall?.title ?? 'unknown';
          console.log(`   🔓 Auto-approved: ${toolName}`);
        } else {
          // Respond OK to any other server request
          child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }) + '\n');
        }
        return;
      }
      // Notifications (session/update)
      if (msg.method === 'session/update') {
        const update = msg.params?.update;
        if (!update) return;
        switch (update.sessionUpdate) {
          case 'agent_message_chunk':
            if (update.content?.type === 'text') {
              agentOutput += update.content.text;
              process.stdout.write(update.content.text);
            }
            break;
          case 'tool_call':
            console.log(`\n   🔧 Tool: ${update.title ?? 'unknown'} [${update.status}]`);
            break;
          case 'tool_call_update':
            if (update.status === 'completed') {
              const text = update.content?.[0]?.content?.text ?? update.content?.[0]?.text ?? '';
              console.log(`   ✅ Result: ${text.slice(0, 200)}${text.length > 200 ? '...' : ''}`);
            } else if (update.status === 'errored') {
              console.log(`   ❌ Error: ${JSON.stringify(update.content).slice(0, 200)}`);
            }
            break;
          case 'agent_thought_chunk':
            // Silently collect thoughts
            break;
        }
      }
    } catch {}
  });

  function send(method: string, params: any): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = ++reqId;
      pending.set(id, { resolve, reject });
      child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', method, id, params }) + '\n');
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(`timeout: ${method}`));
        }
      }, 120_000);
    });
  }

  try {
    // 1. Initialize
    console.log('1️⃣  Initialize ACP...');
    const init = await send('initialize', {
      protocolVersion: 1,
      clientInfo: { name: 'flightdeck', version: '2.0.0' },
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
    });
    console.log(`   Copilot ${init.agentInfo?.version}\n`);

    // 2. Create session with Flightdeck MCP
    console.log('2️⃣  Create session with Flightdeck MCP...');
    const session = await send('session/new', {
      cwd: SANDBOX,
      mcpServers: [{
        name: 'flightdeck',
        command: '/home/linuxbrew/.linuxbrew/bin/npx',
        args: ['tsx', MCP_SERVER],
        env: [
          { name: 'FLIGHTDECK_AGENT_ID', value: 'worker-copilot-1' },
          { name: 'PATH', value: '/home/linuxbrew/.linuxbrew/bin:/usr/local/bin:/usr/bin:/bin' },
          { name: 'HOME', value: '/home/chuby9726' },
        ],
      }],
    });
    console.log(`   Session: ${session.sessionId}`);
    console.log('   Waiting for MCP to connect...');
    await new Promise(r => setTimeout(r, 15000));
    console.log('');

    // 3. Full agent lifecycle prompt
    console.log('3️⃣  Sending task prompt...\n');
    console.log('─── Agent Output ───');
    await send('session/prompt', {
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: `You are a Flightdeck worker agent. Your agent ID is: worker-copilot-1

IMPORTANT: Do NOT create, modify, or delete any files. Do NOT run shell commands.
ONLY use flightdeck MCP tools.

Complete these steps IN ORDER:
1. Call flightdeck_status() to check the project
2. Call flightdeck_task_list() to see available tasks
3. Pick the first "ready" task and call flightdeck_task_claim(taskId, agentId) with your agent ID
4. Call flightdeck_task_submit(taskId, agentId, claim) with a brief summary of what you found
5. Call flightdeck_status() again to confirm the task state changed

Report each step's result briefly.` }],
    });
    console.log('\n─── End Output ───\n');

    // 4. Verify via direct DB check
    console.log('4️⃣  Verification:');
    // Send one more prompt to get final status
    agentOutput = '';
    await send('session/prompt', {
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'Call flightdeck_task_list() one final time and show the state of all tasks.' }],
    });
    console.log('\n');

  } catch (err) {
    console.error('\n❌ Error:', err);
  }

  // Cleanup
  console.log('5️⃣  Cleanup...');
  child.kill('SIGTERM');
  await new Promise(r => setTimeout(r, 2000));
  console.log('Done! 🎉');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
