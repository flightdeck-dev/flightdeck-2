import type { ProjectScopedDeps } from './types.js';

export async function handleWorkspaceRoutes(
  subPath: string, method: string,
  deps: ProjectScopedDeps,
): Promise<boolean> {
  const { fd, projectName, json, readBody, req, url, res } = deps;

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
