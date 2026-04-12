/**
 * Minimal ACP E2E test — manual JSON-RPC over stdio
 * Skip the SDK, talk directly to Copilot CLI
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SANDBOX = '/tmp/fd-e2e-sandbox';
const MCP_SERVER = path.join(__dirname, 'src', 'mcp', 'server.ts');

let reqId = 0;
function nextId() { return ++reqId; }

async function main() {
  console.log('🚀 Minimal ACP E2E Test\n');

  // Spawn Copilot CLI in ACP mode
  const child = spawn('copilot', ['--acp', '--stdio'], {
    cwd: SANDBOX,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env },
  });

  child.stderr?.on('data', (d: Buffer) => {
    process.stderr.write(`[stderr] ${d.toString()}`);
  });

  // NDJSON reader
  const rl = createInterface({ input: child.stdout! });
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  const notifications: any[] = [];

  rl.on('line', (line) => {
    try {
      const msg = JSON.parse(line);
      if (msg.id && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id)!;
        pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      } else if (msg.method) {
        // Server-initiated request or notification
        notifications.push(msg);
        // Auto-respond to permission requests
        if (msg.method === 'requestPermission') {
          const allowOpt = msg.params?.options?.find((o: any) => o.kind === 'allow_always' || o.kind === 'allow_once');
          const resp = {
            jsonrpc: '2.0',
            id: msg.id,
            result: {
              outcome: {
                outcome: 'selected',
                optionId: allowOpt?.optionId ?? msg.params?.options?.[0]?.optionId ?? '',
              },
            },
          };
          child.stdin!.write(JSON.stringify(resp) + '\n');
          console.log(`   ✅ Auto-approved permission: ${msg.params?.description ?? 'unknown'}`);
        } else if (msg.method === 'sessionUpdate') {
          const update = msg.params?.update;
          if (update?.sessionUpdate === 'agent_message_chunk' && update?.content?.type === 'text') {
            process.stdout.write(update.content.text);
          } else if (update?.sessionUpdate === 'tool_call') {
            console.log(`\n   🔧 Tool call: ${update.name ?? JSON.stringify(update).slice(0, 200)}`);
          } else {
            console.log(`\n   📡 Update: ${update?.sessionUpdate ?? JSON.stringify(msg.params).slice(0, 300)}`);
          }
          // Respond to notification (if it has id)
          if (msg.id) {
            child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }) + '\n');
          }
        } else {
          // Unknown method
          console.log(`\n   ❓ Method: ${msg.method} — ${JSON.stringify(msg.params).slice(0, 300)}`);
          if (msg.id) {
            child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }) + '\n');
          }
        }
      }
    } catch (e) {
      console.error(`[parse error] ${line.slice(0, 200)}`);
    }
  });

  function send(method: string, params: any): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = nextId();
      pending.set(id, { resolve, reject });
      const msg = { jsonrpc: '2.0', method, id, params };
      child.stdin!.write(JSON.stringify(msg) + '\n');
      // Timeout
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(`Timeout waiting for ${method} response`));
        }
      }, 30000);
    });
  }

  try {
    // 1. Initialize
    console.log('1. Initializing ACP...');
    const initResult = await send('initialize', {
      protocolVersion: 1,
      clientInfo: { name: 'flightdeck-test', version: '0.1.0' },
      clientCapabilities: {},
    });
    console.log(`   Agent: ${initResult.agentInfo?.name} v${initResult.agentInfo?.version}`);
    console.log(`   Protocol: ${initResult.protocolVersion}`);
    console.log(`   Capabilities: ${JSON.stringify(initResult.agentCapabilities)}\n`);

    // 2. Create session with MCP server
    console.log('2. Creating session with Flightdeck MCP...');
    const sessionResult = await send('session/new', {
      cwd: SANDBOX,
      mcpServers: [
        {
          name: 'flightdeck',
          command: '/home/linuxbrew/.linuxbrew/bin/npx',
          args: ['tsx', MCP_SERVER],
          env: [
            { name: 'FLIGHTDECK_AGENT_ID', value: 'worker-copilot-1' },
            { name: 'PATH', value: '/home/linuxbrew/.linuxbrew/bin:/usr/local/bin:/usr/bin:/bin' },
            { name: 'HOME', value: '/home/chuby9726' },
          ],
        },
      ],
    });
    const sessionId = sessionResult.sessionId;
    console.log(`   Session ID: ${sessionId}`);

    // Wait for MCP server to connect
    console.log('   Waiting 15s for MCP server to initialize...');
    await new Promise(r => setTimeout(r, 15000));
    console.log(`   Notifications received so far: ${notifications.length}\n`);

    // 3. Send prompt
    console.log('3. Sending prompt...');
    const promptResult = await send('session/prompt', {
      sessionId,
      prompt: [
        {
          type: 'text',
          text: `You are a Flightdeck test agent. Your agent ID is worker-copilot-1.

DO NOT modify any files. DO NOT run destructive shell commands.

You should have a Flightdeck MCP server connected. Try calling these tools:
1. Call flightdeck_status() to check the project
2. Call flightdeck_task_list() to see tasks

If those tools don't exist, list all the tools/MCP servers you have access to so we can debug.

Keep your response brief.`,
        },
      ],
    });
    console.log('\n\n   === Prompt completed ===');
    console.log(`   Result: ${JSON.stringify(promptResult).slice(0, 500)}\n`);

  } catch (err) {
    console.error('Error:', err);
  }

  // Cleanup
  console.log('\n4. Cleanup...');
  child.kill('SIGTERM');
  await new Promise(r => setTimeout(r, 2000));
  console.log('Done.');
  process.exit(0);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
