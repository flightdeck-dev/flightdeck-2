import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';

/**
 * Unit tests for WebSocket authentication in the gateway.
 *
 * We replicate the auth logic from gateway.ts's wss.on('connection') handler
 * in a minimal HTTP+WS server to test the three scenarios.
 */

function createTestServer(authMode: 'none' | 'token', authToken: string | null): { server: http.Server; wss: InstanceType<typeof WebSocketServer> } {
  const server = http.createServer((_req, res) => {
    res.writeHead(200);
    res.end('ok');
  });

  const wss = new WebSocketServer({ server });

  wss.on('connection', (socket, req) => {
    // Replicate gateway.ts auth logic
    if (authMode === 'token' && authToken) {
      const wsAuthUrl = new URL(req.url ?? '/', 'http://localhost');
      const queryToken = wsAuthUrl.searchParams.get('token');
      const authHeader = req.headers.authorization;
      const headerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
      const providedToken = queryToken || headerToken;
      if (!providedToken || providedToken !== authToken) {
        socket.close(4401, 'Unauthorized');
        return;
      }
    }

    // Authorized — echo back
    socket.send('connected');
  });

  return { server, wss };
}

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve(addr.port);
    });
  });
}

function connectWs(url: string, headers?: Record<string, string>): Promise<{ code?: number; reason?: string; data?: string }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, { headers });
    ws.on('message', (data) => {
      resolve({ data: data.toString() });
      ws.close();
    });
    ws.on('close', (code, reason) => {
      resolve({ code, reason: reason.toString() });
    });
    ws.on('error', () => {
      // close event will fire after error
    });
  });
}

describe('Gateway WebSocket auth', () => {
  const servers: http.Server[] = [];

  afterEach(() => {
    for (const s of servers) {
      try { s.close(); } catch {}
    }
    servers.length = 0;
  });

  it('connects when auth is disabled', async () => {
    const { server } = createTestServer('none', null);
    servers.push(server);
    const port = await listen(server);
    const result = await connectWs(`ws://127.0.0.1:${port}/ws/test`);
    expect(result.data).toBe('connected');
  });

  it('connects with valid token via query param', async () => {
    const token = 'test-secret-token';
    const { server } = createTestServer('token', token);
    servers.push(server);
    const port = await listen(server);
    const result = await connectWs(`ws://127.0.0.1:${port}/ws/test?token=${token}`);
    expect(result.data).toBe('connected');
  });

  it('connects with valid token via Authorization header', async () => {
    const token = 'test-secret-token';
    const { server } = createTestServer('token', token);
    servers.push(server);
    const port = await listen(server);
    const result = await connectWs(`ws://127.0.0.1:${port}/ws/test`, { Authorization: `Bearer ${token}` });
    expect(result.data).toBe('connected');
  });

  it('rejects connection with missing token', async () => {
    const { server } = createTestServer('token', 'real-token');
    servers.push(server);
    const port = await listen(server);
    const result = await connectWs(`ws://127.0.0.1:${port}/ws/test`);
    expect(result.code).toBe(4401);
    expect(result.reason).toBe('Unauthorized');
  });

  it('rejects connection with invalid token', async () => {
    const { server } = createTestServer('token', 'real-token');
    servers.push(server);
    const port = await listen(server);
    const result = await connectWs(`ws://127.0.0.1:${port}/ws/test?token=wrong-token`);
    expect(result.code).toBe(4401);
    expect(result.reason).toBe('Unauthorized');
  });
});
