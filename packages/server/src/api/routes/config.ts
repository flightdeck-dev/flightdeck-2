import type { ProjectScopedDeps } from './types.js';

export async function handleConfigRoutes(
  subPath: string, method: string,
  deps: ProjectScopedDeps,
): Promise<boolean> {
  const { fd, projectName, wsServer, json, readBody, req, url, getModelConfig, modRegistry, presetNames, displayModule, serverDisplayConfig, setServerDisplayConfig } = deps;

  if (subPath === '/status' && method === 'GET') {
    json(200, fd.status());
    return true;
  }

  if (subPath === '/models' && method === 'GET') {
    const mc = await getModelConfig(fd, projectName);
    json(200, { roles: mc.getRoleConfigs(), presets: presetNames });
    return true;
  }

  if (subPath === '/models/available' && method === 'GET') {
    const result: Record<string, unknown> = {};
    for (const rt of modRegistry!.getRuntimes()) result[rt] = modRegistry!.getModels(rt);
    json(200, result);
    return true;
  }

  if (url.pathname.match(/^\/api\/projects\/[^/]+\/runtimes$/) && method === 'GET') {
    // Empty handler preserved from original
    return true;
  }

  if (subPath === '/config' && method === 'GET') {
    try {
      const { loadGlobalConfig } = await import('../../config/GlobalConfig.js');
      const config = loadGlobalConfig();
      const safe = { ...config, auth: config.auth ? { mode: config.auth.mode } : undefined };
      json(200, safe);
    } catch (err) {
      json(500, { error: `Failed to read config: ${err instanceof Error ? err.message : String(err)}` });
    }
    return true;
  }

  if (subPath === '/config/schema' && method === 'GET') {
    try {
      const { readFileSync } = await import('node:fs');
      const { join } = await import('node:path');
      const schemaPath = join(import.meta.dirname ?? new URL('.', import.meta.url).pathname, '..', '..', 'config', 'global-config.schema.json');
      const schema = JSON.parse(readFileSync(schemaPath, 'utf-8'));
      json(200, schema);
    } catch (err) {
      json(500, { error: `Failed to read schema: ${err instanceof Error ? err.message : String(err)}` });
    }
    return true;
  }

  if (subPath === '/config' && method === 'PUT') {
    try {
      const body = await readBody();
      const { ProjectConfigSchema } = await import('@flightdeck-ai/shared/config-schema');
      const parsed = ProjectConfigSchema.partial().safeParse(body);
      if (!parsed.success) { json(400, { error: parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ') }); return true; }
      const validBody = parsed.data;
      const cfg = fd.project.getConfig();
      if (validBody.governance !== undefined) { cfg.governance = validBody.governance; fd.governance.setProfile(validBody.governance); }
      if (validBody.heartbeatEnabled !== undefined) { (cfg as any).heartbeatEnabled = validBody.heartbeatEnabled; }
      if (validBody.scoutEnabled !== undefined) { (cfg as any).scoutEnabled = validBody.scoutEnabled; }
      if (validBody.heartbeatIdleTimeoutDays !== undefined) { cfg.heartbeatIdleTimeoutDays = validBody.heartbeatIdleTimeoutDays; }
      if (validBody.isolation !== undefined) { cfg.isolation = validBody.isolation; }
      if (validBody.onCompletion !== undefined) { cfg.onCompletion = validBody.onCompletion; }
      if (validBody.maxConcurrentWorkers !== undefined) { cfg.maxConcurrentWorkers = validBody.maxConcurrentWorkers; }
      if (validBody.planApprovalThreshold !== undefined) { (cfg as any).planApprovalThreshold = validBody.planApprovalThreshold; }
      if (validBody.costThresholdPerDay !== undefined) { cfg.costThresholdPerDay = validBody.costThresholdPerDay; }
      if (validBody.cwd !== undefined) { cfg.cwd = validBody.cwd; }
      if (validBody.allowedRuntimes !== undefined) { cfg.allowedRuntimes = validBody.allowedRuntimes; }
      if (validBody.notifications !== undefined) { (cfg as any).notifications = validBody.notifications; }
      fd.project.setConfig(cfg);
      json(200, { config: cfg });
    } catch (e: unknown) { json((e instanceof Error && e.message === 'Body too large') ? 413 : 400, { error: e instanceof Error ? e.message : 'Invalid JSON' }); }
    return true;
  }

  if (subPath === '/runtimes' && method === 'GET') {
    const { RUNTIME_REGISTRY } = await import('../../agents/runtimes.js');
    const runtimes = Object.entries(RUNTIME_REGISTRY).map(([id, r]) => ({
      id, name: r.name, command: r.command, supportsAcp: r.supportsAcp, adapter: r.adapter,
      systemPromptMethod: r.systemPromptMethod, supportsSessionLoad: r.supportsSessionLoad,
      supportsModelDiscovery: r.supportsModelDiscovery !== false,
      icon: r.icon, iconUrl: r.iconUrl, registryId: r.registryId, docsUrl: r.docsUrl, setupLinks: r.setupLinks,
      loginInstructions: r.loginInstructions, installHint: r.installHint,
      disabledByDefault: r.disabledByDefault ?? false,
    }));
    json(200, runtimes);
    return true;
  }

  if (subPath.match(/^\/runtimes\/([^/]+)\/test$/) && method === 'POST') {
    const runtimeId = subPath.match(/^\/runtimes\/([^/]+)\/test$/)![1];
    const { RUNTIME_REGISTRY } = await import('../../agents/runtimes.js');
    const rt = RUNTIME_REGISTRY[runtimeId];
    if (!rt) { json(404, { error: `Unknown runtime: ${runtimeId}` }); return true; }
    try {
      const { commandExists } = await import('../../utils/platform.js');
      const { execFileSync } = await import('node:child_process');
      if (!commandExists(rt.command)) {
        json(200, { success: false, installed: false, message: `Binary "${rt.command}" not found on PATH` });
        return true;
      }
      let version: string | undefined;
      try { version = execFileSync(rt.command, ['--version'], { stdio: 'pipe', timeout: 10000 }).toString().trim().split('\n')[0]; } catch {}
      json(200, { success: true, installed: true, version, message: `${rt.name} is installed${version ? ` (${version})` : ''}` });
    } catch (e: unknown) {
      json(500, { error: e instanceof Error ? e.message : 'Test failed' });
    }
    return true;
  }

  if (subPath.match(/^\/runtimes\/([^/]+)\/discover$/) && method === 'POST') {
    const runtimeId = subPath.match(/^\/runtimes\/([^/]+)\/discover$/)![1];
    try {
      const { discoverRuntimeModels } = await import('../../agents/AcpAdapter.js');
      const models = await discoverRuntimeModels(runtimeId);
      json(200, { runtime: runtimeId, models });
    } catch (e: unknown) {
      json(500, { error: e instanceof Error ? e.message : String(e) });
    }
    return true;
  }

  if (subPath.startsWith('/models/preset/') && method === 'POST') {
    const preset = subPath.split('/').pop()!;
    const mc = await getModelConfig(fd, projectName);
    if (mc.applyPreset(preset)) {
      const lm = deps.leadManagers?.get(projectName);
      if (lm) {
        const notice = `Model preset '${preset}' applied. Check flightdeck_model_list for current configuration.`;
        lm.steerLead({ type: 'system_notice', message: notice } as any).catch(() => {});
        lm.steerDirector(notice).catch(() => {});
      }
      json(200, { success: true, roles: mc.getRoleConfigs() });
    } else json(400, { error: `Unknown preset: ${preset}. Available: ${presetNames.join(', ')}` });
    return true;
  }

  if (subPath.match(/^\/models\/[^/]+$/) && method === 'PUT') {
    const role = subPath.split('/').pop()!;
    try {
      const body = await readBody();
      const mc = await getModelConfig(fd, projectName);
      if (body.runtime) mc.setRole(role, `${body.runtime}:${body.model ?? ''}`);
      else if (body.model) mc.setRole(role, body.model);
      else { json(400, { error: 'Provide runtime and/or model' }); return true; }
      deps.modelCfgCache.delete(projectName);
      const lm = deps.leadManagers?.get(projectName);
      if (lm) {
        const notice = `Model configuration updated for role '${role}'. Check flightdeck_model_list for current configuration.`;
        lm.steerLead({ type: 'system_notice', message: notice } as any).catch(() => {});
        lm.steerDirector(notice).catch(() => {});
      }
      json(200, { success: true, config: mc.getRoleConfig(role) });
    } catch (e: unknown) { json((e instanceof Error && e.message === 'Body too large') ? 413 : 400, { error: e instanceof Error ? e.message : 'Invalid request body' }); }
    return true;
  }

  if (subPath === '/display' && method === 'GET') {
    json(200, serverDisplayConfig!);
    return true;
  }

  if (subPath === '/display' && method === 'PUT') {
    try {
      const body = await readBody();
      if (!displayModule!.isValidDisplayConfig(body)) { json(400, { error: 'Invalid display config' }); return true; }
      const newCfg = displayModule!.mergeDisplayConfig(serverDisplayConfig, body);
      setServerDisplayConfig(newCfg);
      if (wsServer) wsServer.broadcast({ type: 'display:config', config: newCfg });
      json(200, newCfg);
    } catch (e: unknown) { json((e instanceof Error && e.message === 'Body too large') ? 413 : 400, { error: e instanceof Error ? e.message : 'Invalid JSON' }); }
    return true;
  }

  if (subPath.match(/^\/display\/preset\/[^/]+$/) && method === 'POST') {
    const preset = subPath.split('/').pop()!;
    if (preset in displayModule!.DISPLAY_PRESETS) {
      const newCfg = { ...(displayModule!.DISPLAY_PRESETS)[preset as import('@flightdeck-ai/shared').DisplayPreset] };
      setServerDisplayConfig(newCfg);
      json(200, newCfg);
    } else json(400, { error: `Unknown preset: ${preset}. Available: ${displayModule!.DISPLAY_PRESET_NAMES.join(', ')}` });
    return true;
  }

  if (subPath === '/role-preference' && method === 'GET') {
    const { readFileSync: rfs, existsSync: efs } = await import('node:fs');
    const { join: pjoin } = await import('node:path');
    const prefPath = pjoin(fd.project.subpath('.'), 'role-preference.md');
    if (efs(prefPath)) { json(200, { content: rfs(prefPath, 'utf-8') }); }
    else { json(200, { content: '' }); }
    return true;
  }

  if (subPath === '/role-preference' && method === 'PUT') {
    try {
      const body = await readBody();
      if (typeof body.content !== 'string') { json(400, { error: 'Missing content field' }); return true; }
      const { writeTextAtomicSync: wtas } = await import('../../infra/json-files.js');
      const { join: pjoin } = await import('node:path');
      const prefPath = pjoin(fd.project.subpath('.'), 'role-preference.md');
      wtas(prefPath, body.content);
      json(200, { success: true });
    } catch (e: unknown) { json(400, { error: e instanceof Error ? e.message : 'Invalid request' }); }
    return true;
  }

  if (subPath === '/roles' && method === 'GET') {
    const mc = await getModelConfig(fd, projectName);
    const roleConfigs = mc.getRoleConfigs();
    const { RoleRegistry } = await import('../../roles/RoleRegistry.js');
    const registry = new RoleRegistry(projectName);
    const cwd = fd.project.getConfig().cwd;
    if (cwd) registry.discoverRepoRoles(cwd);
    const roles = registry.list().map(r => {
      const rc = roleConfigs.find((c: any) => c.role === r.id);
      return {
        id: r.id, name: r.name, description: r.description, icon: r.icon, color: r.color,
        source: 'built-in' as string,
        enabledModels: rc?.enabledModels ?? [],
        permissions: r.permissions,
        instructions: r.instructions,
      };
    });
    json(200, roles);
    return true;
  }

  if (subPath.match(/^\/roles\/[^/]+$/) && method === 'GET') {
    const roleId = subPath.split('/')[2];
    const { RoleRegistry } = await import('../../roles/RoleRegistry.js');
    const registry = new RoleRegistry(projectName);
    const cwd = fd.project.getConfig().cwd;
    if (cwd) registry.discoverRepoRoles(cwd);
    const role = registry.get(roleId);
    if (!role) { json(404, { error: `Role '${roleId}' not found.` }); return true; }
    const specialists = registry.getSpecialists ? registry.getSpecialists(roleId) : [];
    json(200, { id: role.id, name: role.name, description: role.description, icon: role.icon, color: role.color, permissions: role.permissions, instructions: role.instructions, specialists: specialists ?? [] });
    return true;
  }

  if (subPath.match(/^\/roles\/[^/]+\/models$/) && method === 'PUT') {
    const roleId = subPath.split('/')[2];
    try {
      const body = await readBody();
      if (!Array.isArray(body.models)) { json(400, { error: 'Expected { models: [...] }' }); return true; }
      const mc = await getModelConfig(fd, projectName);
      mc.setRoleEnabledModels(roleId, body.models);
      deps.modelCfgCache.delete(projectName);
      const lm = deps.leadManagers?.get(projectName);
      if (lm) {
        const notice = `Model pool updated for role '${roleId}'. Check flightdeck_model_list for current configuration.`;
        lm.steerLead({ type: 'system_notice', message: notice } as any).catch(() => {});
        lm.steerDirector(notice).catch(() => {});
      }
      json(200, { success: true, enabledModels: mc.getRoleEnabledModels(roleId) });
    } catch (e: unknown) { json(400, { error: e instanceof Error ? e.message : 'Invalid request' }); }
    return true;
  }

  if (subPath.match(/^\/roles\/[^/]+\/prompt$/) && method === 'PUT') {
    const roleId = subPath.split('/')[2];
    try {
      const body = await readBody();
      if (typeof body.content !== 'string') { json(400, { error: 'Missing content field' }); return true; }
      const { writeTextAtomicSync: wtas } = await import('../../infra/json-files.js');
      const { join: pjoin } = await import('node:path');
      const { mkdirSync, existsSync: efs } = await import('node:fs');
      const { FD_HOME: fdHome } = await import('../../cli/constants.js');
      const rolesDir = pjoin(fdHome, 'projects', projectName, 'roles');
      mkdirSync(rolesDir, { recursive: true });
      const { RoleRegistry } = await import('../../roles/RoleRegistry.js');
      const registry = new RoleRegistry(projectName);
      const existing = registry.get(roleId);
      const frontmatter = `---\nid: ${roleId}\nname: ${existing?.name ?? roleId}\ndescription: ${existing?.description ?? ''}\nicon: ${existing?.icon ?? '🔧'}\ncolor: "${existing?.color ?? '#888888'}"\npermissions:\n${Object.entries(existing?.permissions ?? {}).map(([k, v]) => `  ${k}: ${v}`).join('\n')}\n---\n`;
      wtas(pjoin(rolesDir, `${roleId}.md`), frontmatter + body.content);
      json(200, { success: true });
    } catch (e: unknown) { json(400, { error: e instanceof Error ? e.message : 'Invalid request' }); }
    return true;
  }

  if (subPath === '/roles' && method === 'POST') {
    try {
      const body = await readBody();
      if (!body.id || !body.name) { json(400, { error: 'Missing required fields: id, name' }); return true; }
      const { writeTextAtomicSync: wtas } = await import('../../infra/json-files.js');
      const { join: pjoin } = await import('node:path');
      const { mkdirSync } = await import('node:fs');
      const { FD_HOME: fdHome } = await import('../../cli/constants.js');
      const rolesDir = pjoin(fdHome, 'projects', projectName, 'roles');
      mkdirSync(rolesDir, { recursive: true });
      const frontmatter = `---\nid: ${body.id}\nname: ${body.name}\ndescription: ${body.description ?? ''}\nicon: ${body.icon ?? '🔧'}\ncolor: "${body.color ?? '#888888'}"\npermissions:\n  task_claim: true\n  task_submit: true\n  escalate: true\n---\n`;
      wtas(pjoin(rolesDir, `${body.id}.md`), frontmatter + (body.instructions ?? `You are a ${body.name} agent. Complete your assigned tasks.`));
      json(201, { success: true, id: body.id });
    } catch (e: unknown) { json(400, { error: e instanceof Error ? e.message : 'Invalid request' }); }
    return true;
  }

  if (subPath.match(/^\/roles\/[^/]+$/) && method === 'DELETE') {
    const roleId = subPath.split('/')[2];
    try {
      const { join: pjoin } = await import('node:path');
      const { existsSync: efs, unlinkSync } = await import('node:fs');
      const { FD_HOME: fdHome } = await import('../../cli/constants.js');
      const rolePath = pjoin(fdHome, 'projects', projectName, 'roles', `${roleId}.md`);
      if (!efs(rolePath)) { json(404, { error: `Role '${roleId}' not found at project level` }); return true; }
      unlinkSync(rolePath);
      json(200, { success: true });
    } catch (e: unknown) { json(500, { error: e instanceof Error ? e.message : 'Failed to delete role' }); }
    return true;
  }

  if (subPath === '/notifications' && method === 'GET') {
    const cfg = fd.project.getConfig();
    json(200, cfg.notifications ?? { webhooks: [] });
    return true;
  }

  if (subPath === '/notifications' && method === 'PUT') {
    try {
      const body = await readBody();
      if (!body.webhooks || !Array.isArray(body.webhooks)) { json(400, { error: 'Expected { webhooks: [...] }' }); return true; }
      const cfg = fd.project.getConfig();
      cfg.notifications = { webhooks: body.webhooks };
      fd.project.setConfig(cfg);
      const activeNotifier = deps.notifier ?? null;
      if (activeNotifier) {
        activeNotifier.setWebhooks(body.webhooks);
      } else {
        const orchNotifier = fd.orchestrator.getWebhookNotifier();
        if (orchNotifier) orchNotifier.setWebhooks(body.webhooks);
      }
      json(200, { notifications: cfg.notifications, active: true });
    } catch (e: unknown) { json((e instanceof Error && e.message === 'Body too large') ? 413 : 400, { error: e instanceof Error ? e.message : 'Invalid JSON' }); }
    return true;
  }

  if (subPath === '/orchestrator/pause' && method === 'POST') {
    fd.orchestrator.pause(); json(200, { paused: true });
    return true;
  }

  if (subPath === '/orchestrator/resume' && method === 'POST') {
    fd.orchestrator.resume(); json(200, { paused: false });
    return true;
  }

  if (subPath === '/orchestrator/tick' && method === 'POST') {
    try { const result = await fd.orchestrator.tick(); json(200, { ok: true, ...result }); } catch (e: unknown) { json(500, { error: e instanceof Error ? e.message : String(e) }); }
    return true;
  }

  if (subPath === '/orchestrator/status' && method === 'GET') {
    json(200, { paused: fd.orchestrator.paused, running: fd.orchestrator.isRunning() });
    return true;
  }

  return false;
}
