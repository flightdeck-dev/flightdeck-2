import { describe, it, expect } from 'vitest';
import { mapCopilotSdkEvent } from '../../src/agents/copilotSdkEventMapper.js';

describe('Copilot SDK event mapper', () => {
  it('maps assistant.message_delta to text', () => {
    const result = mapCopilotSdkEvent({ type: 'assistant.message_delta', data: { deltaContent: 'hello' } });
    expect(result).toEqual({ delta: 'hello', contentType: 'text' });
  });

  it('maps assistant.reasoning_delta to thinking', () => {
    const result = mapCopilotSdkEvent({ type: 'assistant.reasoning_delta', data: { deltaContent: 'analyzing...' } });
    expect(result).toEqual({ delta: 'analyzing...', contentType: 'thinking' });
  });

  it('maps assistant.intent to thinking', () => {
    const result = mapCopilotSdkEvent({ type: 'assistant.intent', data: { intent: 'Exploring codebase' } });
    expect(result).toEqual({ delta: 'Exploring codebase', contentType: 'thinking' });
  });

  it('maps tool.execution_start to tool_call', () => {
    const result = mapCopilotSdkEvent({
      type: 'tool.execution_start',
      data: { name: 'bash', toolCallId: 'tc-1', arguments: { command: 'ls' } }
    });
    expect(result).not.toBeNull();
    expect(result!.contentType).toBe('tool_call');
    expect(result!.toolName).toBe('bash');
    const parsed = JSON.parse(result!.delta);
    expect(parsed.name).toBe('bash');
    expect(parsed.toolCallId).toBe('tc-1');
    expect(parsed.status).toBe('pending');
  });

  it('maps tool.execution_complete to tool_result', () => {
    const result = mapCopilotSdkEvent({
      type: 'tool.execution_complete',
      data: { name: 'bash', toolCallId: 'tc-1', content: 'file1.txt\nfile2.txt' }
    });
    expect(result).not.toBeNull();
    expect(result!.contentType).toBe('tool_result');
    const parsed = JSON.parse(result!.delta);
    expect(parsed.result).toBe('file1.txt\nfile2.txt');
    expect(parsed.status).toBe('completed');
  });

  it('returns null for unknown events', () => {
    expect(mapCopilotSdkEvent({ type: 'session.idle' })).toBeNull();
    expect(mapCopilotSdkEvent({ type: 'assistant.usage' })).toBeNull();
  });

  it('handles missing data gracefully', () => {
    expect(mapCopilotSdkEvent({ type: 'assistant.message_delta', data: {} })).toEqual({ delta: '', contentType: 'text' });
    expect(mapCopilotSdkEvent({ type: 'tool.execution_start', data: {} })).toBeNull(); // no name
  });
});

  // Persisted events (always emitted, even without streaming: true)
  it('maps assistant.message (persisted) to text', () => {
    const result = mapCopilotSdkEvent({ type: 'assistant.message', data: { content: 'Final answer', messageId: 'msg-1' } });
    expect(result).toEqual({ delta: 'Final answer', contentType: 'text' });
  });

  it('maps assistant.reasoning (persisted) to thinking', () => {
    const result = mapCopilotSdkEvent({ type: 'assistant.reasoning', data: { content: 'Let me think...', reasoningId: 'r-1' } });
    expect(result).toEqual({ delta: 'Let me think...', contentType: 'thinking' });
  });

  it('returns null for assistant.message without content', () => {
    expect(mapCopilotSdkEvent({ type: 'assistant.message', data: {} })).toBeNull();
  });
