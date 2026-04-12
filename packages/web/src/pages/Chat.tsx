import { useState, useRef, useEffect } from 'react';
import { useFlightdeck } from '../hooks/useFlightdeck.tsx';
import type { ChatMessage } from '../lib/types.ts';

const AUTHOR_STYLES: Record<string, { label: string; color: string; bg: string }> = {
  user: { label: 'You', color: 'var(--color-status-ready)', bg: 'color-mix(in srgb, var(--color-status-ready) 10%, transparent)' },
  lead: { label: 'Lead', color: 'var(--color-status-running)', bg: 'color-mix(in srgb, var(--color-status-running) 10%, transparent)' },
  agent: { label: 'Agent', color: 'var(--color-status-in-review)', bg: 'color-mix(in srgb, var(--color-status-in-review) 10%, transparent)' },
  system: { label: 'System', color: 'var(--color-text-tertiary)', bg: 'transparent' },
};

function MessageBubble({ msg, onReply }: { msg: ChatMessage; onReply: (m: ChatMessage) => void }) {
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
}

function StreamingBubble({ messageId, content }: { messageId: string; content: string }) {
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
        <div className="text-sm mt-0.5 whitespace-pre-wrap break-words">{content}<span className="animate-pulse">▊</span></div>
      </div>
    </div>
  );
}

export default function Chat() {
  const { messages, streamingMessages, sendChat, connected } = useFlightdeck();
  const [input, setInput] = useState('');
  const [replyTo, setReplyTo] = useState<ChatMessage | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Filter to main thread only (no threadId, no taskId)
  const mainMessages = messages.filter(m => !m.threadId && !m.taskId);

  // Auto-scroll on new messages
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [mainMessages.length, streamingMessages.size]);

  const handleSend = () => {
    const text = input.trim();
    if (!text) return;
    sendChat(text, replyTo?.id);
    setInput('');
    setReplyTo(null);
    inputRef.current?.focus();
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
          <MessageBubble key={msg.id} msg={msg} onReply={setReplyTo} />
        ))}
        {streamEntries.map(([id, content]) => (
          <StreamingBubble key={id} messageId={id} content={content} />
        ))}
        <div ref={bottomRef} />
      </div>

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
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={connected ? 'Message Lead... (Enter to send, Shift+Enter for newline)' : 'Connecting...'}
            disabled={!connected}
            rows={1}
            className="flex-1 resize-none bg-[var(--color-surface-secondary)] border border-[var(--color-border)] rounded-lg px-3 py-2 text-sm text-[var(--color-text-primary)] placeholder:text-[var(--color-text-tertiary)] focus:outline-none focus:border-[var(--color-status-ready)] disabled:opacity-50"
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
