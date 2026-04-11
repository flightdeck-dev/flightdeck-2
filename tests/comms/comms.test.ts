import { describe, it, expect } from 'vitest';
import { MessageStore } from '../../src/comms/MessageStore.js';
import { type AgentId, type MessageId } from '../../src/core/types.js';

const agent1 = 'ag-alice' as AgentId;
const agent2 = 'ag-bob' as AgentId;

describe('MessageStore', () => {
  it('sends and retrieves a message', () => {
    const store = new MessageStore();
    const msg = store.send({ type: 'direct', from: agent1, to: [agent2], content: 'Hello' });
    expect(msg.id.startsWith('mg-')).toBe(true);
    expect(store.getMessage(msg.id)?.content).toBe('Hello');
  });

  it('tracks delivery status', () => {
    const store = new MessageStore();
    const msg = store.send({ type: 'direct', from: agent1, to: [agent2], content: 'Hi' });
    expect(msg.deliveryStatus).toBe('sent');

    store.markDelivered(msg.id);
    expect(store.getMessage(msg.id)?.deliveryStatus).toBe('delivered');

    store.markRead(msg.id);
    expect(store.getMessage(msg.id)?.deliveryStatus).toBe('read');
  });

  it('builds threads', () => {
    const store = new MessageStore();
    const m1 = store.send({ type: 'group', from: agent1, to: [agent2], content: 'Thread start' });
    store.send({ type: 'group', from: agent2, to: [agent1], content: 'Reply 1', threadId: m1.id });
    store.send({ type: 'group', from: agent1, to: [agent2], content: 'Reply 2', threadId: m1.id });

    const thread = store.getThread(m1.id);
    expect(thread.length).toBe(3); // Including the root
    expect(thread[0].content).toBe('Thread start');
  });

  it('inbox returns messages sorted by priority then time', () => {
    const store = new MessageStore();
    store.send({ type: 'direct', from: agent1, to: [agent2], content: 'Normal', priority: 'normal' });
    store.send({ type: 'direct', from: agent1, to: [agent2], content: 'Critical', priority: 'critical' });
    store.send({ type: 'direct', from: agent1, to: [agent2], content: 'Low', priority: 'low' });

    const inbox = store.getInbox(agent2);
    expect(inbox[0].content).toBe('Critical');
    expect(inbox[inbox.length - 1].content).toBe('Low');
  });

  it('filters unread messages', () => {
    const store = new MessageStore();
    const m1 = store.send({ type: 'direct', from: agent1, to: [agent2], content: 'Read me' });
    store.send({ type: 'direct', from: agent1, to: [agent2], content: 'Unread' });
    store.markRead(m1.id);

    const unread = store.getInbox(agent2, { unreadOnly: true });
    expect(unread.length).toBe(1);
    expect(unread[0].content).toBe('Unread');
  });

  it('coalesces low-priority messages', () => {
    const store = new MessageStore();
    const m1 = store.send({ type: 'system', from: agent1, to: [agent2], content: 'Start', priority: 'low' });
    store.send({ type: 'system', from: agent1, to: [agent2], content: 'Update 1', priority: 'low', threadId: m1.id });
    store.send({ type: 'system', from: agent1, to: [agent2], content: 'Update 2', priority: 'low', threadId: m1.id });

    const coalesced = store.coalesceLowPriority(m1.id);
    expect(coalesced).not.toBeNull();
    expect(coalesced?.content).toContain('Coalesced');
  });
});
