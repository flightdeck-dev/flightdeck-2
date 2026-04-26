import type { ProjectScopedDeps } from './types.js';

export async function handleMiscRoutes(
  subPath: string, method: string,
  deps: ProjectScopedDeps,
): Promise<boolean> {
  const { fd, projectName, wsServer, leadManager, json, readBody, req, url, res } = deps;

  if (subPath === '/decisions' && method === 'GET') {
    const limit = parseInt(url.searchParams.get('limit') ?? '20', 10) || 20;
    json(200, fd.decisions.readAll().slice(0, limit));
    return true;
  }

  if (subPath === '/report' && method === 'GET') {
    try {
      const { DailyReport } = await import('../../reporting/DailyReport.js');
      const report = new DailyReport(fd.sqlite, fd.decisions);
      res.writeHead(200, { 'Content-Type': 'text/markdown' });
      res.end(report.generate({}));
    } catch { json(200, { report: 'No report available yet.' }); }
    return true;
  }

  if (subPath === '/specs' && method === 'GET') {
    json(200, fd.listSpecs());
    return true;
  }

  if (subPath.match(/^\/specs\/[^/]+$/) && method === 'GET') {
    const specFilename = decodeURIComponent(subPath.split('/')[2]);
    const spec = fd.specs.read(specFilename);
    if (spec) json(200, spec); else json(404, { error: 'Spec not found' });
    return true;
  }

  if (subPath === '/specs' && method === 'POST') {
    try {
      const body = await readBody();
      if (!body.title || !body.content) { json(400, { error: 'Missing title or content' }); return true; }
      const spec = fd.createSpec(body.title, body.content);
      json(201, spec);
    } catch (e: unknown) { json(400, { error: e instanceof Error ? e.message : 'Invalid JSON' }); }
    return true;
  }

  if (subPath.match(/^\/specs\/[^/]+\/cancel$/) && method === 'POST') {
    const specId = decodeURIComponent(subPath.split('/')[2]);
    const cancelled = fd.sqlite.cancelTasksBySpec(specId as any);
    json(200, { specId, cancelledTasks: cancelled });
    return true;
  }

  if (subPath === '/spec-changes' && method === 'GET') {
    json(200, fd.orchestrator.getRecentSpecChanges());
    return true;
  }

  if (subPath === '/threads' && method === 'GET') {
    json(200, fd.messages?.listThreads() ?? []);
    return true;
  }

  if (subPath === '/threads' && method === 'POST') {
    try {
      const body = await readBody();
      if (!body.originId && !body.origin_id) { json(400, { error: 'Missing originId' }); return true; }
      if (!fd.messages) { json(500, { error: 'MessageStore not available' }); return true; }
      const thread = fd.messages.createThread({ originId: body.originId ?? body.origin_id, title: body.title });
      json(201, thread);
    } catch (e: unknown) { json(400, { error: e instanceof Error ? e.message : 'Invalid JSON' }); }
    return true;
  }

  if (subPath === '/search/sessions' && method === 'GET') {
    const query = url.searchParams.get('query');
    if (!query) { json(400, { error: 'Missing query parameter' }); return true; }
    const limit = parseInt(url.searchParams.get('limit') ?? '20', 10);
    const { SessionStore } = await import('../../acp/SessionStore.js');
    const store = new SessionStore(projectName, fd.sqlite.db);
    const results = store.searchEvents(query, { limit });
    json(200, { count: results.length, results });
    return true;
  }

  if (subPath === '/search' && method === 'GET') {
    const q = url.searchParams.get('q');
    if (!q) { json(400, { error: 'Missing q parameter' }); return true; }
    const limit = parseInt(url.searchParams.get('limit') ?? '20', 10) || 20;

    const allTasks = fd.sqlite.listTasks();
    const matchedTasks = allTasks.filter(t =>
      t.title.toLowerCase().includes(q.toLowerCase()) ||
      (t.description ?? '').toLowerCase().includes(q.toLowerCase())
    ).slice(0, limit);

    const allAgents = fd.sqlite.listAgents(true);
    const matchedAgents = allAgents.filter(a =>
      a.id.toLowerCase().includes(q.toLowerCase()) ||
      (a.role ?? '').toLowerCase().includes(q.toLowerCase())
    ).slice(0, limit);

    const matchedMessages = fd.messages?.searchMessages(q, { limit }) ?? [];

    const source = url.searchParams.get('source');
    const memoryResults: Array<{ source: string; filename: string; line: number; snippet: string }> = [];
    if (!source || source === 'memory') {
      try {
        const { readdirSync, readFileSync } = await import('node:fs');
        const { join: pjoin } = await import('node:path');
        const memDir = fd.project.subpath('memory');
        const searchDir = (dir: string) => {
          try {
            for (const entry of readdirSync(dir, { withFileTypes: true })) {
              const full = pjoin(dir, entry.name);
              if (entry.isDirectory()) { searchDir(full); continue; }
              if (!entry.name.endsWith('.md')) continue;
              try {
                const content = readFileSync(full, 'utf-8');
                const lines = content.split('\n');
                for (let i = 0; i < lines.length; i++) {
                  if (lines[i].toLowerCase().includes(q!.toLowerCase())) {
                    memoryResults.push({ source: 'memory', filename: full.replace(fd.project.subpath('.') + '/', '').replace('memory/', ''), line: i + 1, snippet: lines[i].slice(0, 200) });
                    if (memoryResults.length >= limit) break;
                  }
                }
              } catch {}
              if (memoryResults.length >= limit) break;
            }
          } catch {}
        };
        searchDir(memDir);
      } catch {}
    }

    const results = [
      ...matchedTasks.map(t => ({ source: 'task', id: t.id, title: t.title, state: t.state })),
      ...matchedAgents.map(a => ({ source: 'agent', id: a.id, role: a.role, status: a.status })),
      ...matchedMessages.map(m => ({ source: 'message', id: m.id, content: m.content.slice(0, 200) })),
      ...memoryResults,
    ];

    json(200, {
      results,
      tasks: matchedTasks.map(t => ({ id: t.id, title: t.title, state: t.state, type: 'task' as const })),
      agents: matchedAgents.map(a => ({ id: a.id, name: a.id, role: a.role, status: a.status, type: 'agent' as const })),
      messages: matchedMessages.map(m => ({ id: m.id, content: m.content.slice(0, 200), authorType: m.authorType, authorId: m.authorId, type: 'message' as const })),
      memory: memoryResults,
    });
    return true;
  }

  if (subPath === '/escalate' && method === 'POST') {
    try {
      const body = await readBody();
      const agentId = req.headers['x-agent-id'] as string || 'http-api';
      if (!body.taskId || !body.reason) { json(400, { error: 'Missing taskId or reason' }); return true; }
      const { messageId } = await import('@flightdeck-ai/shared');
      const msg = {
        id: messageId(agentId, 'escalation', Date.now().toString()),
        from: agentId as import('@flightdeck-ai/shared').AgentId,
        to: null, channel: 'escalations',
        content: `ESCALATION for task ${body.taskId}: ${body.reason}`,
        timestamp: new Date().toISOString(),
      };
      fd.sendMessage(msg, 'escalations');
      json(200, { status: 'escalated', taskId: body.taskId });
    } catch (e: unknown) { json(400, { error: e instanceof Error ? e.message : 'Invalid JSON' }); }
    return true;
  }

  if (subPath === '/discuss' && method === 'POST') {
    try {
      const body = await readBody();
      const agentId = req.headers['x-agent-id'] as string || 'http-api';
      if (!body.topic) { json(400, { error: 'Missing topic' }); return true; }
      if (agentId !== 'http-api') {
        const discussCaller = fd.sqlite.getAgent(agentId as import('@flightdeck-ai/shared').AgentId);
        if (discussCaller && discussCaller.role !== 'lead' && discussCaller.role !== 'director') {
          json(403, { error: `Error: Agent '${agentId}' (role: ${discussCaller.role}) cannot create discussions. Only lead/director roles can create discussions. Use flightdeck_escalate() to request one.` }); return true;
        }
      }
      const topicHash = Array.from(body.topic as string).reduce((h: number, c: string) => ((h << 5) - h + c.charCodeAt(0)) | 0, 0);
      const channel = `discuss-${Math.abs(topicHash).toString(36)}-${Date.now().toString(36)}`;
      const now = new Date().toISOString();
      const { messageId } = await import('@flightdeck-ai/shared');
      const initMsg = {
        id: messageId('system', channel, now),
        from: agentId as import('@flightdeck-ai/shared').AgentId,
        to: null, channel,
        content: `Discussion created: "${body.topic}"\nInvitees: ${(body.invitees ?? []).join(', ') || 'open'}\nCreated: ${now}`,
        timestamp: now,
      };
      fd.sendMessage(initMsg, channel);
      json(200, { channel, topic: body.topic, invitees: body.invitees ?? [], createdAt: now });
    } catch (e: unknown) { json(400, { error: e instanceof Error ? e.message : 'Invalid JSON' }); }
    return true;
  }

  if (subPath === '/learnings' && method === 'POST') {
    try {
      const body = await readBody();
      const agentId = req.headers['x-agent-id'] as string || 'http-api';
      if (!body.content) { json(400, { error: 'Missing content' }); return true; }
      const learning = fd.learnings.append({ agentId, content: body.content, tags: body.tags ?? [], category: body.category });
      json(201, learning);
    } catch (e: unknown) { json(400, { error: e instanceof Error ? e.message : 'Invalid JSON' }); }
    return true;
  }

  if (subPath === '/learnings/search' && method === 'GET') {
    const query = url.searchParams.get('query');
    if (!query) { json(400, { error: 'Missing query parameter' }); return true; }
    json(200, fd.learnings.search(query));
    return true;
  }

  if (subPath === '/cron' && method === 'GET') {
    const cronStore = deps.cronStores?.get(projectName);
    if (!cronStore) { json(500, { error: 'Cron not available for this project' }); return true; }
    json(200, cronStore.listJobs());
    return true;
  }

  if (subPath === '/cron' && method === 'POST') {
    const cronStore = deps.cronStores?.get(projectName);
    if (!cronStore) { json(500, { error: 'Cron not available for this project' }); return true; }
    try {
      const body = await readBody();
      if (!body.name || !body.prompt) { json(400, { error: 'Missing required fields: name, prompt' }); return true; }
      const schedule = body.schedule || '0 * * * *';
      const job = cronStore.addJob({
        name: body.name, description: body.description,
        schedule: { kind: 'cron', expr: typeof schedule === 'string' ? schedule : (schedule.cron || schedule.expr || '0 * * * *'), tz: typeof schedule === 'object' ? schedule.tz : undefined },
        prompt: body.prompt, skill: body.skill, enabled: body.enabled ?? true,
      });
      json(201, job);
    } catch (e: unknown) { json((e instanceof Error && e.message === 'Body too large') ? 413 : 400, { error: e instanceof Error ? e.message : 'Invalid JSON' }); }
    return true;
  }

  if (subPath.match(/^\/cron\/[^/]+\/enable$/) && method === 'PUT') {
    const cronStore = deps.cronStores?.get(projectName);
    if (!cronStore) { json(500, { error: 'Cron not available' }); return true; }
    const jobId = subPath.split('/')[2];
    if (cronStore.enableJob(jobId)) json(200, { success: true });
    else json(404, { error: 'Cron job not found' });
    return true;
  }

  if (subPath.match(/^\/cron\/[^/]+\/disable$/) && method === 'PUT') {
    const cronStore = deps.cronStores?.get(projectName);
    if (!cronStore) { json(500, { error: 'Cron not available' }); return true; }
    const jobId = subPath.split('/')[2];
    if (cronStore.disableJob(jobId)) json(200, { success: true });
    else json(404, { error: 'Cron job not found' });
    return true;
  }

  if (subPath.match(/^\/cron\/[^/]+$/) && method === 'DELETE') {
    const cronStore = deps.cronStores?.get(projectName);
    if (!cronStore) { json(500, { error: 'Cron not available' }); return true; }
    const jobId = subPath.split('/')[2];
    if (cronStore.removeJob(jobId)) json(200, { success: true });
    else json(404, { error: 'Cron job not found' });
    return true;
  }

  if (subPath.match(/^\/cron\/[^/]+\/run$/) && method === 'POST') {
    const cronStore = deps.cronStores?.get(projectName);
    const lm = deps.leadManagers.get(projectName);
    if (!cronStore || !lm) { json(500, { error: 'Cron or Lead not available' }); return true; }
    const jobId = subPath.split('/')[2];
    const job = cronStore.getJob(jobId);
    if (!job) { json(404, { error: 'Cron job not found' }); return true; }
    lm.steerLead({ type: 'cron', job: { id: job.id, name: job.name, prompt: job.prompt, skill: job.skill } }).catch(() => {});
    json(202, { status: 'triggered' });
    return true;
  }

  if (subPath === '/escalations' && method === 'GET') {
    const status = url.searchParams.get('status') as 'pending' | 'resolved' | undefined;
    json(200, fd.sqlite.listEscalations(status || undefined));
    return true;
  }

  if (subPath === '/escalations' && method === 'POST') {
    try {
      const body = await readBody();
      const agentId = req.headers['x-agent-id'] as string || 'lead';
      if (!body.title || !body.description) { json(400, { error: 'Missing title or description' }); return true; }
      const esc = fd.sqlite.createEscalation(agentId, body.title, body.description, body.priority);
      if (wsServer) wsServer.broadcast({ type: 'escalation:created', project: projectName, escalation: esc });
      json(201, esc);
    } catch (e: unknown) { json(400, { error: e instanceof Error ? e.message : 'Invalid JSON' }); }
    return true;
  }

  if (subPath.match(/^\/escalations\/\d+\/resolve$/) && method === 'POST') {
    try {
      const id = parseInt(subPath.split('/')[2], 10);
      const body = await readBody();
      if (!body.resolution) { json(400, { error: 'Missing resolution' }); return true; }
      const esc = fd.sqlite.resolveEscalation(id, body.resolution);
      if (!esc) { json(404, { error: 'Escalation not found' }); return true; }
      if (wsServer) wsServer.broadcast({ type: 'escalation:resolved', project: projectName, escalation: esc });
      json(200, { success: true, escalation: esc });
    } catch (e: unknown) { json(400, { error: e instanceof Error ? e.message : 'Invalid JSON' }); }
    return true;
  }

  if (subPath === '/suggestions' && method === 'GET') {
    const specId = url.searchParams.get('spec_id') ?? undefined;
    const status = url.searchParams.get('status') ?? undefined;
    json(200, fd.suggestions.list({ specId, status: status as any }));
    return true;
  }

  if (subPath.match(/^\/suggestions\/[^/]+\/approve$/) && method === 'POST') {
    const id = subPath.split('/')[2];
    const s = fd.suggestions.updateStatus(id, 'approved');
    if (s) json(200, { success: true, suggestion: s }); else json(404, { error: 'Suggestion not found' });
    return true;
  }

  if (subPath.match(/^\/suggestions\/[^/]+\/reject$/) && method === 'POST') {
    const id = subPath.split('/')[2];
    const s = fd.suggestions.updateStatus(id, 'rejected');
    if (s) json(200, { success: true, suggestion: s }); else json(404, { error: 'Suggestion not found' });
    return true;
  }

  if (subPath === '/memory' && method === 'GET') {
    const files = fd.memory.list();
    const result = files.map(f => {
      const content = fd.memory.read(f);
      const size = content ? Buffer.byteLength(content, 'utf-8') : 0;
      return { filename: f, size, preview: content ? content.slice(0, 200) : '' };
    });
    json(200, { files: result });
    return true;
  }

  if (subPath.match(/^\/memory\/[^/]+$/) && method === 'GET') {
    const filename = decodeURIComponent(subPath.split('/')[2]);
    const content = fd.memory.read(filename);
    if (content === null) { json(404, { error: `Memory file not found: ${filename}` }); return true; }
    json(200, { content });
    return true;
  }

  if (subPath.match(/^\/memory\/[^/]+$/) && method === 'PUT') {
    const filename = decodeURIComponent(subPath.split('/')[2]);
    try {
      const body = await readBody();
      fd.writeMemory(filename, body.content);
      json(200, { status: 'written', path: `memory/${filename}` });
    } catch (e: unknown) { json(400, { error: e instanceof Error ? e.message : 'Invalid JSON' }); }
    return true;
  }

  if (subPath === '/memory/daily-log' && method === 'POST') {
    try {
      const body = await readBody();
      if (!body.entry) { json(400, { error: 'Missing entry' }); return true; }
      fd.memory.appendDailyLog(body.entry);
      json(200, { status: 'logged', filename: fd.memory.getDailyLogFilename() });
    } catch (e: unknown) { json(400, { error: e instanceof Error ? e.message : 'Invalid JSON' }); }
    return true;
  }

  if (subPath === '/cost' && method === 'GET') {
    const costCallerId = req.headers['x-agent-id'] as string;
    if (costCallerId) {
      const costCaller = fd.sqlite.getAgent(costCallerId as import('@flightdeck-ai/shared').AgentId);
      if (costCaller && costCaller.role !== 'lead' && costCaller.role !== 'director') {
        json(403, { error: `Error: Agent '${costCallerId}' (role: ${costCaller.role}) cannot view cost reports. Only lead/director roles can view cost reports.` }); return true;
      }
    }
    json(200, { totalCost: fd.sqlite.getTotalCost(), byAgent: fd.sqlite.getCostByAgent(), byTask: fd.sqlite.getCostByTask() });
    return true;
  }

  if (subPath === '/token-usage' && method === 'GET') {
    json(200, { total: fd.sqlite.getTokenUsageTotal(), byAgent: fd.sqlite.getTokenUsageByAgent() });
    return true;
  }

  if (subPath === '/timers' && method === 'POST') {
    try {
      const body = await readBody();
      const agentId = req.headers['x-agent-id'] as string || 'http-api';
      const timer = fd.timers.setTimer(agentId, body.label, body.delayMs, body.message, body.repeat);
      json(200, timer);
    } catch (e: unknown) { json(400, { error: e instanceof Error ? e.message : 'Invalid JSON' }); }
    return true;
  }

  if (subPath === '/timers' && method === 'GET') {
    const agentId = req.headers['x-agent-id'] as string || 'http-api';
    json(200, fd.timers.listTimers(agentId));
    return true;
  }

  if (subPath.match(/^\/timers\/[^/]+$/) && method === 'DELETE') {
    const label = decodeURIComponent(subPath.split('/')[2]);
    const agentId = req.headers['x-agent-id'] as string || 'http-api';
    json(200, { cancelled: fd.timers.cancelTimer(agentId, label) });
    return true;
  }

  if (subPath === '/file-locks' && method === 'GET') {
    json(200, fd.sqlite.listFileLocks());
    return true;
  }

  if (subPath === '/file-locks' && method === 'POST') {
    try {
      const body = await readBody();
      if (!body.filePath) { json(400, { error: 'Missing filePath' }); return true; }
      const agentId = body.agentId ?? req.headers['x-agent-id'] ?? 'unknown';
      const role = body.role ?? req.headers['x-agent-role'] ?? 'worker';
      const success = fd.sqlite.acquireFileLock(body.filePath, agentId, role, body.reason);
      json(success ? 200 : 409, { locked: success, filePath: body.filePath });
    } catch (e: unknown) { json(400, { error: e instanceof Error ? e.message : String(e) }); }
    return true;
  }

  if (subPath.match(/^\/file-locks\//) && method === 'DELETE') {
    try {
      const filePath = decodeURIComponent(subPath.slice('/file-locks/'.length));
      const body = await readBody().catch(() => ({} as Record<string, unknown>));
      const agentId = body?.agentId ?? req.headers['x-agent-id'] ?? '';
      const released = fd.sqlite.releaseFileLock(filePath, agentId);
      json(200, { released, filePath });
    } catch (e: unknown) { json(400, { error: e instanceof Error ? e.message : String(e) }); }
    return true;
  }

  if (subPath === '/isolation/status' && method === 'GET') {
    try {
      const project = fd.project.getConfig();
      const isolationMode = project.isolation ?? 'file_lock';
      const { IsolationManager } = await import('../../isolation/IsolationManager.js');
      const im = new IsolationManager(fd.project.cwd ?? process.cwd(), { mode: isolationMode as 'file_lock' | 'git_worktree' });
      json(200, im.status());
    } catch (e: unknown) { json(500, { error: e instanceof Error ? e.message : String(e) }); }
    return true;
  }

  if (subPath === '/webhook/test' && method === 'POST') {
    const wn = fd.orchestrator.getWebhookNotifier();
    if (wn.count === 0) { json(400, { error: 'No webhooks configured' }); return true; }
    const result = await wn.sendTest();
    json(200, result);
    return true;
  }

  if (subPath === '/skills' && method === 'GET') {
    const { SkillManager } = await import('../../skills/SkillManager.js');
    const sm = new SkillManager(fd.project.cwd ?? process.cwd());
    sm.loadProjectConfig();
    const installed = sm.listInstalledSkills();
    const repoSkills = sm.discoverRepoSkills(process.cwd());
    sm.loadProjectConfig();
    const roleAssignments: Record<string, string[]> = {};
    for (const role of ['lead', 'director', 'worker', 'reviewer'] as const) {
      roleAssignments[role] = sm.getSkillsForRole(role);
    }
    json(200, { installed, repoSkills, roleAssignments });
    return true;
  }

  if (subPath === '/skills/install' && method === 'POST') {
    try {
      const body = await readBody();
      if (!body.source) { json(400, { error: 'Missing source' }); return true; }
      const { SkillManager } = await import('../../skills/SkillManager.js');
      const sm = new SkillManager(fd.project.cwd ?? process.cwd());
      const result = sm.installSkill(body.source);
      if (!result) { json(400, { error: 'Failed to install skill' }); return true; }
      json(200, result);
    } catch (e: unknown) { json(400, { error: e instanceof Error ? e.message : 'Invalid JSON' }); }
    return true;
  }

  if (subPath === '/files' && method === 'GET') {
    const { readdirSync, statSync } = await import('node:fs');
    const { join: pjoin, resolve: resolvePath } = await import('node:path');
    const cfg = fd.project.getConfig();
    const projectCwd = cfg.cwd ?? fd.project.subpath('.');
    const relPath = url.searchParams.get('path') || '';
    try {
      const absPath = resolvePath(projectCwd, relPath);
      if (!absPath.startsWith(resolvePath(projectCwd))) { json(400, { error: 'Invalid path' }); return true; }
      const dirEntries = readdirSync(absPath, { withFileTypes: true })
        .filter(e => e.name !== '.git')
        .map(e => {
          const full = pjoin(absPath, e.name);
          let size = 0;
          try { size = statSync(full).size; } catch {}
          const ext = e.isFile() ? (e.name.includes('.') ? e.name.split('.').pop()! : '') : '';
          return { name: e.name, type: (e.isDirectory() ? 'directory' : 'file') as 'file' | 'directory', size, extension: ext };
        })
        .sort((a, b) => {
          if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
      const parent = relPath ? relPath.split('/').slice(0, -1).join('/') || null : null;
      json(200, { path: relPath, parent, entries: dirEntries });
    } catch {
      json(200, { path: relPath, parent: null, entries: [] });
    }
    return true;
  }

  if (subPath === '/files/read' && method === 'GET') {
    const { readFileSync, statSync: fStatSync } = await import('node:fs');
    const { resolve: resolvePath } = await import('node:path');
    const cfg = fd.project.getConfig();
    const projectCwd = cfg.cwd ?? fd.project.subpath('.');
    const filePath = url.searchParams.get('path');
    if (!filePath) { json(400, { error: 'Missing path parameter' }); return true; }
    const absPath = resolvePath(projectCwd, filePath);
    if (!absPath.startsWith(resolvePath(projectCwd))) { json(400, { error: 'Invalid path' }); return true; }
    try {
      const st = fStatSync(absPath);
      const ext = filePath.includes('.') ? filePath.split('.').pop()!.toLowerCase() : '';
      const textExts = new Set(['md','txt','json','yaml','yml','ts','tsx','js','jsx','dart','py','rs','toml','cfg','sh','html','css','sql','lock','env','gitignore','xml','csv','log','ini','conf','rb','go','java','c','cpp','h','hpp','bat','makefile','dockerfile','ps1','properties']);
      const imageExts: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml' };
      const audioExts: Record<string, string> = { mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4', opus: 'audio/opus' };
      if (imageExts[ext]) {
        const buf = readFileSync(absPath);
        res.writeHead(200, { 'Content-Type': imageExts[ext], 'Content-Length': buf.length.toString(), 'Cache-Control': 'no-cache' });
        res.end(buf);
      } else if (audioExts[ext]) {
        const buf = readFileSync(absPath);
        res.writeHead(200, { 'Content-Type': audioExts[ext], 'Content-Length': buf.length.toString() });
        res.end(buf);
      } else if (textExts.has(ext) || st.size < 512 * 1024) {
        try {
          const content = readFileSync(absPath, 'utf-8');
          json(200, { content, size: st.size, mimeType: 'text/plain' });
        } catch {
          json(200, { size: st.size, mimeType: 'application/octet-stream', binary: true });
        }
      } else {
        json(200, { size: st.size, mimeType: 'application/octet-stream', binary: true });
      }
    } catch (e: unknown) {
      json(404, { error: `File not found: ${filePath}` });
    }
    return true;
  }

  if (subPath === '/files/write' && method === 'PUT') {
    const { writeFileSync, mkdirSync: mkdirSyncFs } = await import('node:fs');
    const { resolve: resolvePath, dirname } = await import('node:path');
    const cfg = fd.project.getConfig();
    const projectCwd = cfg.cwd ?? fd.project.subpath('.');
    try {
      const body = await readBody();
      if (!body.path || typeof body.content !== 'string') { json(400, { error: 'Missing path or content' }); return true; }
      const absPath = resolvePath(projectCwd, body.path);
      if (!absPath.startsWith(resolvePath(projectCwd))) { json(400, { error: 'Invalid path' }); return true; }
      const ext = body.path.includes('.') ? body.path.split('.').pop()!.toLowerCase() : '';
      const textExts = new Set(['md','txt','json','yaml','yml','ts','tsx','js','jsx','dart','py','rs','toml','cfg','sh','html','css','sql','lock','env','gitignore','xml','csv','log','ini','conf','rb','go','java','c','cpp','h','hpp','bat','makefile','dockerfile','ps1','properties']);
      if (!textExts.has(ext)) { json(400, { error: 'Only text files can be written' }); return true; }
      mkdirSyncFs(dirname(absPath), { recursive: true });
      writeFileSync(absPath, body.content, 'utf-8');
      json(200, { success: true, path: body.path });
    } catch (e: unknown) {
      json(400, { error: e instanceof Error ? e.message : 'Write failed' });
    }
    return true;
  }

  if (subPath === '/upload' && method === 'POST') {
    const { mkdirSync: mkdirSyncFs, writeFileSync: writeFileSyncFs } = await import('node:fs');
    const { join: pjoinFs, resolve: resolvePathFs } = await import('node:path');
    const uploadDir = pjoinFs(fd.project.subpath('.'), 'uploads');
    mkdirSyncFs(uploadDir, { recursive: true });

    const ct = req.headers['content-type'] ?? '';
    const MAX_UPLOAD = 10 * 1024 * 1024;

    if (ct.includes('multipart/form-data')) {
      const raw = await new Promise<Buffer>((resolve, reject) => {
        const chunks: Buffer[] = [];
        let size = 0;
        req.on('data', (chunk: Buffer) => { size += chunk.length; if (size > MAX_UPLOAD) { req.destroy(); reject(new Error('Too large')); } chunks.push(chunk); });
        req.on('end', () => resolve(Buffer.concat(chunks)));
        req.on('error', reject);
      });
      const boundaryMatch = ct.match(/boundary=([^;]+)/);
      if (!boundaryMatch) { json(400, { error: 'Missing boundary' }); return true; }
      const boundary = boundaryMatch[1].trim();
      const sep = Buffer.from('--' + boundary);
      const parts: Buffer[] = [];
      let start = 0;
      while (true) {
        const idx = raw.indexOf(sep, start);
        if (idx === -1) break;
        if (start > 0) parts.push(raw.subarray(start, idx));
        start = idx + sep.length;
        if (raw[start] === 0x0d && raw[start + 1] === 0x0a) start += 2;
      }
      if (parts.length === 0) { json(400, { error: 'No file in upload' }); return true; }
      const part = parts[0];
      const headerEnd = part.indexOf('\r\n\r\n');
      if (headerEnd === -1) { json(400, { error: 'Malformed multipart' }); return true; }
      const headerStr = part.subarray(0, headerEnd).toString();
      const fileData = part.subarray(headerEnd + 4, part.length - 2);
      const fnMatch = headerStr.match(/filename="([^"]+)"/);
      const origName = fnMatch ? fnMatch[1].replace(/[^a-zA-Z0-9._-]/g, '_') : 'file';
      const ctMatch = headerStr.match(/Content-Type:\s*(.+)/i);
      const mimeType = ctMatch ? ctMatch[1].trim() : 'application/octet-stream';
      const uniqueName = `${Date.now()}-${origName}`;
      const filePath = pjoinFs(uploadDir, uniqueName);
      writeFileSyncFs(filePath, fileData);
      json(200, { url: `/api/projects/${encodeURIComponent(projectName)}/uploads/${uniqueName}`, filename: origName, size: fileData.length, mimeType });
    } else {
      try {
        const body = await readBody();
        if (!body.data || !body.filename) { json(400, { error: 'Missing data or filename' }); return true; }
        const base64 = body.data.replace(/^data:[^;]+;base64,/, '');
        const buf = Buffer.from(base64, 'base64');
        if (buf.length > MAX_UPLOAD) { json(400, { error: 'Too large' }); return true; }
        const origName = body.filename.replace(/[^a-zA-Z0-9._-]/g, '_');
        const uniqueName = `${Date.now()}-${origName}`;
        const filePath = pjoinFs(uploadDir, uniqueName);
        writeFileSyncFs(filePath, buf);
        json(200, { url: `/api/projects/${encodeURIComponent(projectName)}/uploads/${uniqueName}`, filename: origName, size: buf.length, mimeType: body.mimeType ?? 'application/octet-stream' });
      } catch (e: unknown) { json(400, { error: e instanceof Error ? e.message : 'Upload failed' }); }
    }
    return true;
  }

  if (subPath?.startsWith('/uploads/') && method === 'GET') {
    const { readFileSync: readFileSyncFs, existsSync: existsSyncFs } = await import('node:fs');
    const { join: pjoinFs, resolve: resolvePathFs, basename: basenameFs } = await import('node:path');
    const mimeMap: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.webm': 'audio/webm', '.mp4': 'video/mp4', '.txt': 'text/plain', '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript', '.json': 'application/json', '.pdf': 'application/pdf' };
    const uploadDir = pjoinFs(fd.project.subpath('.'), 'uploads');
    const reqFile = decodeURIComponent(subPath.replace('/uploads/', ''));
    const safeName = basenameFs(reqFile);
    const filePath = resolvePathFs(uploadDir, safeName);
    if (!filePath.startsWith(resolvePathFs(uploadDir)) || !existsSyncFs(filePath)) {
      json(404, { error: 'File not found' }); return true;
    }
    const data = readFileSyncFs(filePath);
    const ext = safeName.includes('.') ? '.' + safeName.split('.').pop()!.toLowerCase() : '';
    const contentType = mimeMap[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': contentType, 'Content-Length': data.length.toString(), 'Cache-Control': 'public, max-age=86400' });
    res.end(data);
    return true;
  }

  return false;
}
