import type { AgentRole } from '@flightdeck-ai/shared';
import type { ProjectScopedDeps } from './types.js';

export async function handleAgentRoutes(
  subPath: string, method: string,
  deps: ProjectScopedDeps,
): Promise<boolean> {
  const { fd, projectName, wsServer, json, readBody, req, url } = deps;

  if (subPath === '/agents' && method === 'GET') {
    const includeRetired = url.searchParams.get('include_retired') === 'true';
    const agentList = fd.listAgents(includeRetired);
    const enriched = agentList.map(a => {
      const usage = fd.sqlite.getAgentTokenUsage(a.id as import('@flightdeck-ai/shared').AgentId);
      return { ...a, tokensIn: usage.totalIn, tokensOut: usage.totalOut };
    });
    json(200, enriched);
    return true;
  }

  if (subPath === '/agents/spawn' && method === 'POST') {
    const am = deps.agentManagers?.get(projectName) ?? fd.agentManager;
    if (!am) { json(500, { error: 'No AgentManager available for this project' }); return true; }
    try {
      const body = await readBody();
      if (!body.role) { json(400, { error: 'Missing required field: role' }); return true; }
      const spawnCallerId = req.headers['x-agent-id'] as string;
      if (spawnCallerId) {
        const spawnCaller = fd.sqlite.getAgent(spawnCallerId as import('@flightdeck-ai/shared').AgentId);
        if (spawnCaller && spawnCaller.role !== 'lead') {
          json(403, { error: `Error: Agent '${spawnCallerId}' (role: ${spawnCaller.role}) cannot spawn agents. Only lead role can spawn agents.` }); return true;
        }
      }
      let resolvedRuntime = body.runtime;
      if (!resolvedRuntime) {
        try {
          const { ModelConfig } = await import('../../agents/ModelConfig.js');
          const mc = new ModelConfig(fd.project.subpath('.'));
          resolvedRuntime = mc.getRoleConfig(body.role).runtime;
        } catch { /* fallback to adapter default */ }
      }
      const newAgent = await am.spawnAgent({
        role: body.role as AgentRole,
        model: body.model,
        runtime: resolvedRuntime,
        task: body.task,
        cwd: body.cwd ?? fd.status().config.cwd ?? fd.project.subpath('.'),
        projectName,
      });
      json(201, newAgent);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg === 'Body too large') json(413, { error: msg });
      else if (msg === 'Invalid JSON') json(400, { error: msg });
      else json(500, { error: `Failed to spawn agent: ${msg}` });
    }
    return true;
  }

  if (subPath.match(/^\/agents\/[^/]+\/terminate$/) && method === 'POST') {
    const agentId = subPath.split('/')[2];
    const am = deps.agentManagers?.get(projectName) ?? fd.agentManager;
    if (!am) { json(500, { error: 'No AgentManager available' }); return true; }
    try {
      const agent = fd.sqlite.getAgent(agentId as any);
      await am.terminateAgent(agentId as import('@flightdeck-ai/shared').AgentId);
      if (agent?.role === 'lead') {
        const lm = deps.leadManagers?.get(projectName);
        if (lm) { (lm as any).leadSessionId = null; (lm as any).leadAgentId = null; }
      }
      json(200, { success: true });
    } catch (e: unknown) { json(500, { error: `Failed to terminate agent: ${e instanceof Error ? e.message : String(e)}` }); }
    return true;
  }

  if (subPath.match(/^\/agents\/[^/]+\/restart$/) && method === 'POST') {
    const agentId = subPath.split('/')[2];
    const am = deps.agentManagers?.get(projectName) ?? fd.agentManager;
    if (!am) { json(500, { error: 'No AgentManager available' }); return true; }
    try {
      const restarted = await am.restartAgent(agentId as import('@flightdeck-ai/shared').AgentId);
      json(200, restarted);
    } catch (e: unknown) { json(500, { error: `Failed to restart agent: ${e instanceof Error ? e.message : String(e)}` }); }
    return true;
  }

  if (subPath.match(/^\/agents\/[^/]+\/interrupt$/) && method === 'POST') {
    const agentId = subPath.split('/')[2];
    const am = deps.agentManagers?.get(projectName) ?? fd.agentManager;
    if (!am) { json(500, { error: 'No AgentManager available' }); return true; }
    try {
      const body = await readBody();
      if (!body.message) { json(400, { error: 'Missing required field: message' }); return true; }
      await am.interruptAgent(agentId as import('@flightdeck-ai/shared').AgentId, body.message);
      json(200, { success: true });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg === 'Body too large' || msg === 'Invalid JSON') json(400, { error: msg });
      else json(500, { error: `Failed to interrupt agent: ${msg}` });
    }
    return true;
  }

  if (subPath.match(/^\/agents\/[^/]+\/send$/) && method === 'POST') {
    const agentId = subPath.split('/')[2];
    const am = deps.agentManagers?.get(projectName) ?? fd.agentManager;
    if (!am) { json(500, { error: 'No AgentManager available' }); return true; }
    try {
      const body = await readBody();
      if (!body.message) { json(400, { error: 'Missing required field: message' }); return true; }
      await am.sendToAgent(agentId as import('@flightdeck-ai/shared').AgentId, body.message);
      json(200, { success: true });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg === 'Body too large' || msg === 'Invalid JSON') json(400, { error: msg });
      else json(500, { error: `Failed to send to agent: ${msg}` });
    }
    return true;
  }

  if (subPath.match(/^\/agents\/[^/]+\/hibernate$/) && method === 'POST') {
    const agentId = subPath.split('/')[2];
    const am = deps.agentManagers?.get(projectName) ?? fd.agentManager;
    if (!am) { json(500, { error: 'No AgentManager available' }); return true; }
    try {
      await am.hibernateAgent(agentId as import('@flightdeck-ai/shared').AgentId);
      json(200, { success: true });
    } catch (e: unknown) { json(500, { error: `Failed to hibernate agent: ${e instanceof Error ? e.message : String(e)}` }); }
    return true;
  }

  if (subPath.match(/^\/agents\/[^/]+\/wake$/) && method === 'POST') {
    const agentId = subPath.split('/')[2];
    const am = deps.agentManagers?.get(projectName) ?? fd.agentManager;
    if (!am) { json(500, { error: 'No AgentManager available' }); return true; }
    try {
      const woken = await am.wakeAgent(agentId as import('@flightdeck-ai/shared').AgentId);
      json(200, woken);
    } catch (e: unknown) { json(500, { error: `Failed to wake agent: ${e instanceof Error ? e.message : String(e)}` }); }
    return true;
  }

  if (subPath.match(/^\/agents\/[^/]+\/retire$/) && method === 'POST') {
    const agentId = subPath.split('/')[2];
    const am = deps.agentManagers?.get(projectName) ?? fd.agentManager;
    if (!am) { json(500, { error: 'No AgentManager available' }); return true; }
    try {
      const agent = fd.sqlite.getAgent(agentId as any);
      await am.retireAgent(agentId as import('@flightdeck-ai/shared').AgentId);
      if (agent?.role === 'lead' || agent?.role === 'director') {
        const lm = deps.leadManagers?.get(projectName);
        if (lm) { (lm as any).leadSessionId = null; (lm as any).leadAgentId = null; }
      }
      json(200, { success: true });
    } catch (e: unknown) { json(500, { error: `Failed to retire agent: ${e instanceof Error ? e.message : String(e)}` }); }
    return true;
  }

  if (subPath.match(/^\/agents\/[^/]+\/unretire$/) && method === 'POST') {
    const agentId = subPath.split('/')[2];
    try {
      fd.sqlite.unretireAgent(agentId as import('@flightdeck-ai/shared').AgentId);
      json(200, { success: true });
    } catch (e: unknown) { json(500, { error: `Failed to unretire agent: ${e instanceof Error ? e.message : String(e)}` }); }
    return true;
  }

  if (subPath.match(/^\/agents\/[^/]+\/model$/) && method === 'PUT') {
    const agentId = subPath.split('/')[2];
    const am = deps.agentManagers?.get(projectName) ?? fd.agentManager;
    if (!am) { json(500, { error: 'No AgentManager available' }); return true; }
    try {
      const body = await readBody();
      if (!body.model) { json(400, { error: 'Missing required field: model' }); return true; }
      await am.setAgentModel(agentId as import('@flightdeck-ai/shared').AgentId, body.model);
      json(200, { success: true });
    } catch (e: unknown) {
      json(500, { error: `Failed to set agent model: ${e instanceof Error ? e.message : String(e)}` });
    }
    return true;
  }

  if (subPath.match(/^\/agents\/[^/]+\/output$/) && method === 'GET') {
    const agentId = subPath.split('/')[2];
    const am = deps.agentManagers?.get(projectName) ?? fd.agentManager;
    if (!am) { json(500, { error: 'No AgentManager available' }); return true; }
    const tail = parseInt(url.searchParams.get('tail') ?? '50', 10) || 50;
    try {
      const output = am.getAgentOutput(agentId as import('@flightdeck-ai/shared').AgentId, tail);
      json(200, output);
    } catch (e: unknown) { json(404, { error: e instanceof Error ? e.message : String(e) }); }
    return true;
  }

  return false;
}
