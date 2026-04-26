import type { ProjectScopedDeps } from './types.js';

export async function handleCronRoutes(
  subPath: string, method: string,
  deps: ProjectScopedDeps,
): Promise<boolean> {
  const { projectName, json, readBody } = deps;

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

  return false;
}
