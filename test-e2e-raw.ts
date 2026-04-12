/**
 * Ultra-minimal: just test session/new with mcpServers and log everything
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const SANDBOX = '/tmp/fd-e2e-sandbox';
let reqId = 0;

async function main() {
  const child = spawn('copilot', ['--acp', '--stdio'], {
    cwd: SANDBOX,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  // Log ALL stderr
  child.stderr?.on('data', (d: Buffer) => {
    process.stderr.write(`[copilot stderr] ${d.toString()}`);
  });

  const rl = createInterface({ input: child.stdout! });
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();

  rl.on('line', (line) => {
    console.log(`[recv] ${line.slice(0, 500)}`);
    try {
      const msg = JSON.parse(line);
      if (msg.id != null && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id)!;
        pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      } else if (msg.id != null && msg.method) {
        // Server request — auto-respond
        if (msg.method === 'requestPermission' || msg.method === 'session/request_permission') {
          const opt = msg.params?.options?.find((o: any) => o.kind === 'allow_always' || o.kind === 'allow_once') ?? msg.params?.options?.[0];
          child.stdin!.write(JSON.stringify({
            jsonrpc: '2.0', id: msg.id,
            result: { outcome: { outcome: 'selected', optionId: opt?.optionId ?? '' } }
          }) + '\n');
          console.log(`[auto-approve] ${msg.params?.description ?? ''}`);
        } else {
          child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }) + '\n');
        }
      }
    } catch {}
  });

  function send(method: string, params: any): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = ++reqId;
      pending.set(id, { resolve, reject });
      const msg = JSON.stringify({ jsonrpc: '2.0', method, id, params });
      console.log(`[send] ${msg.slice(0, 500)}`);
      child.stdin!.write(msg + '\n');
      setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(`timeout: ${method}`)); } }, 90000);
    });
  }

  // 1. Initialize
  const init = await send('initialize', {
    protocolVersion: 1,
    clientInfo: { name: 'flightdeck', version: '2.0.0' },
    clientCapabilities: {
      fs: { readTextFile: true, writeTextFile: true },
      terminal: true,
    },
  });
  console.log(`\n✅ Init: ${JSON.stringify(init).slice(0, 200)}\n`);

  // 2. session/new WITH mcpServers
  console.log('Creating session with Flightdeck MCP server...\n');
  const session = await send('session/new', {
    cwd: SANDBOX,
    mcpServers: [
      {
        name: 'flightdeck',
        command: '/home/linuxbrew/.linuxbrew/bin/npx',
        args: ['tsx', '/home/chuby9726/clawspace/flightdeck-2/src/mcp/server.ts'],
        env: [
          { name: 'FLIGHTDECK_AGENT_ID', value: 'worker-copilot-1' },
          { name: 'PATH', value: '/home/linuxbrew/.linuxbrew/bin:/usr/local/bin:/usr/bin:/bin' },
          { name: 'HOME', value: '/home/chuby9726' },
        ],
      },
    ],
  });
  console.log(`\n✅ Session: ${session.sessionId}\n`);

  // 3. Wait longer for MCP to connect
  console.log('Waiting 20s for MCP server...');
  await new Promise(r => setTimeout(r, 20000));

  // 4. Prompt — explicitly ask to use flightdeck tools
  console.log('\nSending prompt...\n');
  const result = await send('session/prompt', {
    sessionId: session.sessionId,
    prompt: [{ type: 'text', text: 'Call flightdeck_status using the flightdeck MCP server. If that tool is not available, list every MCP server and tool you have access to.' }],
  });
  console.log(`\n✅ Prompt result: ${JSON.stringify(result)}\n`);

  // 5. Cleanup
  child.kill('SIGTERM');
  await new Promise(r => setTimeout(r, 2000));
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
