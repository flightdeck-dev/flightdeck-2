import { errorJson } from './utils.js';
import type { ProjectScopedDeps } from './types.js';

export async function handleTaskRoutes(
  subPath: string, method: string,
  deps: ProjectScopedDeps,
): Promise<boolean> {
  const { fd, projectName, wsServer, json, readBody, req } = deps;

  function broadcastStateUpdate() {
    if (wsServer) wsServer.broadcast({ type: 'state:update', stats: fd.getTaskStats() });
  }

  if (subPath === '/tasks' && method === 'POST') {
    try {
      const body = await readBody();
      if (!body.title || typeof body.title !== 'string') { json(400, { error: 'Missing required field: title' }); return true; }
      const callerAgentId = req.headers['x-agent-id'] as string;
      if (callerAgentId) {
        const callerAgent = fd.sqlite.getAgent(callerAgentId as import('@flightdeck-ai/shared').AgentId);
        if (!callerAgent) { json(403, { error: `Error: Agent '${callerAgentId}' not found. Check flightdeck_status() to see registered agents.` }); return true; }
        if (callerAgent.role !== 'director') {
          json(403, { error: `Error: Agent '${callerAgentId}' (role: ${callerAgent.role}) cannot add tasks. Only Director can add tasks. Use flightdeck_escalate() to request task creation.` }); return true;
        }
      }
      const task = fd.addTask({ title: body.title, description: body.description, role: body.role || 'worker', needsReview: body.needsReview, notifyLead: body.notifyLead, runtime: body.runtime, model: body.model });
      broadcastStateUpdate();
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

  if (subPath.match(/^\/tasks\/[^/]+\/delegate$/) && method === 'POST') {
    const taskId = subPath.split('/')[2];
    const body = await readBody();
    const agentId = body?.agentId || req.headers['x-agent-id'] as string;
    const delegateContext = body?.context as string | undefined;
    if (!agentId) { json(400, { error: 'Missing agentId in body or X-Agent-Id header' }); return true; }
    try {
      const task = fd.delegateTask(taskId as import('@flightdeck-ai/shared').TaskId, agentId as import('@flightdeck-ai/shared').AgentId);
      broadcastStateUpdate();
      // Steer the assigned agent with task context
      const am = deps.agentManagers.get(deps.projectName);
      if (am) {
        const t = task as any;
        const contextParts = [
          `[SYSTEM] Task assigned: "${task.title}" (ID: ${task.id})`,
          t.description ? `\nDescription: ${t.description}` : '',
          t.acceptanceCriteria ? `\nAcceptance Criteria: ${t.acceptanceCriteria}` : '',
          t.context ? `\nContext: ${t.context}` : '',
          delegateContext ? `\nAdditional context: ${delegateContext}` : '',
        ];
        if (task.dependsOn?.length) {
          const depInfos = task.dependsOn.map(depId => {
            const dep = fd.dag.getTask(depId);
            return dep ? `  - ${dep.title} (${dep.state})` : `  - ${depId}`;
          });
          contextParts.push(`\nDependencies:\n${depInfos.join('\n')}`);
        }
        contextParts.push('\n\nSubmit results with flightdeck_task_submit. If blocked, use flightdeck_escalate.');
        void am.sendToAgent(agentId as import('@flightdeck-ai/shared').AgentId, contextParts.filter(Boolean).join('')).catch(() => {});
      }
      // Audit log: delegation
      fd.sqlite.logActivity(
        req.headers['x-agent-id'] as string || 'system',
        'director',
        'task:delegate',
        `Delegated "${task.title}" to ${agentId}`,
        { taskId: task.id, targetAgent: agentId },
      );
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
      fd.sqlite.logActivity(
        req.headers['x-agent-id'] as string || 'unknown',
        'worker',
        'task:submit',
        `Submitted "${task.title}"`,
        { taskId: task.id, claim: body.claim },
      );
      broadcastStateUpdate();
      json(200, task);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('not running')) {
        const stateMatch = msg.match(/state:\s*(\w+)/);
        const currentState = stateMatch ? stateMatch[1] : 'unknown';
        json(400, { error: `Error: Cannot submit task '${taskId}' — current state is '${currentState}', must be 'running'. Did you forget to call flightdeck_task_delegate() first?` });
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
      broadcastStateUpdate();
      json(200, task);
    } catch (e: unknown) { errorJson(json, e); }
    return true;
  }

  if (subPath.match(/^\/tasks\/[^/]+\/fail$/) && method === 'POST') {
    const taskId = subPath.split('/')[2];
    try {
      const task = fd.failTask(taskId as import('@flightdeck-ai/shared').TaskId);
      fd.sqlite.logActivity(
        req.headers['x-agent-id'] as string || 'unknown',
        'worker',
        'task:fail',
        `Failed "${task.title}"`,
        { taskId: task.id },
      );
      broadcastStateUpdate();
      json(200, task);
    } catch (e: unknown) { errorJson(json, e); }
    return true;
  }

  if (subPath.match(/^\/tasks\/[^/]+\/state$/) && method === 'POST') {
    const taskId = subPath.split('/')[2];
    try {
      const body = await readBody();
      if (!body.state) { json(400, { error: 'Missing required field: state' }); return true; }
      fd.sqlite.updateTaskState(taskId as import('@flightdeck-ai/shared').TaskId, body.state);
      broadcastStateUpdate();
      json(200, fd.sqlite.getTask(taskId as import('@flightdeck-ai/shared').TaskId));
    } catch (e: unknown) { errorJson(json, e); }
    return true;
  }

  if (subPath.match(/^\/tasks\/[^/]+\/description$/) && method === 'POST') {
    const taskId = subPath.split('/')[2];
    try {
      const body = await readBody();
      if (!body.description) { json(400, { error: 'Missing required field: description' }); return true; }
      fd.sqlite.updateTaskDescription(taskId as import('@flightdeck-ai/shared').TaskId, body.description);
      json(200, fd.sqlite.getTask(taskId as import('@flightdeck-ai/shared').TaskId));
    } catch (e: unknown) { errorJson(json, e); }
    return true;
  }

  if (subPath.match(/^\/tasks\/[^/]+\/role$/) && method === 'POST') {
    const taskId = subPath.split('/')[2];
    try {
      const body = await readBody();
      if (!body.role) { json(400, { error: 'Missing required field: role' }); return true; }
      fd.sqlite.updateTaskRole(taskId as import('@flightdeck-ai/shared').TaskId, body.role);
      json(200, fd.sqlite.getTask(taskId as import('@flightdeck-ai/shared').TaskId));
    } catch (e: unknown) { errorJson(json, e); }
    return true;
  }

  if (subPath.match(/^\/tasks\/[^/]+\/cancel$/) && method === 'POST') {
    const taskId = subPath.split('/')[2];
    try {
      const task = fd.cancelTask(taskId as import('@flightdeck-ai/shared').TaskId);
      broadcastStateUpdate();
      json(200, task);
    } catch (e: unknown) { errorJson(json, e); }
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
      broadcastStateUpdate();
      json(200, task);
    } catch (e: unknown) { errorJson(json, e); }
    return true;
  }

  if (subPath.match(/^\/tasks\/[^/]+\/resume$/) && method === 'POST') {
    const taskId = subPath.split('/')[2];
    try {
      const task = fd.resumeTask(taskId as import('@flightdeck-ai/shared').TaskId);
      broadcastStateUpdate();
      json(200, task);
    } catch (e: unknown) { errorJson(json, e); }
    return true;
  }

  if (subPath.match(/^\/tasks\/[^/]+\/retry$/) && method === 'POST') {
    const taskId = subPath.split('/')[2];
    try {
      const task = fd.retryTask(taskId as import('@flightdeck-ai/shared').TaskId);
      broadcastStateUpdate();
      json(200, task);
    } catch (e: unknown) { errorJson(json, e); }
    return true;
  }

  if (subPath.match(/^\/tasks\/[^/]+\/skip$/) && method === 'POST') {
    const taskId = subPath.split('/')[2];
    try {
      const task = fd.skipTask(taskId as import('@flightdeck-ai/shared').TaskId);
      broadcastStateUpdate();
      json(200, task);
    } catch (e: unknown) { errorJson(json, e); }
    return true;
  }

  if (subPath.match(/^\/tasks\/[^/]+\/reopen$/) && method === 'POST') {
    const taskId = subPath.split('/')[2];
    try {
      const task = fd.reopenTask(taskId as import('@flightdeck-ai/shared').TaskId);
      broadcastStateUpdate();
      json(200, task);
    } catch (e: unknown) { errorJson(json, e); }
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
        // Track review rejections and notify Director if repeated
        const comments = fd.sqlite.getTaskComments(taskId as import('@flightdeck-ai/shared').TaskId);
        const rejectionCount = comments.filter((c: any) => c.verdict === 'request_changes').length;
        if (rejectionCount >= 3 && fd.orchestrator) {
          fd.orchestrator.emitDirectorEvent({
            type: 'repeated_review_rejection',
            taskId,
            rejectionCount,
            message: `Task "${taskId}" has been rejected ${rejectionCount} times. Consider reassigning, splitting, or providing clearer acceptance criteria.`,
          });
        }
        json(200, { taskId, verdict: 'request_changes', newState: 'running', feedback: body.comment });
      }
      broadcastStateUpdate();
    } catch (e: unknown) { errorJson(json, e); }
    return true;
  }

  if (subPath.match(/^\/tasks\/[^/]+\/compact$/) && method === 'POST') {
    const taskId = subPath.split('/')[2];
    try {
      const body = await readBody();
      const task = fd.compactTask(taskId as import('@flightdeck-ai/shared').TaskId, body.summary);
      json(200, task);
    } catch (e: unknown) { errorJson(json, e); }
    return true;
  }

  if (subPath.match(/^\/tasks\/[^/]+\/clear-stale$/) && method === 'POST') {
    const taskId = subPath.split('/')[2];
    fd.sqlite.clearTaskStale(taskId as import('@flightdeck-ai/shared').TaskId);
    json(200, { status: 'ok', taskId });
    return true;
  }

  if (subPath.match(/^\/tasks\/[^/]+\/reviewers$/) && method === 'POST') {
    try {
      const taskId = subPath.split('/')[2];
      const body = await readBody();
      const reviewers = Array.isArray(body.reviewers) ? body.reviewers : null;
      const task = fd.setTaskReviewers(taskId as import('@flightdeck-ai/shared').TaskId, reviewers);
      if (!task) { json(404, { error: 'Task not found' }); return true; }
      broadcastStateUpdate();
      json(200, task);
    } catch (e: unknown) { errorJson(json, e); }
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
        if (declareCaller.role !== 'director') {
          json(403, { error: `Error: Agent '${declareCallerId}' (role: ${declareCaller.role}) cannot declare tasks. Only Director can declare tasks. Use flightdeck_escalate() to request task creation.` }); return true;
        }
      }
      const tasks = fd.declareTasks(body.tasks as Parameters<typeof fd.declareTasks>[0]);
      fd.sqlite.logActivity(
        declareCallerId || 'unknown',
        'director',
        'task:declare',
        `Declared ${tasks.length} task(s)`,
        { taskIds: tasks.map((t: any) => t.id), titles: tasks.map((t: any) => t.title) },
      );
      broadcastStateUpdate();
      json(201, tasks);
    } catch (e: unknown) { errorJson(json, e); }
    return true;
  }

  if (subPath.match(/^\/tasks\/[^/]+\/subtasks$/) && method === 'POST') {
    const parentTaskId = subPath.split('/')[2];
    try {
      const body = await readBody();
      if (!Array.isArray(body.tasks)) { json(400, { error: 'Expected { tasks: [...] }' }); return true; }
      const tasks = fd.declareSubTasks(parentTaskId as import('@flightdeck-ai/shared').TaskId, body.tasks as Parameters<typeof fd.declareTasks>[0]);
      broadcastStateUpdate();
      json(201, tasks);
    } catch (e: unknown) { errorJson(json, e); }
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
    } catch (e: unknown) { errorJson(json, e); }
    return true;
  }

  if (subPath === '/tool-events' && method === 'POST') {
    try {
      const body = await readBody();
      if (!body.toolName) { json(400, { error: 'Missing required field: toolName' }); return true; }
      // Broadcast to dashboard (audit logging is handled by daemon-side SDK/ACP hooks)
      if (wsServer) {
        wsServer.broadcast({ type: 'tool:event', project: projectName, ...body });
      }
      json(200, { status: 'ok' });
    } catch (e: unknown) { errorJson(json, e); }
    return true;
  }

  // ── Activity Log ──
  if (subPath === '/activity' && method === 'GET') {
    const url = new URL(req.url!, `http://${req.headers.host}`);
    const agentId = url.searchParams.get('agentId') || undefined;
    const actionType = url.searchParams.get('actionType') || undefined;
    const limit = parseInt(url.searchParams.get('limit') || '100', 10);
    json(200, fd.sqlite.getActivityLog({ agentId, actionType, limit }));
    return true;
  }

  return false;
}
