import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { ListTodo, Bot, Search, FileText, X, ChevronDown, ChevronRight, Check } from 'lucide-react';
import { useTasks } from '../hooks/useTasks.tsx';
import { useAgents } from '../hooks/useAgents.tsx';
import { useProject } from '../hooks/useProject.tsx';
import { STATE_COLORS } from '../lib/constants.ts';
import { api } from '../lib/api.ts';

type PanelTab = 'tasks' | 'agents' | 'search' | 'memory';

const TABS: { id: PanelTab; icon: typeof ListTodo; label: string }[] = [
  { id: 'tasks', icon: ListTodo, label: 'Tasks' },
  { id: 'agents', icon: Bot, label: 'Agents' },
  { id: 'search', icon: Search, label: 'Search' },
  { id: 'memory', icon: FileText, label: 'Memory' },
];

const LS_KEY = 'flightdeck:chat-panel-width';
const LS_OPEN_KEY = 'flightdeck:chat-panel-open';

function timeAgo(date: string | undefined): string {
  if (!date) return '';
  const s = Math.floor((Date.now() - new Date(date).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

// --- Task Panel ---
function TaskPanel() {
  const { tasks } = useTasks();
  const [expandedTask, setExpandedTask] = useState<string | null>(null);
  const [showPending, setShowPending] = useState(false);

  const inProgress = useMemo(() => tasks.filter(t => ['running', 'in_review', 'ready'].includes(t.state)), [tasks]);
  const recent = useMemo(() => {
    const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
    return tasks.filter(t => t.state === 'done' && new Date(t.updatedAt ?? 0).getTime() > dayAgo)
      .sort((a, b) => new Date(b.updatedAt ?? 0).getTime() - new Date(a.updatedAt ?? 0).getTime());
  }, [tasks]);
  const pending = useMemo(() => tasks.filter(t => ['pending', 'blocked', 'planned'].includes(t.state)), [tasks]);

  const TaskItem = ({ task, dimmed }: { task: typeof tasks[0]; dimmed?: boolean }) => (
    <div
      className={`px-2 py-1.5 rounded-md cursor-pointer hover:bg-[var(--color-surface-hover)] transition-colors ${dimmed ? 'opacity-60' : ''}`}
      onClick={() => setExpandedTask(expandedTask === task.id ? null : task.id)}
      role="button"
      tabIndex={0}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setExpandedTask(expandedTask === task.id ? null : task.id); } }}
    >
      <div className="flex items-center gap-2 min-w-0">
        {task.state === 'done' ? (
          <Check size={12} className="shrink-0 text-[var(--color-status-done)]" />
        ) : (
          <span
            className={`w-2 h-2 rounded-full shrink-0 ${task.state === 'running' ? 'animate-pulse' : ''}`}
            style={{ backgroundColor: STATE_COLORS[task.state] ?? 'var(--color-text-tertiary)' }}
          />
        )}
        <span className="text-xs truncate flex-1">{task.title}</span>
        {task.assignedAgent && (
          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-[var(--color-surface-secondary)] text-[var(--color-text-tertiary)] shrink-0 truncate max-w-[80px]">
            {task.assignedAgent.replace(/-[a-z0-9]+$/, '')}
          </span>
        )}
        {dimmed && <span className="text-[10px] text-[var(--color-text-tertiary)] shrink-0">{timeAgo(task.updatedAt)}</span>}
      </div>
      {expandedTask === task.id && (
        <div className="mt-1.5 pl-4 text-xs text-[var(--color-text-secondary)] space-y-1">
          {task.description && <p>{task.description}</p>}
          {task.claim && (
            <div className="text-[10px] text-[var(--color-text-tertiary)]">
              <span className="font-medium">Acceptance:</span> {task.claim}
            </div>
          )}
        </div>
      )}
    </div>
  );

  return (
    <div className="space-y-3">
      {inProgress.length > 0 && (
        <section>
          <h4 className="text-[10px] uppercase tracking-wider text-[var(--color-text-tertiary)] font-medium px-2 mb-1">In Progress</h4>
          {inProgress.map(t => <TaskItem key={t.id} task={t} />)}
        </section>
      )}
      {recent.length > 0 && (
        <section>
          <h4 className="text-[10px] uppercase tracking-wider text-[var(--color-text-tertiary)] font-medium px-2 mb-1">Recent</h4>
          {recent.map(t => <TaskItem key={t.id} task={t} dimmed />)}
        </section>
      )}
      {pending.length > 0 && (
        <section>
          <button
            onClick={() => setShowPending(!showPending)}
            className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-[var(--color-text-tertiary)] font-medium px-2 mb-1 hover:text-[var(--color-text-secondary)]"
            aria-label={`Toggle ${pending.length} pending tasks`}
          >
            {showPending ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
            {pending.length} pending
          </button>
          {showPending && pending.map(t => <TaskItem key={t.id} task={t} />)}
        </section>
      )}
      {tasks.length === 0 && <p className="text-xs text-[var(--color-text-tertiary)] px-2">No tasks</p>}
    </div>
  );
}

// --- Agent Panel ---
function AgentPanel() {
  const { agents } = useAgents();

  return (
    <div className="space-y-1">
      {agents.map(a => (
        <div key={a.id} className="px-2 py-2 rounded-md bg-[var(--color-surface-secondary)] space-y-1">
          <div className="flex items-center gap-2">
            <span
              className={`w-2 h-2 rounded-full shrink-0 ${a.status === 'busy' ? 'animate-pulse' : ''}`}
              style={{ backgroundColor: a.status === 'idle' ? 'var(--color-status-ready)' : a.status === 'busy' ? 'var(--color-status-running)' : 'var(--color-text-tertiary)' }}
            />
            <span className="text-xs font-medium truncate">{a.id.replace(/-[a-z0-9]+$/, '')}</span>
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-[var(--color-surface-hover)] text-[var(--color-text-tertiary)]">{a.role}</span>
          </div>
          <div className="flex items-center gap-2 text-[10px] text-[var(--color-text-tertiary)] pl-4">
            {a.model && <span className="truncate">{a.model}</span>}
            {a.currentTask && <span className="truncate">→ {a.currentTask}</span>}
          </div>
        </div>
      ))}
      {agents.length === 0 && <p className="text-xs text-[var(--color-text-tertiary)] px-2">No agents</p>}
    </div>
  );
}

// --- Search Panel ---
function SearchPanel() {
  const { projectName } = useProject();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Array<{ id: string; content: string; authorType: string; authorId: string }>>([]);
  const [loading, setLoading] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  // #1: Clean up debounce timer on unmount
  useEffect(() => () => clearTimeout(timerRef.current), []);

  const doSearch = useCallback((q: string) => {
    if (!q.trim() || !projectName) { setResults([]); return; }
    setLoading(true);
    api.search(projectName, q, 10).then(r => {
      setResults(r.messages ?? []);
    }).catch(() => setResults([])).finally(() => setLoading(false));
  }, [projectName]);

  const handleChange = (val: string) => {
    setQuery(val);
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => doSearch(val), 300);
  };

  return (
    <div className="space-y-2">
      <input
        value={query}
        onChange={e => handleChange(e.target.value)}
        placeholder="Search messages..."
        className="w-full px-2 py-1.5 text-xs bg-[var(--color-surface-secondary)] border border-[var(--color-border)] rounded-md text-[var(--color-text-primary)] placeholder:text-[var(--color-text-tertiary)] focus:outline-none focus:border-[var(--color-primary)]"
      />
      {loading && <p className="text-[10px] text-[var(--color-text-tertiary)] px-2">Searching...</p>}
      {results.map(r => (
        <div key={r.id} className="px-2 py-1.5 rounded-md hover:bg-[var(--color-surface-hover)] cursor-pointer">
          <div className="text-[10px] text-[var(--color-text-tertiary)]">{r.authorType}{r.authorId ? ` · ${r.authorId.replace(/-[a-z0-9]+$/, '')}` : ''}</div>
          <div className="text-xs text-[var(--color-text-secondary)] truncate">{r.content}</div>
        </div>
      ))}
      {!loading && query && results.length === 0 && <p className="text-[10px] text-[var(--color-text-tertiary)] px-2">No results</p>}
    </div>
  );
}

// --- Memory Panel ---
function MemoryPanel() {
  const { projectName } = useProject();
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // #6: AbortController for memory fetch
  useEffect(() => {
    if (!projectName) return;
    const controller = new AbortController();
    const { signal } = controller;

    fetch(`/api/projects/${encodeURIComponent(projectName)}/memory`, { signal })
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (signal.aborted) return;
        if (data?.files) {
          const summary = data.files.find((f: string) => f.includes('status-summary'));
          if (summary) {
            return fetch(`/api/projects/${encodeURIComponent(projectName)}/memory/${encodeURIComponent(summary)}`, { signal })
              .then(r => r.ok ? r.text() : null);
          }
        }
        return null;
      })
      .then(text => { if (!signal.aborted) setContent(text ?? 'No memory files found.'); })
      .catch(() => { if (!signal.aborted) setContent('Unable to load memory.'); })
      .finally(() => { if (!signal.aborted) setLoading(false); });

    return () => controller.abort();
  }, [projectName]);

  return (
    <div className="text-xs text-[var(--color-text-secondary)] px-1">
      {loading ? <p className="text-[var(--color-text-tertiary)]">Loading...</p> : (
        <pre className="whitespace-pre-wrap font-mono text-[11px] leading-relaxed">{content}</pre>
      )}
    </div>
  );
}

// --- Main Panel ---
export function ChatSidePanel() {
  const [activeTab, setActiveTab] = useState<PanelTab | null>(() => {
    try { return localStorage.getItem(LS_OPEN_KEY) as PanelTab | null; } catch { return null; }
  });
  const [width, setWidth] = useState(() => {
    try { return parseInt(localStorage.getItem(LS_KEY) ?? '320', 10); } catch { return 320; }
  });
  const isOpen = activeTab !== null;
  const dragging = useRef(false);
  const startX = useRef(0);
  const startW = useRef(0);

  // Persist
  useEffect(() => {
    try {
      localStorage.setItem(LS_KEY, String(width));
      if (activeTab) localStorage.setItem(LS_OPEN_KEY, activeTab);
      else localStorage.removeItem(LS_OPEN_KEY);
    } catch {}
  }, [width, activeTab]);

  const handleTabClick = (tab: PanelTab) => {
    setActiveTab(prev => prev === tab ? null : tab);
  };

  // Drag resize
  const onDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragging.current = true;
    startX.current = e.clientX;
    startW.current = width;

    const onMove = (ev: MouseEvent) => {
      if (!dragging.current) return;
      const delta = startX.current - ev.clientX;
      setWidth(Math.max(200, Math.min(600, startW.current + delta)));
    };
    const onUp = () => {
      dragging.current = false;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [width]);

  const tabLabel = TABS.find(t => t.id === activeTab)?.label ?? '';

  return (
    <div className="flex h-full shrink-0">
      {/* Drag handle */}
      {isOpen && (
        <div
          className="w-1 cursor-col-resize hover:bg-[var(--color-primary)] active:bg-[var(--color-primary)] transition-colors"
          onMouseDown={onDragStart}
        />
      )}

      {/* Expanded panel */}
      <div
        className="overflow-hidden bg-[var(--color-surface)] border-l border-[var(--color-border)] flex flex-col"
        style={{
          width: isOpen ? width : 0,
          minWidth: isOpen ? 200 : 0,
          transition: dragging.current ? 'none' : 'width 0.2s ease, min-width 0.2s ease',
        }}
      >
        {isOpen && (
          <>
            <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--color-border)] shrink-0">
              <h3 className="text-sm font-medium text-[var(--color-text-primary)]">{tabLabel}</h3>
              <button
                onClick={() => setActiveTab(null)}
                className="p-1 rounded hover:bg-[var(--color-surface-hover)] text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)]"
                aria-label="Close panel"
              >
                <X size={14} />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-2">
              {activeTab === 'tasks' && <TaskPanel />}
              {activeTab === 'agents' && <AgentPanel />}
              {activeTab === 'search' && <SearchPanel />}
              {activeTab === 'memory' && <MemoryPanel />}
            </div>
          </>
        )}
      </div>

      {/* Icon bar */}
      <div className="w-10 bg-[var(--color-surface)] border-l border-[var(--color-border)] flex flex-col items-center py-2 gap-1 shrink-0">
        {TABS.map(({ id, icon: Icon, label }) => (
          <button
            key={id}
            onClick={() => handleTabClick(id)}
            className={`w-8 h-8 flex items-center justify-center rounded-md transition-colors ${
              activeTab === id
                ? 'bg-[var(--color-primary)]/15 text-[var(--color-primary)]'
                : 'text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-surface-hover)]'
            }`}
            aria-label={label}
          >
            <Icon size={18} strokeWidth={1.5} />
          </button>
        ))}
      </div>
    </div>
  );
}
