export interface StreamBroadcast {
  delta: string;
  contentType: 'text' | 'thinking' | 'tool_call' | 'tool_result';
  toolName?: string;
}

/** Map a Copilot SDK session event to a WebSocket stream broadcast payload */
export function mapCopilotSdkEvent(event: { type: string; data?: any }): StreamBroadcast | null {
  switch (event.type) {
    case 'assistant.message_delta':
      return { delta: event.data?.deltaContent ?? '', contentType: 'text' };
    case 'assistant.reasoning_delta':
      return { delta: event.data?.deltaContent ?? '', contentType: 'thinking' };
    case 'assistant.intent':
      return { delta: event.data?.intent ?? '', contentType: 'thinking' };
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
