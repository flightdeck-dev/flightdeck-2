import type { GlobalRouteDeps } from './types.js';

export async function handleGlobalRoutes(
  url: URL, method: string,
  deps: GlobalRouteDeps,
): Promise<boolean> {
  const { projectManager, json, readBody } = deps;

  if (url.pathname === '/health') {
    json(200, { status: 'ok', projects: projectManager.list() });
    return true;
  }

  if (url.pathname === '/api/models/available' && method === 'GET') {
    const { modelRegistry } = await import('../../agents/ModelRegistry.js');
    const result: Record<string, unknown> = {};
    for (const rt of modelRegistry.getRuntimes()) result[rt] = modelRegistry.getModels(rt);
    json(200, result);
    return true;
  }

  if (url.pathname === '/api/runtimes' && method === 'GET') {
    const { RUNTIME_REGISTRY } = await import('../../agents/runtimes.js');
    const runtimes = Object.entries(RUNTIME_REGISTRY).map(([id, r]) => ({
      id, name: r.name, command: r.command, supportsAcp: r.supportsAcp, adapter: r.adapter,
      icon: r.icon, iconUrl: r.iconUrl, registryId: r.registryId, installHint: r.installHint,
      disabledByDefault: r.disabledByDefault ?? false,
    }));
    json(200, runtimes);
    return true;
  }

  if (url.pathname === '/api/logs' && method === 'GET') {
    try {
      const { existsSync, readFileSync } = await import('node:fs');
      const { join } = await import('node:path');
      const { FD_HOME } = await import('../../cli/constants.js');
      const logPath = join(FD_HOME, 'gateway.log');
      if (!existsSync(logPath)) { json(200, { lines: [], path: logPath }); return true; }
      const lines = readFileSync(logPath, 'utf-8').split('\n');
      const tail = parseInt(url.searchParams.get('tail') ?? '200', 10);
      json(200, { lines: lines.slice(-tail), total: lines.length, path: logPath });
    } catch (err) {
      json(500, { error: `Failed to read logs: ${err instanceof Error ? err.message : String(err)}` });
    }
    return true;
  }

  if (url.pathname === '/api/registry' && method === 'GET') {
    const { acpRegistry } = await import('../../agents/AcpRegistry.js');
    try {
      json(200, await acpRegistry.getAgents());
    } catch (err) {
      json(500, { error: `Failed to fetch registry: ${err instanceof Error ? err.message : String(err)}` });
    }
    return true;
  }

  if (url.pathname === '/api/registry/refresh' && method === 'GET') {
    const { acpRegistry } = await import('../../agents/AcpRegistry.js');
    try {
      json(200, await acpRegistry.refresh());
    } catch (err) {
      json(500, { error: `Failed to refresh registry: ${err instanceof Error ? err.message : String(err)}` });
    }
    return true;
  }

  if (url.pathname === '/api/custom-runtimes' && method === 'GET') {
    try {
      const { loadGlobalConfig } = await import('../../config/GlobalConfig.js');
      json(200, loadGlobalConfig().customRuntimes ?? {});
    } catch (err) {
      json(500, { error: `Failed to read custom runtimes: ${err instanceof Error ? err.message : String(err)}` });
    }
    return true;
  }

  if (url.pathname === '/api/custom-runtimes' && method === 'PUT') {
    try {
      const { loadGlobalConfig, saveGlobalConfig } = await import('../../config/GlobalConfig.js');
      const { loadCustomRuntimes } = await import('../../agents/runtimes.js');
      const body = await readBody();
      const config = loadGlobalConfig();
      config.customRuntimes = body as any;
      saveGlobalConfig(config);
      loadCustomRuntimes();
      json(200, { ok: true });
    } catch (err) {
      json(500, { error: `Failed to save custom runtimes: ${err instanceof Error ? err.message : String(err)}` });
    }
    return true;
  }

  if (url.pathname === '/api/global-config' && method === 'GET') {
    const { loadGlobalConfig } = await import('../../config/GlobalConfig.js');
    try { json(200, loadGlobalConfig()); } catch { json(200, {}); }
    return true;
  }

  if (url.pathname === '/api/global-config' && method === 'PUT') {
    try {
      const body = await readBody();
      if (typeof body !== 'object' || body === null || Array.isArray(body)) {
        json(400, { error: 'Expected a JSON object' }); return true;
      }
      const { loadGlobalConfig, saveGlobalConfig } = await import('../../config/GlobalConfig.js');
      const existing = loadGlobalConfig();
      Object.assign(existing, body);
      saveGlobalConfig(existing);
      json(200, existing);
    } catch (e: unknown) { json(400, { error: e instanceof Error ? e.message : String(e) }); }
    return true;
  }

  if (url.pathname === '/api/browse-directory' && method === 'GET') {
    const { readdirSync } = await import('node:fs');
    const { resolve: resolvePath } = await import('node:path');
    const { homedir } = await import('node:os');
    const startPath = url.searchParams.get('path') || homedir();
    try {
      const resolved = resolvePath(startPath);
      const entries = readdirSync(resolved, { withFileTypes: true })
        .filter(e => e.isDirectory() && !e.name.startsWith('.'))
        .map(e => ({ name: e.name, path: resolvePath(resolved, e.name) }))
        .sort((a, b) => a.name.localeCompare(b.name));
      json(200, { path: resolved, parent: resolvePath(resolved, '..'), entries });
    } catch {
      json(200, { path: startPath, parent: startPath, entries: [] });
    }
    return true;
  }

  if (url.pathname === '/api/create-directory' && method === 'POST') {
    try {
      const body = await readBody();
      if (!body.path) { json(400, { error: 'Missing path' }); return true; }
      const { mkdirSync } = await import('node:fs');
      mkdirSync(body.path, { recursive: true });
      json(200, { created: true, path: body.path });
    } catch (e: unknown) { json(400, { error: e instanceof Error ? e.message : String(e) }); }
    return true;
  }

  if (url.pathname === '/api/gateway/state' && method === 'GET') {
    const agents: Array<{ project: string; agentId: string; role: string; acpSessionId: string | null }> = [];
    for (const name of projectManager.list()) {
      const fd = projectManager.get(name);
      if (!fd) continue;
      for (const a of fd.listAgents().filter(a => a.status === 'busy' || a.status === 'idle')) {
        agents.push({ project: name, agentId: a.id, role: a.role, acpSessionId: a.acpSessionId });
      }
    }
    json(200, agents);
    return true;
  }

  return false;
}
