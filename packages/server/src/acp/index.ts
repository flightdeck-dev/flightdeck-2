import { Readable, Writable } from 'node:stream';
import { AgentSideConnection, ndJsonStream } from '@agentclientprotocol/sdk';
import { AcpAgentServer } from './AcpAgentServer.js';

export async function runAcpAgent(opts: { project?: string }): Promise<void> {
  const server = new AcpAgentServer(opts);

  // ndJsonStream(output, input): output = writable (to client), input = readable (from client)
  // We ARE the agent: our stdout goes TO client, our stdin comes FROM client
  const stream = ndJsonStream(
    Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
    Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
  );

  const conn = new AgentSideConnection(() => server, stream);
  server.setConnection(conn);

  // Keep process alive until stdin closes
  await new Promise<void>((resolve) => {
    process.stdin.on('end', resolve);
    process.stdin.on('close', resolve);
  });
}
