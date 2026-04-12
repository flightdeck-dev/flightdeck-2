import { useState, useRef, useEffect, useCallback, useMemo, memo, Component, type ReactNode, type ErrorInfo } from 'react';
import { useFlightdeck } from '../hooks/useFlightdeck.tsx';
import type { StreamChunk } from '../hooks/useFlightdeck.tsx';
import type { ChatMessage } from '../lib/types.ts';
import { shouldShow, type ContentType } from '@flightdeck-ai/shared/display';

const AUTHOR_STYLES: Record<string, { label: string; color: string; bg: string }> = {
  user: { label: 'You', color: 'var(--color-status-ready)', bg: 'color-mix(in srgb, var(--color-status-ready) 10%, transparent)' },
  lead: { label: 'Lead', color: 'var(--color-status-running)', bg: 'color-mix(in srgb, var(--color-status-running) 10%, transparent)' },
  agent: { label: 'Agent', color: 'var(--color-status-in-review)', bg: 'color-mix(in srgb, var(--color-status-in-review) 10%, transparent)' },
  system: { label: 'System', color: 'var(--color-text-tertiary)', bg: 'transparent' },
};

const MessageBubble = memo(function MessageBubble({ msg, onReply }: { msg: ChatMessage; onReply: (m: ChatMessage) => void }) {
  const style = AUTHOR_STYLES[msg.authorType] ?? AUTHOR_STYLES.system;

  if (msg.authorType === 'system') {
    return (
      <div className="text-center py-1">
        <span className="text-xs text-[var(--color-text-tertiary)]">{msg.content}</span>
      </div>
    );
  }

  return (
    <div className="group flex gap-3 py-2 px-3 rounded-lg hover:bg-[var(--color-surface-hover)] transition-colors">
      <div className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-medium shrink-0"
           style={{ backgroundColor: style.bg, color: style.color }}>
        {style.label[0]}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2">
          <span className="text-sm font-medium" style={{ color: style.color }}>{style.label}</span>
          {msg.authorId && msg.authorType !== 'user' && (
            <span className="text-xs font-mono text-[var(--color-text-tertiary)]">{msg.authorId}</span>
          )}
          <span className="text-xs text-[var(--color-text-tertiary)]">
            {new Date(msg.createdAt).toLocaleTimeString()}
          </span>
        </div>
        <div className="text-sm mt-0.5 whitespace-pre-wrap break-words">{msg.content}</div>
      </div>
      <button
        onClick={() => onReply(msg)}
        className="opacity-0 group-hover:opacity-100 text-xs text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)] transition-opacity shrink-0 self-start mt-1"
        title="Reply"
      >
        ↩
      </button>
    </div>
  );
});

function StreamingBubble({ messageId, content, chunks, displayConfig }: {
  messageId: string;
  content: string;
  chunks?: StreamChunk[];
  displayConfig: import('@flightdeck-ai/shared').DisplayConfig;
}) {
  // Group chunks by content type for filtered rendering
  const sections = groupChunks(chunks ?? [{ content, contentType: 'text' }]);

  return (
    <div className="flex gap-3 py-2 px-3">
      <div className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-medium shrink-0"
           style={{ backgroundColor: AUTHOR_STYLES.lead.bg, color: AUTHOR_STYLES.lead.color }}>
        L
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2">
          <span className="text-sm font-medium" style={{ color: AUTHOR_STYLES.lead.color }}>Lead</span>
          <span className="text-xs text-[var(--color-text-tertiary)]">typing...</span>
        </div>
        <div className="mt-0.5 space-y-1">
          {sections.map((section, i) => {
            if (!shouldShow(displayConfig, section.contentType, section.toolName)) return null;
            if (section.contentType === 'thinking') {
              return <ThinkingBlock key={i} content={section.content} />;
            }
            if (section.contentType === 'tool_call' || section.contentType === 'flightdeck_tool_call') {
              const level = section.contentType === 'flightdeck_tool_call'
                ? displayConfig.flightdeckTools : displayConfig.toolCalls;
              return <ToolCallBlock key={i} content={section.content} toolName={section.toolName} level={level} />;
            }
            if (section.contentType === 'tool_result' || section.contentType === 'flightdeck_tool_result') {
              const level = section.contentType === 'flightdeck_tool_result'
                ? displayConfig.flightdeckTools : displayConfig.toolCalls;
              return <ToolResultBlock key={i} content={section.content} toolName={section.toolName} level={level} />;
            }
            return <span key={i} className="text-sm whitespace-pre-wrap break-words">{section.content}</span>;
          })}
          <span className="animate-pulse">▊</span>
        </div>
      </div>
    </div>
  );
}

interface ChunkSection {
  contentType: ContentType;
  toolName?: string;
  content: string;
}

function groupChunks(chunks: StreamChunk[]): ChunkSection[] {
  const sections: ChunkSection[] = [];
  for (const chunk of chunks) {
    const ct = chunk.contentType ?? 'text';
    const last = sections[sections.length - 1];
    if (last && last.contentType === ct && last.toolName === chunk.toolName) {
      last.content += chunk.content;
    } else {
      sections.push({ contentType: ct, toolName: chunk.toolName, content: chunk.content });
    }
  }
  return sections;
}

function ThinkingBlock({ content }: { content: string }) {
  const preview = content.split('\n').slice(0, 2).join('\n');
  const isLong = content.length > 200;
  return (
    <details className="rounded bg-[var(--color-surface-secondary)] border border-[var(--color-border)]">
      <summary className="px-3 py-1.5 text-xs text-[var(--color-text-tertiary)] italic font-mono cursor-pointer select-none">
        🧠 {isLong ? preview.slice(0, 120) + '...' : preview}
      </summary>
      <div className="px-3 py-2 text-xs text-[var(--color-text-secondary)] italic font-mono max-h-64 overflow-y-auto whitespace-pre-wrap">
        {content}
      </div>
    </details>
  );
}

function ToolCallBlock({ content, toolName, level }: { content: string; toolName?: string; level: 'summary' | 'detail' | 'off' }) {
  if (level === 'off') return null;
  if (level === 'summary') {
    const brief = content.slice(0, 80).replace(/\n/g, ' ');
    return (
      <details className="inline-block">
        <summary className="text-xs px-2 py-0.5 rounded-full bg-[color-mix(in_srgb,var(--color-status-running)_15%,transparent)] text-[var(--color-status-running)] cursor-pointer select-none">
          🔧 {toolName ?? 'tool'}({brief})
        </summary>
        <div className="mt-1 px-3 py-2 text-xs font-mono bg-[var(--color-surface-secondary)] border border-[var(--color-border)] rounded max-h-48 overflow-y-auto whitespace-pre-wrap">
          {content}
        </div>
      </details>
    );
  }
  // detail
  return (
    <details open className="rounded border border-[var(--color-border)] bg-[var(--color-surface-secondary)]">
      <summary className="px-3 py-1.5 text-xs font-medium cursor-pointer select-none">
        🔧 {toolName ?? 'tool'}
      </summary>
      <div className="px-3 py-2 text-xs font-mono max-h-64 overflow-y-auto whitespace-pre-wrap">
        {content}
      </div>
    </details>
  );
}

function ToolResultBlock({ content, toolName, level }: { content: string; toolName?: string; level: 'summary' | 'detail' | 'off' }) {
  if (level === 'off') return null;
  if (level === 'summary') {
    const brief = content.slice(0, 60).replace(/\n/g, ' ');
    return (
      <span className="text-xs text-[var(--color-text-tertiary)] font-mono">
        → {brief}{content.length > 60 ? '...' : ''}
      </span>
    );
  }
  return (
    <details className="rounded border border-[var(--color-border)] bg-[var(--color-surface-secondary)]">
      <summary className="px-3 py-1.5 text-xs text-[var(--color-text-secondary)] cursor-pointer select-none">
        Result from {toolName ?? 'tool'}
      </summary>
      <div className="px-3 py-2 text-xs font-mono max-h-64 overflow-y-auto whitespace-pre-wrap">
        {content}
      </div>
    </details>
  );
}

class MessageAreaErrorBoundary extends Component<{ children: ReactNode }, { hasError: boolean; error: Error | null }> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { hasError: false, error: null };
  }
  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('MessageArea error:', error, info);
  }
  render() {
    if (this.state.hasError) {
      return (
        <div className="flex-1 flex items-center justify-center text-[var(--color-text-secondary)]">
          <div className="text-center">
            <p className="text-2xl mb-2">⚠️</p>
            <p>Something went wrong rendering messages.</p>
            <p className="text-xs mt-1 text-[var(--color-text-tertiary)]">{this.state.error?.message}</p>
            <button
              onClick={() => this.setState({ hasError: false, error: null })}
              className="mt-3 px-3 py-1 text-sm rounded border border-[var(--color-border)] hover:bg-[var(--color-surface-secondary)]"
            >Retry</button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

export default function Chat() {
  const { messages, streamingMessages, streamingChunks, displayConfig, sendChat, connected } = useFlightdeck();
  const [input, setInput] = useState('');
  const [replyTo, setReplyTo] = useState<ChatMessage | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Filter to main thread only (no threadId, no taskId)
  const mainMessages = useMemo(() => messages.filter(m => !m.threadId && !m.taskId), [messages]);

  const handleReply = useCallback((m: ChatMessage) => setReplyTo(m), []);

  // Auto-scroll on new messages
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [mainMessages.length, streamingMessages.size]);

  const handleSend = useCallback(() => {
    const text = input.trim();
    if (!text) return;
    sendChat(text, replyTo?.id);
    setInput('');
    setReplyTo(null);
    inputRef.current?.focus();
  }, [input, replyTo, sendChat]);

  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
    const el = e.target;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 128) + 'px';
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
    if (e.key === 'Escape' && replyTo) {
      setReplyTo(null);
    }
  };

  // Streaming messages not yet in messages list
  const streamEntries = [...streamingMessages.entries()].filter(
    ([id]) => !messages.some(m => m.id === id)
  );

  return (
    <div className="flex flex-col h-full max-w-4xl mx-auto -m-8">
      {/* Messages */}
      <MessageAreaErrorBoundary>
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-1">
        {mainMessages.length === 0 && streamEntries.length === 0 && (
          <div className="text-center py-16 text-[var(--color-text-secondary)]">
            <p className="text-4xl mb-4">💬</p>
            <p>No messages yet.</p>
            <p className="text-sm mt-1">
              {connected ? 'Send a message to start a conversation with Lead.' : 'Waiting for connection to daemon...'}
            </p>
          </div>
        )}
        {mainMessages.map(msg => (
          <MessageBubble key={msg.id} msg={msg} onReply={handleReply} />
        ))}
        {streamEntries.map(([id, content]) => (
          <StreamingBubble
            key={id}
            messageId={id}
            content={content}
            chunks={streamingChunks.get(id)}
            displayConfig={displayConfig}
          />
        ))}
        <div ref={bottomRef} />
      </div>
      </MessageAreaErrorBoundary>

      {/* Input area */}
      <div className="border-t border-[var(--color-border)] px-4 py-3 bg-[var(--color-surface)]">
        {replyTo && (
          <div className="flex items-center gap-2 mb-2 px-3 py-1.5 rounded bg-[var(--color-surface-secondary)] text-xs">
            <span className="text-[var(--color-text-tertiary)]">Replying to</span>
            <span className="font-medium">{AUTHOR_STYLES[replyTo.authorType]?.label}</span>
            <span className="text-[var(--color-text-secondary)] truncate flex-1">{replyTo.content.slice(0, 80)}</span>
            <button onClick={() => setReplyTo(null)} className="text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)]">✕</button>
          </div>
        )}
        <div className="flex gap-2">
          <textarea
            ref={inputRef}
            value={input}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            placeholder={connected ? 'Message Lead... (Enter to send, Shift+Enter for newline)' : 'Connecting...'}
            disabled={!connected}
            rows={1}
            className="flex-1 resize-none bg-[var(--color-surface-secondary)] border border-[var(--color-border)] rounded-lg px-3 py-2 text-sm text-[var(--color-text-primary)] placeholder:text-[var(--color-text-tertiary)] focus:outline-none focus:border-[var(--color-status-ready)] disabled:opacity-50 max-h-32 overflow-y-auto"
          />
          <button
            onClick={handleSend}
            disabled={!connected || !input.trim()}
            className="px-4 py-2 rounded-lg bg-[var(--color-status-ready)] text-white text-sm font-medium hover:opacity-90 disabled:opacity-30 transition-opacity"
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
}
