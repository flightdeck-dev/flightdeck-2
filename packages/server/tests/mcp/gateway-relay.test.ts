import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GatewayRelay } from '../../src/mcp/gatewayRelay.js';

describe('GatewayRelay', () => {
  let relay: GatewayRelay;
  const baseUrl = 'http://localhost:18800';
  const projectName = 'test-project';

  beforeEach(() => {
    relay = new GatewayRelay(baseUrl, projectName);
    vi.restoreAllMocks();
  });

  it('spawnAgent sends POST and returns parsed JSON', async () => {
    const mockAgent = { id: 'agent-worker-1', role: 'worker', status: 'idle' };
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(mockAgent), { status: 201 }));

    const result = await relay.spawnAgent({ role: 'worker', model: 'gpt-4' });
    expect(result).toEqual(mockAgent);
    expect(fetch).toHaveBeenCalledWith(
      `${baseUrl}/api/projects/${projectName}/agents/spawn`,
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('spawnAgent throws on non-ok response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('Server error', { status: 500 }));
    await expect(relay.spawnAgent({ role: 'worker' })).rejects.toThrow('Gateway spawn failed: 500');
  });

  it('terminateAgent sends POST', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));
    await relay.terminateAgent('agent-1');
    expect(fetch).toHaveBeenCalledWith(
      `${baseUrl}/api/projects/${projectName}/agents/agent-1/terminate`,
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('terminateAgent throws on error', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('Not found', { status: 404 }));
    await expect(relay.terminateAgent('agent-1')).rejects.toThrow('Gateway terminate failed: 404');
  });

  it('restartAgent sends POST and returns JSON', async () => {
    const mockAgent = { id: 'agent-1', status: 'idle' };
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(mockAgent), { status: 200 }));
    const result = await relay.restartAgent('agent-1');
    expect(result).toEqual(mockAgent);
  });

  it('restartAgent throws on error', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('Error', { status: 500 }));
    await expect(relay.restartAgent('agent-1')).rejects.toThrow('Gateway restart failed: 500');
  });

  it('interruptAgent sends POST with message body', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));
    await relay.interruptAgent('agent-1', 'stop now');
    expect(fetch).toHaveBeenCalledWith(
      `${baseUrl}/api/projects/${projectName}/agents/agent-1/interrupt`,
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ message: 'stop now' }),
      }),
    );
  });

  it('interruptAgent throws on error', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('Error', { status: 500 }));
    await expect(relay.interruptAgent('agent-1', 'msg')).rejects.toThrow('Gateway interrupt failed: 500');
  });

  it('sendToAgent sends POST with message body', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));
    await relay.sendToAgent('agent-1', 'hello');
    expect(fetch).toHaveBeenCalledWith(
      `${baseUrl}/api/projects/${projectName}/agents/agent-1/send`,
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ message: 'hello' }),
      }),
    );
  });

  it('sendToAgent throws on error', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('Error', { status: 500 }));
    await expect(relay.sendToAgent('agent-1', 'msg')).rejects.toThrow('Gateway send failed: 500');
  });
});
