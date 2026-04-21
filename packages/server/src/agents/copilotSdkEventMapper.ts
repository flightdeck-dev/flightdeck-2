export interface StreamBroadcast {
  delta: string;
  contentType: 'text' | 'thinking' | 'tool_call' | 'tool_result';
  toolName?: string;
}

/** Map a Copilot SDK session event to a WebSocket stream broadcast payload */
export function mapCopilotSdkEvent(event: { type: string; data?: any }): StreamBroadcast | null {
  switch (event.type) {
    // Ephemeral delta events (streaming: true)
    case 'assistant.message_delta':
      return { delta: event.data?.deltaContent ?? '', contentType: 'text' };
    case 'assistant.reasoning_delta':
      return { delta: event.data?.deltaContent ?? '', contentType: 'thinking' };
    // Persisted events (always emitted)
    case 'assistant.message':
      // Complete message — use as text if no delta events were streamed
      return event.data?.content ? { delta: event.data.content, contentType: 'text' } : null;
    case 'assistant.reasoning':
      // Complete reasoning block
      return event.data?.content ? { delta: event.data.content, contentType: 'thinking' } : null;
    case 'assistant.intent':
      return event.data?.intent ? { delta: event.data.intent, contentType: 'thinking' } : null;
    case 'tool.execution_start': {
      const name = event.data?.name ?? '';
      if (!name) return null;
      return {
        delta: JSON.stringify({ toolCallId: event.data?.toolCallId ?? '', name, input: event.data?.arguments ? JSON.stringify(event.data.arguments) : '', status: 'pending' }),
        contentType: 'tool_call',
        toolName: name,
      };
    }
    case 'tool.execution_complete': {
      const name = event.data?.name ?? '';
      return {
        delta: JSON.stringify({ toolCallId: event.data?.toolCallId ?? '', name, result: event.data?.content ?? '', status: 'completed' }),
        contentType: 'tool_result',
        toolName: name,
      };
    }
    default:
      return null;
  }
}
