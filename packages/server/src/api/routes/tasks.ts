import type { ProjectScopedDeps } from './types.js';

export async function handleTaskRoutes(
  subPath: string, method: string,
  deps: ProjectScopedDeps,
): Promise<boolean> {
  const { fd, projectName, wsServer, json, readBody, req } = deps;

  if (subPath === '/tasks' && method === 'POST') {
    try {
      const body = await readBody();
      if (!body.title || typeof body.title !== 'string') { json(400, { error: 'Missing required field: title' }); return true; }
      const callerAgentId = req.headers['x-agent-id'] as string;
      if (callerAgentId) {
        const callerAgent = fd.sqlite.getAgent(callerAgentId as import('@flightdeck-ai/shared').AgentId);
        if (!callerAgent) { json(403, { error: `Error: Agent '${callerAgentId}' not found. Check flightdeck_status() to see registered agents.` }); return true; }
        if (callerAgent.role !== 'lead' && callerAgent.role !== 'director') {
          json(403, { error: `Error: Agent '${callerAgentId}' (role: ${callerAgent.role}) cannot add tasks. Only lead/director roles can add tasks. Use flightdeck_escalate() to request task creation.` }); return true;
        }
      }
      const task = fd.addTask({ title: body.title, description: body.description, role: body.role || 'worker', needsReview: body.needsReview, notifyLead: body.notifyLead, runtime: body.runtime, model: body.model });
      if (wsServer) wsServer.broadcast({ type: 'state:update', stats: fd.getTaskStats() });
      json(201, task);
    } catch (e: unknown) { json((e instanceof Error && e.message === 'Body too large') ? 413 : 400, { error: e instanceof Error ? e.message : 'Invalid JSON' }); }
    return true;
  }

  if (subPath === '/tasks' && method === 'GET') {
    json(200, fd.listTasks());
    return true;
  }

  if (subPath.match(/^\/tasks\/[^/]+$/) && method === 'GET') {
    const taskId = subPath.split('/').pop()!;
    const task = fd.listTasks().find(t => t.id === taskId);
    if (task) json(200, task); else json(404, { error: 'Task not found' });
    return true;
  }

  if (subPath.match(/^\/tasks\/[^/]+\/claim$/) && method === 'POST') {
    const taskId = subPath.split('/')[2];
    const agentId = req.headers['x-agent-id'] as string;
    if (!agentId) { json(400, { error: 'Missing X-Agent-Id header' }); return true; }
    const callerAgent = fd.sqlite.getAgent(agentId as import('@flightdeck-ai/shared').AgentId);
    if (callerAgent && callerAgent.role !== 'worker') {
      json(403, { error: `Error: Agent '${agentId}' (role: ${callerAgent.role}) cannot claim tasks. Only worker role can claim tasks.` }); return true;
    }
    try {
      const task = fd.claimTask(taskId as import('@flightdeck-ai/shared').TaskId, agentId as import('@flightdeck-ai/shared').AgentId);
      if (wsServer) wsServer.broadcast({ type: 'state:update', stats: fd.getTaskStats() });
      json(200, task);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('Task not found')) {
        json(404, { error: `Error: Task '${taskId}' not found. Use flightdeck_task_list() to see available tasks.` });
      } else {
        json(400, { error: msg });
      }
    }
    return true;
  }

  if (subPath.match(/^\/tasks\/[^/]+\/submit$/) && method === 'POST') {
    const taskId = subPath.split('/')[2];
    try {
      const body = await readBody();
      const task = fd.submitTask(taskId as import('@flightdeck-ai/shared').TaskId, body.claim);
      if (wsServer) wsServer.broadcast({ type: 'state:update', stats: fd.getTaskStats() });
      json(200, task);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('not running')) {
        const stateMatch = msg.match(/state:\s*(\w+)/);
        const currentState = stateMatch ? stateMatch[1] : 'unknown';
        json(400, { error: `Error: Cannot submit task '${taskId}' — current state is '${currentState}', must be 'running'. Did you forget to call flightdeck_task_claim() first?` });
      } else if (msg.includes('Task not found')) {
        json(404, { error: `Error: Task '${taskId}' not found. Use flightdeck_task_list() to see available tasks.` });
      } else {
        json(400, { error: msg });
      }
    }
    return true;
  }

  if (subPath.match(/^\/tasks\/[^/]+\/complete$/) && method === 'POST') {
    const taskId = subPath.split('/')[2];
    try {
      const task = fd.completeTask(taskId as import('@flightdeck-ai/shared').TaskId);
      if (wsServer) wsServer.broadcast({ type: 'state:update', stats: fd.getTaskStats() });
      json(200, task);
    } catch (e: unknown) { json(400, { error: e instanceof Error ? e.message : String(e) }); }
    return true;
  }

  if (subPath.match(/^\/tasks\/[^/]+\/fail$/) && method === 'POST') {
    const taskId = subPath.split('/')[2];
    try {
      const task = fd.failTask(taskId as import('@flightdeck-ai/shared').TaskId);
      if (wsServer) wsServer.broadcast({ type: 'state:update', stats: fd.getTaskStats() });
      json(200, task);
    } catch (e: unknown) { json(400, { error: e instanceof Error ? e.message : String(e) }); }
    return true;
  }

  if (subPath.match(/^\/tasks\/[^/]+\/state$/) && method === 'POST') {
    const taskId = subPath.split('/')[2];
    try {
      const body = await readBody();
      if (!body.state) { json(400, { error: 'Missing required field: state' }); return true; }
      fd.sqlite.updateTaskState(taskId as import('@flightdeck-ai/shared').TaskId, body.state);
      if (wsServer) wsServer.broadcast({ type: 'state:update', stats: fd.getTaskStats() });
      json(200, fd.sqlite.getTask(taskId as import('@flightdeck-ai/shared').TaskId));
    } catch (e: unknown) { json(400, { error: e instanceof Error ? e.message : String(e) }); }
    return true;
  }

  if (subPath.match(/^\/tasks\/[^/]+\/description$/) && method === 'POST') {
    const taskId = subPath.split('/')[2];
    try {
      const body = await readBody();
      if (!body.description) { json(400, { error: 'Missing required field: description' }); return true; }
      fd.sqlite.updateTaskDescription(taskId as import('@flightdeck-ai/shared').TaskId, body.description);
      json(200, fd.sqlite.getTask(taskId as import('@flightdeck-ai/shared').TaskId));
    } catch (e: unknown) { json(400, { error: e instanceof Error ? e.message : String(e) }); }
    return true;
  }

  if (subPath.match(/^\/tasks\/[^/]+\/role$/) && method === 'POST') {
    const taskId = subPath.split('/')[2];
    try {
      const body = await readBody();
      if (!body.role) { json(400, { error: 'Missing required field: role' }); return true; }
      fd.sqlite.updateTaskRole(taskId as import('@flightdeck-ai/shared').TaskId, body.role);
      json(200, fd.sqlite.getTask(taskId as import('@flightdeck-ai/shared').TaskId));
    } catch (e: unknown) { json(400, { error: e instanceof Error ? e.message : String(e) }); }
    return true;
  }

  if (subPath.match(/^\/tasks\/[^/]+\/cancel$/) && method === 'POST') {
    const taskId = subPath.split('/')[2];
    try {
      const task = fd.cancelTask(taskId as import('@flightdeck-ai/shared').TaskId);
      if (wsServer) wsServer.broadcast({ type: 'state:update', stats: fd.getTaskStats() });
      json(200, task);
    } catch (e: unknown) { json(400, { error: e instanceof Error ? e.message : String(e) }); }
    return true;
  }

  if (subPath.match(/^\/tasks\/[^/]+\/pause$/) && method === 'POST') {
    const taskId = subPath.split('/')[2];
    const pauseAgentId = req.headers['x-agent-id'] as string;
    if (pauseAgentId) {
      const pauseAgent = fd.sqlite.getAgent(pauseAgentId as import('@flightdeck-ai/shared').AgentId);
      if (pauseAgent && pauseAgent.role === 'worker') {
        json(403, { error: `Error: Agent '${pauseAgentId}' (role: worker) cannot pause tasks. Only lead/director roles can pause tasks.` }); return true;
      }
    }
    try {
      const task = fd.pauseTask(taskId as import('@flightdeck-ai/shared').TaskId);
      if (wsServer) wsServer.broadcast({ type: 'state:update', stats: fd.getTaskStats() });
      json(200, task);
    } catch (e: unknown) { json(400, { error: e instanceof Error ? e.message : String(e) }); }
    return true;
  }

  if (subPath.match(/^\/tasks\/[^/]+\/resume$/) && method === 'POST') {
    const taskId = subPath.split('/')[2];
    try {
      const task = fd.resumeTask(taskId as import('@flightdeck-ai/shared').TaskId);
      if (wsServer) wsServer.broadcast({ type: 'state:update', stats: fd.getTaskStats() });
      json(200, task);
    } catch (e: unknown) { json(400, { error: e instanceof Error ? e.message : String(e) }); }
    return true;
  }

  if (subPath.match(/^\/tasks\/[^/]+\/retry$/) && method === 'POST') {
    const taskId = subPath.split('/')[2];
    try {
      const task = fd.retryTask(taskId as import('@flightdeck-ai/shared').TaskId);
      if (wsServer) wsServer.broadcast({ type: 'state:update', stats: fd.getTaskStats() });
      json(200, task);
    } catch (e: unknown) { json(400, { error: e instanceof Error ? e.message : String(e) }); }
    return true;
  }

  if (subPath.match(/^\/tasks\/[^/]+\/skip$/) && method === 'POST') {
    const taskId = subPath.split('/')[2];
    try {
      const task = fd.skipTask(taskId as import('@flightdeck-ai/shared').TaskId);
      if (wsServer) wsServer.broadcast({ type: 'state:update', stats: fd.getTaskStats() });
      json(200, task);
    } catch (e: unknown) { json(400, { error: e instanceof Error ? e.message : String(e) }); }
    return true;
  }

  if (subPath.match(/^\/tasks\/[^/]+\/reopen$/) && method === 'POST') {
    const taskId = subPath.split('/')[2];
    try {
      const task = fd.reopenTask(taskId as import('@flightdeck-ai/shared').TaskId);
      if (wsServer) wsServer.broadcast({ type: 'state:update', stats: fd.getTaskStats() });
      json(200, task);
    } catch (e: unknown) { json(400, { error: e instanceof Error ? e.message : String(e) }); }
    return true;
  }

  if (subPath.match(/^\/tasks\/[^/]+\/review$/) && method === 'POST') {
    const taskId = subPath.split('/')[2];
    try {
      const body = await readBody();
      const agentId = req.headers['x-agent-id'] as string;
      if (!body.verdict || !body.comment) { json(400, { error: 'Missing verdict or comment' }); return true; }
      fd.sqlite.addTaskComment(taskId as import('@flightdeck-ai/shared').TaskId, body.comment, (agentId || 'http-api') as import('@flightdeck-ai/shared').AgentId, 'review', body.verdict);
      if (body.verdict === 'approve') {
        fd.dag.completeTask(taskId as import('@flightdeck-ai/shared').TaskId);
        json(200, { taskId, verdict: 'approve', newState: 'done' });
      } else {
        fd.sqlite.updateTaskState(taskId as import('@flightdeck-ai/shared').TaskId, 'running' as import('@flightdeck-ai/shared').TaskState);
        json(200, { taskId, verdict: 'request_changes', newState: 'running', feedback: body.comment });
      }
      if (wsServer) wsServer.broadcast({ type: 'state:update', stats: fd.getTaskStats() });
    } catch (e: unknown) { json(400, { error: e instanceof Error ? e.message : String(e) }); }
    return true;
  }

  if (subPath.match(/^\/tasks\/[^/]+\/compact$/) && method === 'POST') {
    const taskId = subPath.split('/')[2];
    try {
      const body = await readBody();
      const task = fd.compactTask(taskId as import('@flightdeck-ai/shared').TaskId, body.summary);
      json(200, task);
    } catch (e: unknown) { json(400, { error: e instanceof Error ? e.message : String(e) }); }
    return true;
  }

  if (subPath.match(/^\/tasks\/[^/]+\/clear-stale$/) && method === 'POST') {
    const taskId = subPath.split('/')[2];
    fd.sqlite.clearTaskStale(taskId as import('@flightdeck-ai/shared').TaskId);
    json(200, { status: 'ok', taskId });
    return true;
  }

  if (subPath === '/tasks/declare' && method === 'POST') {
    try {
      const body = await readBody();
      if (!Array.isArray(body.tasks)) { json(400, { error: 'Expected { tasks: [...] }' }); return true; }
      const declareCallerId = req.headers['x-agent-id'] as string;
      if (declareCallerId) {
        const declareCaller = fd.sqlite.getAgent(declareCallerId as import('@flightdeck-ai/shared').AgentId);
        if (!declareCaller) { json(403, { error: `Error: Agent '${declareCallerId}' not found. Check flightdeck_status() to see registered agents.` }); return true; }
        if (declareCaller.role !== 'lead' && declareCaller.role !== 'director') {
          json(403, { error: `Error: Agent '${declareCallerId}' (role: ${declareCaller.role}) cannot declare tasks. Only lead/director roles can declare tasks. Use flightdeck_escalate() to request task creation.` }); return true;
        }
      }
      const tasks = fd.declareTasks(body.tasks as Parameters<typeof fd.declareTasks>[0]);
      if (wsServer) wsServer.broadcast({ type: 'state:update', stats: fd.getTaskStats() });
      json(201, tasks);
    } catch (e: unknown) { json(400, { error: e instanceof Error ? e.message : String(e) }); }
    return true;
  }

  if (subPath.match(/^\/tasks\/[^/]+\/subtasks$/) && method === 'POST') {
    const parentTaskId = subPath.split('/')[2];
    try {
      const body = await readBody();
      if (!Array.isArray(body.tasks)) { json(400, { error: 'Expected { tasks: [...] }' }); return true; }
      const tasks = fd.declareSubTasks(parentTaskId as import('@flightdeck-ai/shared').TaskId, body.tasks as Parameters<typeof fd.declareTasks>[0]);
      if (wsServer) wsServer.broadcast({ type: 'state:update', stats: fd.getTaskStats() });
      json(201, tasks);
    } catch (e: unknown) { json(400, { error: e instanceof Error ? e.message : String(e) }); }
    return true;
  }

  if (subPath.match(/^\/tasks\/[^/]+\/events$/) && method === 'GET') {
    const taskId = subPath.split('/')[2];
    json(200, fd.sqlite.getTaskEvents(taskId as import('@flightdeck-ai/shared').TaskId));
    return true;
  }

  if (subPath.match(/^\/tasks\/[^/]+\/comments$/) && method === 'GET') {
    const taskId = subPath.split('/')[2];
    json(200, fd.sqlite.getTaskComments(taskId as import('@flightdeck-ai/shared').TaskId));
    return true;
  }

  if (subPath.match(/^\/tasks\/[^/]+\/comments$/) && method === 'POST') {
    try {
      const body = await readBody();
      const taskId = subPath.split('/')[2];
      if (body.comment) {
        const agentId = req.headers['x-agent-id'] as string || 'http-api';
        const id = fd.sqlite.addTaskComment(taskId as import('@flightdeck-ai/shared').TaskId, body.comment, agentId as import('@flightdeck-ai/shared').AgentId);
        if (wsServer) wsServer.broadcast({ type: 'task:comment', project: projectName, task_id: taskId, message: body.comment });
        json(200, { id, taskId, message: 'Comment added' });
      } else if (body.message) {
        if (wsServer) wsServer.broadcast({ type: 'task:comment', project: projectName, task_id: taskId, message: body.message });
        json(200, { status: 'broadcast' });
      } else {
        json(400, { error: 'Missing required field: comment or message' });
      }
    } catch (e: unknown) { json(400, { error: e instanceof Error ? e.message : 'Invalid JSON' }); }
    return true;
  }

  if (subPath === '/tool-events' && method === 'POST') {
    try {
      const body = await readBody();
      if (!body.toolName) { json(400, { error: 'Missing required field: toolName' }); return true; }
      if (wsServer) {
        wsServer.broadcast({ type: 'tool:event', project: projectName, ...body });
      }
      json(200, { status: 'broadcast' });
    } catch (e: unknown) { json(400, { error: e instanceof Error ? e.message : 'Invalid JSON' }); }
    return true;
  }

  return false;
}
