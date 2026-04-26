import type { ProjectScopedDeps } from './types.js';
import type { ChatMessage } from '../../comms/MessageStore.js';
import { leadResponseEvent } from '../../integrations/WebhookNotifier.js';

export async function handleMessageRoutes(
  subPath: string, method: string,
  deps: ProjectScopedDeps,
): Promise<boolean> {
  const { fd, projectName, wsServer, leadManager, notifier, json, readBody, req, url } = deps;

  if (subPath === '/messages' && method === 'GET') {
    const channelParam = url.searchParams.get('channel') ?? undefined;
    if (channelParam && fd.messages) {
      const limit = parseInt(url.searchParams.get('limit') ?? '50', 10) || 50;
      json(200, fd.messages.listChannelMessages(channelParam, undefined, limit));
      return true;
    }
    const threadId = url.searchParams.get('thread_id') ?? undefined;
    const taskId = url.searchParams.get('task_id') ?? undefined;
    const authorTypesParam = url.searchParams.get('author_types');
    const authorTypes = authorTypesParam ? authorTypesParam.split(',') : undefined;
    const limit = parseInt(url.searchParams.get('limit') ?? '50', 10) || 50;
    const allMsgs = fd.messages?.listMessages({ threadId, taskId, limit: limit + 50, authorTypes }) ?? [];
    const mainChatMsgs = allMsgs.filter(m => !m.channel?.startsWith('dm:'));
    json(200, mainChatMsgs.slice(-limit).reverse());
    return true;
  }

  if (subPath === '/messages' && method === 'POST') {
    try {
      const body = await readBody();
      if (!body.content || typeof body.content !== 'string') { json(400, { error: 'Missing required field: content' }); return true; }
      const isAsync = url.searchParams.get('async') === 'true' || url.searchParams.get('async') === '1';
      let userMsg = null;
      if (fd.messages) {
        userMsg = fd.messages.createMessage({ threadId: null, parentId: null, taskId: null, authorType: 'user', authorId: body.senderId || 'http-api', content: body.content, metadata: null, source: body.source ?? null, senderId: body.senderId ?? null, senderName: body.senderName ?? null, replyToId: body.replyToId ?? null, attachments: body.attachments ?? null, channelId: body.channelId ?? null });
        if (wsServer) wsServer.broadcast({ type: 'chat:message', project: projectName, message: userMsg });
      }
      if (isAsync) {
        if (leadManager) {
          leadManager.steerLead({ type: 'user_message', message: userMsg ?? { content: body.content as string } as ChatMessage }).then(raw => {
            if (raw?.trim() && raw.trim() !== 'FLIGHTDECK_IDLE' && raw.trim() !== 'FLIGHTDECK_NO_REPLY') {
              if (fd.messages) {
                const leadMsg = fd.messages.createMessage({ threadId: null, parentId: userMsg?.id ?? null, taskId: null, authorType: 'lead', authorId: 'lead', content: raw.trim(), metadata: null });
                if (wsServer) wsServer.broadcast({ type: 'chat:message', project: projectName, message: leadMsg });
              }
              if (notifier) notifier.notify(leadResponseEvent(projectName, raw.trim(), body.content));
            }
          }).catch(err => { console.error('Failed to steer Lead (async):', err instanceof Error ? err.message : String(err)); });
        }
        json(202, { message: userMsg, status: 'accepted' });
      } else {
        let leadResponse: string | null = null;
        let leadMsg = null;
        if (leadManager) {
          try {
            const raw = await leadManager.steerLead({ type: 'user_message', message: userMsg ?? { content: body.content as string } as ChatMessage });
            if (raw?.trim() && raw.trim() !== 'FLIGHTDECK_IDLE' && raw.trim() !== 'FLIGHTDECK_NO_REPLY') {
              leadResponse = raw.trim();
              if (fd.messages) {
                leadMsg = fd.messages.createMessage({ threadId: null, parentId: userMsg?.id ?? null, taskId: null, authorType: 'lead', authorId: 'lead', content: leadResponse, metadata: null });
                if (wsServer) wsServer.broadcast({ type: 'chat:message', project: projectName, message: leadMsg });
              }
              if (notifier) notifier.notify(leadResponseEvent(projectName, leadResponse, body.content));
            }
          } catch (err: unknown) { console.error('Failed to steer Lead:', err instanceof Error ? err.message : String(err)); }
        }
        json(200, { message: userMsg, response: leadMsg ?? leadResponse });
      }
    } catch (e: unknown) { json((e instanceof Error && e.message === 'Body too large') ? 413 : 400, { error: e instanceof Error ? e.message : 'Invalid JSON' }); }
    return true;
  }

  if (subPath === '/messages/send' && method === 'POST') {
    try {
      const body = await readBody();
      const agentId = req.headers['x-agent-id'] as string || 'http-api';
      if (!body.content) { json(400, { error: 'Missing content' }); return true; }
      const { messageId: mkMsgId } = await import('@flightdeck-ai/shared');
      if (body.taskId) {
        if (fd.messages) {
          const senderAgent = fd.sqlite.getAgent(agentId as import('@flightdeck-ai/shared').AgentId);
          const msg = fd.messages.createMessage({
            threadId: null, parentId: body.parentId ?? null, taskId: body.taskId,
            authorType: (senderAgent?.role === 'lead' ? 'lead' : 'agent') as 'lead' | 'agent',
            authorId: agentId, content: body.content, metadata: null,
          });
          if (wsServer) wsServer.broadcast({ type: 'task:comment', project: projectName, task_id: body.taskId, message: msg });
          json(200, { status: 'sent', taskId: body.taskId, messageId: msg.id });
        } else {
          json(500, { error: 'MessageStore not available' });
        }
      } else if (body.to) {
        let storedDmMsg: any = null;
        if (fd.messages) {
          storedDmMsg = fd.messages.createMessage({
            threadId: null, parentId: body.parentId ?? null, taskId: null,
            authorType: 'agent', authorId: agentId,
            content: (body.content as string).length > 4000 ? (body.content as string).slice(0, 4000) + '\n\u2026[truncated]' : body.content,
            metadata: null, channel: `dm:${body.to}`,
          });
        }
        if (wsServer && storedDmMsg) {
          wsServer.broadcast({ type: 'dm:message', project: projectName, message: storedDmMsg });
        }
        const msg = {
          id: mkMsgId(agentId, body.to, Date.now().toString()),
          from: agentId as import('@flightdeck-ai/shared').AgentId,
          to: body.to as import('@flightdeck-ai/shared').AgentId,
          channel: null, content: body.content,
          timestamp: new Date().toISOString(),
          parentId: body.parentId ?? null,
        };
        fd.sendMessage(msg);
        const targetTo = body.to as string;
        if (targetTo === 'director' || targetTo.startsWith('director-')) {
          const lm = deps.leadManagers.get(projectName);
          if (lm) lm.steerDirector?.(`[DM from ${agentId}]: ${body.content}`).catch(() => {});
        } else if (targetTo === 'lead' || targetTo.startsWith('lead-')) {
          const lm = deps.leadManagers.get(projectName);
          if (lm) {
            lm.steerLead({ type: 'agent_message', agentId: agentId as string, message: body.content as string }).then(response => {
              if (response?.trim() && response.trim() !== 'FLIGHTDECK_IDLE' && response.trim() !== 'FLIGHTDECK_NO_REPLY' && fd.messages) {
                const leadMsg = fd.messages.createMessage({
                  threadId: null, parentId: null, taskId: null,
                  authorType: 'lead', authorId: 'lead', content: response.trim(), metadata: null,
                });
                if (wsServer) wsServer.broadcast({ type: 'chat:message', project: projectName, message: leadMsg });
              }
            }).catch(() => {});
          }
        } else {
          const am = deps.agentManagers?.get(projectName) ?? fd.agentManager;
          if (am) {
            const targetAgent = fd.sqlite.getAgent(targetTo as import('@flightdeck-ai/shared').AgentId);
            if (targetAgent?.acpSessionId) {
              am.sendToAgent(targetTo as import('@flightdeck-ai/shared').AgentId, body.content as string).catch(() => {});
            }
          }
        }
        json(200, { status: 'sent', to: body.to });
      } else if (body.channel) {
        const msg = {
          id: mkMsgId(agentId, body.channel, Date.now().toString()),
          from: agentId as import('@flightdeck-ai/shared').AgentId,
          to: null, channel: body.channel, content: body.content,
          timestamp: new Date().toISOString(),
          parentId: body.parentId ?? null,
        };
        fd.sendMessage(msg, body.channel);
        json(200, { status: 'sent', channel: body.channel });
      } else {
        json(400, { error: 'Must provide to, channel, or taskId' });
      }
    } catch (e: unknown) { json(400, { error: e instanceof Error ? e.message : 'Invalid JSON' }); }
    return true;
  }

  if (subPath === '/messages/read' && method === 'GET') {
    const channel = url.searchParams.get('channel') ?? undefined;
    const since = url.searchParams.get('since') ?? undefined;
    const agentId = req.headers['x-agent-id'] as string;
    if (channel) {
      json(200, fd.readMessages(channel, since));
    } else {
      if (!agentId) { json(400, { error: 'Missing X-Agent-Id header for DM inbox' }); return true; }
      const unread = fd.getUnreadDMs(agentId as import('@flightdeck-ai/shared').AgentId);
      fd.markDMsRead(agentId as import('@flightdeck-ai/shared').AgentId);
      json(200, unread.length === 0
        ? { status: 'empty', messages: [] }
        : { status: 'unread', count: unread.length, messages: unread.map(m => ({ from: m.from, content: m.content, timestamp: m.timestamp })) });
    }
    return true;
  }

  return false;
}
