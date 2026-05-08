import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useProject } from '../hooks/useProject.tsx';
import { useAgents } from '../hooks/useAgents.tsx';
import { useWsEventBus } from '../hooks/useWsEventBus.tsx';
import { Radio, Pause, Play, GripVertical, Columns } from 'lucide-react';
import type { Agent } from '../lib/types.ts';

const ROLE_COLORS: Record<string, string> = {
  lead: 'var(--color-status-in-review)',
  director: '#a855f7',
  worker: 'var(--color-status-done)',
  reviewer: '#f59e0b',
  'qa-tester': '#06b6d4',
  'tech-writer': '#8b5cf6',
  'product-thinker': '#ec4899',
};

const ROLE_ICONS: Record<string, string> = {
  lead: '👑',
  director: '💜',
  worker: '👷',
  reviewer: '🔍',
  'qa-tester': '🧪',
  'tech-writer': '📝',
  'product-thinker': '💡',
};

const STATUS_DOT: Record<string, string> = {
  busy: 'bg-green-400 animate-pulse',
  idle: 'bg-yellow-400',
  hibernated: 'bg-gray-400',
  errored: 'bg-red-400',
  retired: 'bg-gray-300',
};

interface StreamChunk {
  content: string;
  contentType: string;
  toolName?: string;
}

function AgentPane({ agent, chunks, paused, height }: { agent: Agent; chunks: StreamChunk[]; paused: boolean; height: number }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const userScrolledUp = useRef(false);

  useEffect(() => {
    if (paused || userScrolledUp.current) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [chunks, paused]);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 30;
    userScrolledUp.current = !atBottom;
  };

  const roleColor = ROLE_COLORS[agent.role] ?? 'var(--color-text-tertiary)';
  const roleIcon = ROLE_ICONS[agent.role] ?? '🤖';
  const statusDot = STATUS_DOT[agent.status] ?? 'bg-gray-400';
  const shortId = agent.id.length > 18 ? agent.id.slice(0, 18) + '…' : agent.id;

  return (
    <div className="border border-[var(--color-border)] rounded-lg overflow-hidden flex flex-col bg-[var(--color-surface)]" style={{ height: `${height}px` }}>
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-[var(--color-border)] bg-[var(--color-surface-secondary)] cursor-grab active:cursor-grabbing"
           draggable="true">
        <GripVertical size={12} className="text-[var(--color-text-tertiary)]" />
        <span>{roleIcon}</span>
        <span className="text-xs font-mono truncate flex-1" style={{ color: roleColor }}>
          {shortId}
        </span>
        <span className={`w-2 h-2 rounded-full ${statusDot}`} />
        <span className="text-[10px] text-[var(--color-text-tertiary)]">{agent.status}</span>
      </div>

      {/* Output stream */}
      <div ref={scrollRef} onScroll={handleScroll}
           className="flex-1 overflow-y-auto px-3 py-1.5 font-mono text-xs leading-tight">
        {chunks.length === 0 ? (
          <span className="text-[var(--color-text-tertiary)] italic">No recent output</span>
        ) : (
          chunks.map((chunk, i) => {
            let color = 'var(--color-text-primary)';
            if (chunk.contentType === 'thinking') color = 'var(--color-text-tertiary)';
            else if (chunk.contentType === 'tool_call') color = '#60a5fa';
            else if (chunk.contentType === 'tool_result') color = 'var(--color-status-done)';

            return (
              <span key={i} style={{ color }} className="whitespace-pre-wrap">
                {chunk.content}
              </span>
            );
          })
        )}
      </div>
    </div>
  );
}

export default function Live() {
  const { projectName, loading: projectLoading } = useProject();
  const { agents, agentStreamChunks } = useAgents();
  const [paused, setPaused] = useState(false);
  const [cols, setCols] = useState<'auto' | 2 | 3 | 4>('auto');
  const [paneHeight, setPaneHeight] = useState(220);
  const [order, setOrder] = useState<string[]>([]); // agent IDs in user-defined order
  const [draggedId, setDraggedId] = useState<string | null>(null);

  // Filter: only show non-hibernated, non-retired agents
  const activeAgents = agents.filter(a => a.status !== 'hibernated' && a.status !== 'retired');

  const activeAgentKey = useMemo(() => activeAgents.map(a => a.id).join(','), [activeAgents]);

  // Sync order with active agents (add new ones at end, remove gone ones)
  useEffect(() => {
    setOrder(prev => {
      const activeIds = new Set(activeAgents.map(a => a.id));
      const kept = prev.filter(id => activeIds.has(id));
      const newIds = activeAgents.filter(a => !prev.includes(a.id)).map(a => a.id);
      return [...kept, ...newIds];
    });
  }, [activeAgentKey]);

  const orderedAgents = order
    .map(id => activeAgents.find(a => a.id === id))
    .filter(Boolean) as Agent[];

  // Drag and drop handlers
  const handleDragStart = (id: string) => setDraggedId(id);
  const handleDragOver = (e: React.DragEvent, targetId: string) => {
    e.preventDefault();
    if (!draggedId || draggedId === targetId) return;
    setOrder(prev => {
      const newOrder = [...prev];
      const fromIdx = newOrder.indexOf(draggedId);
      const toIdx = newOrder.indexOf(targetId);
      if (fromIdx === -1 || toIdx === -1) return prev;
      newOrder.splice(fromIdx, 1);
      newOrder.splice(toIdx, 0, draggedId);
      return newOrder;
    });
  };
  const handleDragEnd = () => setDraggedId(null);

  const gridCols = cols === 'auto'
    ? 'grid-cols-[repeat(auto-fill,minmax(350px,1fr))]'
    : cols === 2 ? 'grid-cols-2'
    : cols === 3 ? 'grid-cols-3'
    : 'grid-cols-4';

  if (projectLoading) {
    return (
      <div className="space-y-4">
        <div className="h-8 w-32 bg-[var(--color-surface-secondary)] rounded animate-pulse" />
        <div className="grid grid-cols-2 gap-4">
          {[1, 2, 3, 4].map(i => (
            <div key={i} className="h-[220px] bg-[var(--color-surface-secondary)] rounded-lg animate-pulse" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold flex items-center gap-2">
          <Radio size={20} className="text-green-400" />
          Live ({activeAgents.length})
        </h1>
        <div className="flex items-center gap-3">
          {/* Columns */}
          <div className="flex items-center gap-1">
            <Columns size={14} className="text-[var(--color-text-tertiary)]" />
            {(['auto', 2, 3, 4] as const).map(c => (
              <button key={c} onClick={() => setCols(c)}
                className={`text-xs px-1.5 py-0.5 rounded ${cols === c ? 'bg-[var(--color-surface-hover)] font-medium' : 'text-[var(--color-text-secondary)]'}`}>
                {c === 'auto' ? 'Auto' : c}
              </button>
            ))}
          </div>
          {/* Height */}
          <div className="flex items-center gap-1 text-xs text-[var(--color-text-secondary)]">
            <span>H</span>
            <input type="range" min={150} max={500} step={10} value={paneHeight}
              onChange={e => setPaneHeight(Number(e.target.value))}
              className="w-16 h-3 accent-[var(--color-primary)]" />
            <span className="w-8 text-right">{paneHeight}</span>
          </div>
          {/* Pause */}
          <button onClick={() => setPaused(!paused)}
            className={`flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-md transition-colors ${paused ? 'bg-yellow-500/10 text-yellow-500' : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]'}`}>
            {paused ? <><Play size={12} /> Resume</> : <><Pause size={12} /> Pause</>}
          </button>
        </div>
      </div>

      {/* Grid */}
      {orderedAgents.length === 0 ? (
        <div className="text-center py-16 text-[var(--color-text-secondary)]">
          <Radio size={40} strokeWidth={1.5} className="mx-auto mb-4 text-[var(--color-text-tertiary)]" />
          <p>No active agents.</p>
          <p className="text-sm mt-1 text-[var(--color-text-tertiary)]">Agents will appear here when they are spawned.</p>
        </div>
      ) : (
        <div className={`grid ${gridCols} gap-3`}>
          {orderedAgents.map(agent => (
            <div key={agent.id}
              onDragStart={() => handleDragStart(agent.id)}
              onDragOver={(e) => handleDragOver(e, agent.id)}
              onDragEnd={handleDragEnd}
              className={`transition-opacity ${draggedId === agent.id ? 'opacity-50' : ''}`}>
              <AgentPane
                agent={agent}
                chunks={agentStreamChunks.get(agent.id) ?? []}
                paused={paused}
                height={paneHeight}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
