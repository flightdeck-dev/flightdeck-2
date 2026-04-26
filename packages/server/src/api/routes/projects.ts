import type { ProjectRouteDeps } from './types.js';
import type { AgentRole } from '@flightdeck-ai/shared';

export async function handleProjectRoutes(
  url: URL, method: string,
  deps: ProjectRouteDeps,
): Promise<boolean> {
  const { projectManager, leadManagers, wsServers, modelCfgCache, json, readBody, onProjectSetup, getModelConfig } = deps;

  if (url.pathname === '/api/projects' && method === 'GET') {
    const summaries = projectManager.list().map(name => {
      try {
        const fd = projectManager.get(name);
        if (!fd) return { name };
        const stats = fd.getTaskStats();
        return {
          name,
          governance: fd.governance.governanceConfig.profile ?? 'autonomous',
          agentCount: fd.listAgents().filter((a: any) => !['retired', 'hibernated', 'errored'].includes(a.status)).length,
          busyAgentCount: fd.listAgents().filter((a: any) => a.status === 'busy').length,
          hibernatedCount: fd.listAgents().filter((a: any) => a.status === 'hibernated').length,
          taskStats: stats,
          totalCost: fd.sqlite.getTotalCost(),
        };
      } catch {
        return { name };
      }
    });
    json(200, { projects: summaries });
    return true;
  }

  if (url.pathname === '/api/projects' && method === 'POST') {
    try {
      const body = await readBody();
      if (!body.name || typeof body.name !== 'string') { json(400, { error: 'Missing required field: name' }); return true; }
      const name = body.name.trim();
      if (!/^[a-zA-Z0-9_-]+$/.test(name)) { json(400, { error: 'Project name must be alphanumeric (with - and _)' }); return true; }
      if (projectManager.list().includes(name)) { json(409, { error: `Project "${name}" already exists` }); return true; }
      projectManager.create(name);
      const fd = projectManager.get(name);
      if (fd) {
        const cfg = fd.project.getConfig();
        if (body.cwd) cfg.cwd = body.cwd;
        if (body.governance) cfg.governance = body.governance;
        fd.project.setConfig(cfg);
        if (body.leadRuntime || body.leadModel) {
          try {
            const mc = await getModelConfig(fd, name);
            if (body.leadRuntime) mc.setRole('lead', `${body.leadRuntime}:${body.leadModel ?? ''}`);
            else if (body.leadModel) mc.setRole('lead', body.leadModel);
          } catch { /* best effort */ }
        }
        fd.orchestrator.start();
        if (onProjectSetup) {
          await onProjectSetup(name);
        }
      }
      json(201, { name, message: `Project "${name}" created` });
    } catch (e: unknown) { json((e instanceof Error && e.message === 'Body too large') ? 413 : 400, { error: e instanceof Error ? e.message : 'Invalid JSON' }); }
    return true;
  }

  // Project-scoped: /api/projects/:name/...
  const m = url.pathname.match(/^\/api\/projects\/([^/]+)(\/.*)?$/);
  if (!m) return false;

  const projectName = decodeURIComponent(m[1]);
  const subPath = m[2] || '/';

  // DELETE project
  if (subPath === '/' && method === 'DELETE') {
    const lm = leadManagers?.get(projectName);
    if (lm) {
      try { lm.stop?.(); } catch { /* best effort */ }
      leadManagers?.delete(projectName);
    }
    if (wsServers?.has(projectName)) wsServers.delete(projectName);
    modelCfgCache.delete(projectName);
    if (projectManager.delete(projectName)) {
      json(200, { message: `Project "${projectName}" deleted` });
    } else json(404, { error: `Project "${projectName}" not found` });
    return true;
  }

  // Archive
  if (subPath === '/archive' && method === 'POST') {
    if (projectManager.archive(projectName)) {
      const lm = leadManagers?.get(projectName);
      if (lm) { try { lm.stop(); } catch {} leadManagers?.delete(projectName); }
      json(200, { message: `Project "${projectName}" archived` });
    } else json(404, { error: `Project "${projectName}" not found` });
    return true;
  }

  // Unarchive
  if (subPath === '/unarchive' && method === 'POST') {
    if (projectManager.unarchive(projectName)) {
      const unarchivedFd = projectManager.get(projectName);
      if (unarchivedFd) {
        unarchivedFd.orchestrator.start();
        if (onProjectSetup) {
          await onProjectSetup(projectName);
        }
      }
      json(200, { message: `Project "${projectName}" unarchived` });
    } else json(404, { error: `Project "${projectName}" not found or not archived` });
    return true;
  }

  // List archived
  if (url.pathname === '/api/projects/archived' && method === 'GET') {
    const all = projectManager.listAll();
    const archived = all.filter(n => projectManager.isArchived(n));
    json(200, { projects: archived });
    return true;
  }

  return false;
}
