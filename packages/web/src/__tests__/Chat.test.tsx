import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

// --- Mocks ---

let mockMessages: any[] = [];
let mockStreamingMessages = new Map();
let mockStreamingChunks = new Map();
const mockSendChat = vi.fn();

vi.mock('../hooks/useChat.tsx', () => ({
  useChat: () => ({
    messages: mockMessages,
    streamingMessages: mockStreamingMessages,
    streamingChunks: mockStreamingChunks,
    toolCallMap: new Map(),
    sendChat: mockSendChat,
    interruptLead: vi.fn(),
  }),
}));

vi.mock('../hooks/useDisplay.tsx', () => ({
  useDisplay: () => ({ displayConfig: { thinking: 'summary', toolCalls: 'summary', flightdeckTools: 'summary' } }),
}));

let mockAgents: any[] = [];
vi.mock('../hooks/useAgents.tsx', () => ({
  useAgents: () => ({ agents: mockAgents }),
}));

let mockConnected = true;
vi.mock('../hooks/useProject.tsx', () => ({
  useProject: () => ({ projectName: 'test-project', connected: mockConnected, loading: false }),
}));

vi.mock('../lib/api.ts', () => ({
  api: {
    getThreads: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock('swr', () => ({
  default: () => ({ data: null, error: null, mutate: vi.fn() }),
  useSWRConfig: () => ({ mutate: vi.fn() }),
}));

// Mock ChatSidePanel to avoid its own dependency chain
vi.mock('../components/ChatSidePanel.tsx', () => ({
  ChatSidePanel: () => <div data-testid="side-panel" />,
}));

// Mock SpeechRecognition
vi.stubGlobal('SpeechRecognition', undefined);
vi.stubGlobal('webkitSpeechRecognition', undefined);

// Mock localStorage
vi.stubGlobal('localStorage', {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
});

// Mock scrollIntoView
Element.prototype.scrollIntoView = vi.fn();

import Chat from '../pages/Chat.tsx';

describe('Chat page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockMessages = [];
    mockStreamingMessages = new Map();
    mockStreamingChunks = new Map();
    mockAgents = [];
    mockConnected = true;
  });

  it('Enter sends message', () => {
    render(<Chat />);
    const textarea = screen.getByPlaceholderText(/Message Lead/);
    fireEvent.change(textarea, { target: { value: 'hello lead' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(mockSendChat).toHaveBeenCalledWith('hello lead', undefined, undefined);
  });

  it('Shift+Enter inserts newline (does not send)', () => {
    render(<Chat />);
    const textarea = screen.getByPlaceholderText(/Message Lead/);
    fireEvent.change(textarea, { target: { value: 'line1' } });
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true });
    expect(mockSendChat).not.toHaveBeenCalled();
  });

  it('"Lead is starting up" shown when no agents and no messages', () => {
    mockAgents = [];
    mockMessages = [{ id: 'msg-1', authorType: 'user', authorId: 'user-1', content: 'hello', createdAt: new Date().toISOString() }];
    render(<Chat />);
    expect(screen.getByText(/Lead is starting up/)).toBeInTheDocument();
  });

  it('"Lead is starting up" hidden when lead agent exists', () => {
    mockAgents = [{ id: 'lead-1', role: 'lead', status: 'busy' }];
    mockMessages = [];
    render(<Chat />);
    expect(screen.queryByText(/Lead is starting up/)).not.toBeInTheDocument();
  });

  it('Input placeholder shows "Message Lead..."', () => {
    render(<Chat />);
    expect(screen.getByPlaceholderText(/Message Lead/)).toBeInTheDocument();
  });

  it('Reply indicator shows when replying', () => {
    mockMessages = [{
      id: 'msg-1',
      authorType: 'lead',
      authorId: 'lead-1',
      content: 'Hello from lead',
      createdAt: new Date().toISOString(),
    }];
    render(<Chat />);
    // Click reply button on the message (hover toolbar)
    const replyBtn = screen.getByLabelText('Reply to message');
    fireEvent.click(replyBtn);
    expect(screen.getByText('Replying to')).toBeInTheDocument();
    expect(screen.getAllByText(/Hello from lead/).length).toBeGreaterThan(0);
  });

  describe('system messages', () => {
    it('error system messages always render (even when systemMessages off)', () => {
      mockMessages = [{
        id: 'sys-err', authorType: 'system', authorId: null,
        content: '⚠️ Failed to spawn agent worker-1',
        createdAt: new Date().toISOString(),
      }];
      render(<Chat />);
      expect(screen.getByText(/Failed to spawn agent worker-1/)).toBeInTheDocument();
    });

    it('notice system messages are hidden when systemMessages is off', () => {
      mockMessages = [{
        id: 'sys-notice', authorType: 'system', authorId: null,
        content: 'Plan approved. 3 tasks moved to pending.',
        createdAt: new Date().toISOString(),
      }];
      render(<Chat />);
      expect(screen.queryByText(/Plan approved/)).not.toBeInTheDocument();
    });

    it('long error content renders collapsed (summary visible, body hidden until expanded)', () => {
      const stack = 'Error: boom\n' + 'at foo (a.ts:1)\n'.repeat(10);
      mockMessages = [{
        id: 'sys-err-long', authorType: 'system', authorId: null,
        content: `⚠️ Failed to spawn agent worker-2\n\n\`\`\`\n${stack}\`\`\``,
        createdAt: new Date().toISOString(),
      }];
      render(<Chat />);
      // Summary line is shown (also present in the collapsible body markdown)
      expect(screen.getAllByText(/Failed to spawn agent worker-2/).length).toBeGreaterThan(0);
      // It's inside a <details> for collapsing
      expect(document.querySelector('details')).toBeTruthy();
    });
  });
});
