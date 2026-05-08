import { errorJson } from './utils.js';
import type { ProjectScopedDeps } from './types.js';
import type { ChatMessage } from '../../comms/MessageStore.js';
import { leadResponseEvent } from '../../integrations/WebhookNotifier.js';

export async function handleMessageRoutes(
  subPath: string, method: string,
  deps: ProjectScopedDeps,
): Promise<boolean> {
  const { fd, projectName, wsServer, leadManager, notifier, json, readBody, req, url } = deps;

  // GET /channels/:channel/info
  const channelInfoMatch = subPath.match(/^\/channels\/([^/]+)\/info$/);
  if (channelInfoMatch && method === 'GET') {
    const channel = decodeURIComponent(channelInfoMatch[1]);
    if (fd.messages) {
      const subscribers = fd.messages.getSubscribers(channel);
      const messages = fd.messages.listChannelMessages(channel);
      json(200, { channel, subscribers, messageCount: messages.length });
    } else {
      json(200, { channel, subscribers: [], messageCount: 0 });
    }
    return true;
  }

  // POST /channels/subscribe-agents (batch subscribe)
  if (subPath === '/channels/subscribe-agents' && method === 'POST') {
    try {
      const body = await readBody();
      if (!body.channel) { json(400, { error: 'Missing channel' }); return true; }
      if (!Array.isArray(body.agentIds) || body.agentIds.length === 0) { json(400, { error: 'Missing or empty agentIds array' }); return true; }
      const subscribed: string[] = [];
      for (const agentId of body.agentIds) {
        fd.messages?.subscribe(agentId, body.channel);
        subscribed.push(agentId);
      }
      json(200, { status: 'subscribed', channel: body.channel, agentIds: subscribed });
    } catch (e: unknown) { errorJson(json, e); }
    return true;
  }

  if (subPath === '/channels' && method === 'GET') {
    const includeArchived = url.searchParams.get('includeArchived') === 'true';
    json(200, fd.messages?.listChannels(includeArchived) ?? []);
    return true;
  }

  // POST /channels/create
  if (subPath === '/channels/create' && method === 'POST') {
    try {
      const body = await readBody();
      const agentId = req.headers['x-agent-id'] as string || 'http-api';
      if (!body.name) { json(400, { error: 'Missing channel name' }); return true; }
      const channel = fd.messages?.createChannel(body.name, { description: body.description, createdBy: agentId });
      json(200, channel ?? { name: body.name, description: body.description ?? null, archived: false });
    } catch (e: unknown) { errorJson(json, e); }
    return true;
  }

  // POST /channels/archive
  if (subPath === '/channels/archive' && method === 'POST') {
    try {
      const body = await readBody();
      if (!body.name) { json(400, { error: 'Missing channel name' }); return true; }
      const success = fd.messages?.archiveChannel(body.name) ?? false;
      json(200, { status: success ? 'archived' : 'not_found', channel: body.name });
    } catch (e: unknown) { errorJson(json, e); }
    return true;
  }

  // POST /messages/broadcast
  if (subPath === '/messages/broadcast' && method === 'POST') {
    try {
      const body = await readBody();
      const agentId = req.headers['x-agent-id'] as string || 'http-api';
      if (!body.content) { json(400, { error: 'Missing content' }); return true; }
      // Send to broadcast channel - create it if needed
      const broadcastChannel = 'broadcast';
      fd.messages?.createChannel(broadcastChannel, { description: 'System broadcast channel', createdBy: 'system' });
      const msg = fd.messages?.appendChannelMessage(broadcastChannel, {
        parentId: null, taskId: null, authorType: 'agent', authorId: agentId,
        content: body.content, metadata: null, channel: null, recipient: null,
      });
      // Subscribe all active agents
      const allAgents = fd.sqlite.listAgents();
      for (const agent of allAgents) {
        if (agent.status !== 'retired') {
          fd.messages?.subscribe(agent.id, broadcastChannel);
        }
      }
      json(200, { status: 'broadcast', channel: broadcastChannel, messageId: msg?.id ?? null, recipientCount: allAgents.length });
    } catch (e: unknown) { errorJson(json, e); }
    return true;
  }

  // GET /channels/subscriptions
  if (subPath === '/channels/subscriptions' && method === 'GET') {
    const agentId = req.headers['x-agent-id'] as string;
    if (!agentId) { json(400, { error: 'Missing X-Agent-Id header' }); return true; }
    const subs = fd.messages?.getSubscriptions(agentId) ?? [];
    json(200, subs);
    return true;
  }

  if (subPath === '/channels/subscribe' && method === 'POST') {
    try {
      const body = await readBody();
      const agentId = req.headers['x-agent-id'] as string;
      if (!agentId) { json(400, { error: 'Missing X-Agent-Id header' }); return true; }
      if (!body.channel) { json(400, { error: 'Missing channel' }); return true; }
      fd.messages?.subscribe(agentId, body.channel);
      json(200, { status: 'subscribed', channel: body.channel });
    } catch (e: unknown) { errorJson(json, e); }
    return true;
  }

  if (subPath === '/channels/unsubscribe' && method === 'POST') {
    try {
      const body = await readBody();
      const agentId = req.headers['x-agent-id'] as string;
      if (!agentId) { json(400, { error: 'Missing X-Agent-Id header' }); return true; }
      if (!body.channel) { json(400, { error: 'Missing channel' }); return true; }
      fd.messages?.unsubscribe(agentId, body.channel);
      json(200, { status: 'unsubscribed', channel: body.channel });
    } catch (e: unknown) { errorJson(json, e); }
    return true;
  }

  // GET /messages/:id — single message lookup
  if (subPath.startsWith('/messages/') && !subPath.includes('/send') && !subPath.includes('/read') && method === 'GET') {
    const msgId = subPath.slice('/messages/'.length);
    if (msgId && fd.messages) {
      const msg = fd.messages.getMessage(msgId);
      if (msg) { json(200, msg); } else { json(404, { error: 'Message not found' }); }
    } else {
      json(404, { error: 'Message not found' });
    }
    return true;
  }

  if (subPath === '/messages' && method === 'GET') {
    const channelParam = url.searchParams.get('channel') ?? undefined;
    if (channelParam && fd.messages) {
      const limit = parseInt(url.searchParams.get('limit') ?? '50', 10) || 50;
      json(200, fd.messages.listChannelMessages(channelParam, undefined, limit));
      return true;
    }
    const taskId = url.searchParams.get('task_id') ?? undefined;
    const authorTypesParam = url.searchParams.get('author_types');
    const authorTypes = authorTypesParam ? authorTypesParam.split(',') : undefined;
    const limit = parseInt(url.searchParams.get('limit') ?? '50', 10) || 50;
    const allMsgs = fd.messages?.listMessages({ taskId, limit: limit + 50, authorTypes }) ?? [];
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
        userMsg = fd.messages.createMessage({ parentId: null, taskId: null, authorType: 'user', authorId: body.senderId || 'http-api', content: body.content, metadata: null, source: body.source ?? null, senderId: body.senderId ?? null, senderName: body.senderName ?? null, replyToId: body.replyToId ?? null, attachments: body.attachments ?? null, channelId: body.channelId ?? null });
        if (wsServer) wsServer.broadcast({ type: 'chat:message', project: projectName, message: userMsg });
      }
      if (isAsync) {
        if (leadManager) {
          leadManager.steerLead({ type: 'user_message', message: userMsg ?? { content: body.content as string } as ChatMessage }).then(raw => {
            if (raw?.trim() && raw.trim() !== 'HEARTBEAT_OK' && raw.trim() !== 'FLIGHTDECK_NO_REPLY') {
              if (fd.messages) {
                const leadMsg = fd.messages.createMessage({ parentId: userMsg?.id ?? null, taskId: null, authorType: 'lead', authorId: 'lead', content: raw.trim(), metadata: null });
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
            if (raw?.trim() && raw.trim() !== 'HEARTBEAT_OK' && raw.trim() !== 'FLIGHTDECK_NO_REPLY') {
              leadResponse = raw.trim();
              if (fd.messages) {
                leadMsg = fd.messages.createMessage({ parentId: userMsg?.id ?? null, taskId: null, authorType: 'lead', authorId: 'lead', content: leadResponse, metadata: null });
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
            parentId: body.parentId ?? null, taskId: body.taskId,
            authorType: (senderAgent?.role === 'lead' ? 'lead' : 'agent') as 'lead' | 'agent',
            authorId: agentId, content: body.content, metadata: null,
            replyToId: body.parentId ?? body.replyToId ?? null,
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
            parentId: body.parentId ?? null, taskId: null,
            authorType: 'agent', authorId: agentId,
            content: (body.content as string).length > 4000 ? (body.content as string).slice(0, 4000) + '\n\u2026[truncated]' : body.content,
            metadata: null, channel: `dm:${body.to}`,
            replyToId: body.parentId ?? body.replyToId ?? null,
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
              if (response?.trim() && response.trim() !== 'HEARTBEAT_OK' && response.trim() !== 'FLIGHTDECK_NO_REPLY' && fd.messages) {
                const leadMsg = fd.messages.createMessage({
                  parentId: null, taskId: null,
                  authorType: 'lead', authorId: 'lead', content: response.trim(), metadata: null,
                });
                if (wsServer) wsServer.broadcast({ type: 'chat:message', project: projectName, message: leadMsg });
              }
            }).catch(() => {});
          }
        } else {
          const am = deps.agentManagers.get(projectName)!;
          if (am) {
            const targetAgent = fd.sqlite.getAgent(targetTo as import('@flightdeck-ai/shared').AgentId);
            if (targetAgent?.acpSessionId) {
              am.sendToAgent(targetTo as import('@flightdeck-ai/shared').AgentId, body.content as string).catch(() => {});
            }
          }
        }
        json(200, { status: 'sent', to: body.to, messageId: storedDmMsg?.id ?? null });
      } else if (body.channel) {
        const msg = {
          id: mkMsgId(agentId, body.channel, Date.now().toString()),
          from: agentId as import('@flightdeck-ai/shared').AgentId,
          to: null, channel: body.channel, content: body.content,
          timestamp: new Date().toISOString(),
          parentId: body.parentId ?? null,
          mentions: body.mentions ?? null,
        };
        const { messageId: channelMsgId } = fd.sendMessage(msg, body.channel);
        // Push to all subscribers of this channel (excluding sender)
        if (fd.messages) {
          const subscribers = fd.messages.getSubscribers(body.channel as string);
          const am = deps.agentManagers.get(projectName)!;
          if (am) {
            for (const sub of subscribers) {
              if (sub === agentId) continue; // don't echo to sender
              const subAgent = fd.sqlite.getAgent(sub as import('@flightdeck-ai/shared').AgentId);
              if (subAgent?.acpSessionId) {
                am.sendToAgent(sub as import('@flightdeck-ai/shared').AgentId, `[#${body.channel} from ${agentId}]: ${body.content}`).catch(() => {});
              }
            }
          }
          // Also steer lead if subscribed
          if (subscribers.includes('lead') || subscribers.includes('lead-1')) {
            const lm = deps.leadManagers.get(projectName);
            if (lm) {
              lm.steerLead({ type: 'agent_message', agentId: agentId as string, message: `[#${body.channel}]: ${body.content}` }).catch(() => {});
            }
          }
        }
        json(200, { status: 'sent', channel: body.channel, messageId: channelMsgId });
      } else {
        json(400, { error: 'Must provide to, channel, or taskId' });
      }
    } catch (e: unknown) { errorJson(json, e); }
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
