import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Search, CheckSquare, Bot, MessageSquare, X } from 'lucide-react';
import { api } from '../lib/api.ts';

type SearchResult =
  | { id: string; title: string; state: string; type: 'task' }
  | { id: string; name: string; role: string; status: string; type: 'agent' }
  | { id: string; content: string; authorType: string; authorId: string; type: 'message' };

function groupResults(results: SearchResult[]) {
  const tasks = results.filter((r): r is Extract<SearchResult, { type: 'task' }> => r.type === 'task');
  const agents = results.filter((r): r is Extract<SearchResult, { type: 'agent' }> => r.type === 'agent');
  const messages = results.filter((r): r is Extract<SearchResult, { type: 'message' }> => r.type === 'message');
  return { tasks, agents, messages };
}

export function SearchDialog({ onClose }: { onClose: () => void }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const { projectName } = useParams();
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  // Debounced search
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!query.trim() || !projectName) {
      setResults([]);
      return;
    }
    // M7: Move setLoading inside timeout to avoid flash of "Searching..." before debounce fires
    debounceRef.current = setTimeout(async () => {
      setLoading(true);
      try {
        const data = await api.search(projectName, query.trim());
        const all: SearchResult[] = [
          ...data.tasks,
          ...data.agents,
          ...data.messages,
        ];
        setResults(all);
        setActiveIndex(0);
      } catch {
        setResults([]);
      } finally {
        setLoading(false);
      }
    }, 300);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [query, projectName]);

  const prefix = projectName ? `/${encodeURIComponent(projectName)}` : '';

  const navigateTo = useCallback((result: SearchResult) => {
    switch (result.type) {
      case 'task': navigate(`${prefix}/tasks`); break;
      case 'agent': navigate(`${prefix}/agents`); break;
      case 'message': navigate(`${prefix}/chat`); break;
    }
    onClose();
  }, [navigate, prefix, onClose]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { onClose(); return; }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex(i => Math.min(i + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex(i => Math.max(i - 1, 0));
    } else if (e.key === 'Enter' && results[activeIndex]) {
      navigateTo(results[activeIndex]);
    }
  };

  // Scroll active item into view
  useEffect(() => {
    const el = listRef.current?.querySelector(`[data-index="${activeIndex}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  const grouped = groupResults(results);

  const renderIcon = (type: string) => {
    switch (type) {
      case 'task': return <CheckSquare size={14} className="text-[var(--color-accent)]" />;
      case 'agent': return <Bot size={14} className="text-[var(--color-success,#22c55e)]" />;
      case 'message': return <MessageSquare size={14} className="text-[var(--color-text-tertiary)]" />;
      default: return null;
    }
  };

  let flatIndex = -1;
  const renderSection = (label: string, items: SearchResult[]) => {
    if (items.length === 0) return null;
    return (
      <div key={label}>
        <div className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-tertiary)]">{label}</div>
        {items.map(item => {
          flatIndex++;
          const idx = flatIndex;
          const isActive = idx === activeIndex;
          return (
            <button
              key={`${item.type}-${item.id}`}
              data-index={idx}
              onClick={() => navigateTo(item)}
              onMouseEnter={() => setActiveIndex(idx)}
              className={`w-full text-left px-3 py-2 text-sm flex items-center gap-2 transition-colors ${
                isActive ? 'bg-[var(--color-surface-hover)] text-[var(--color-text-primary)]' : 'text-[var(--color-text-secondary)]'
              }`}
            >
              {renderIcon(item.type)}
              <span className="truncate">
                {item.type === 'task' ? (item as any).title :
                 item.type === 'agent' ? `${(item as any).name} (${(item as any).role})` :
                 (item as any).content}
              </span>
            </button>
          );
        })}
      </div>
    );
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[20vh] bg-black/40" onClick={onClose}>
      <div
        className="w-full max-w-lg bg-[var(--color-surface)] border border-[var(--color-border)] rounded-xl shadow-2xl overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        {/* Input */}
        <div className="px-3 py-3 border-b border-[var(--color-border)] flex items-center gap-2">
          <Search size={16} className="text-[var(--color-text-tertiary)] shrink-0" />
          <input
            ref={inputRef}
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Search tasks, agents, messages…"
            className="flex-1 bg-transparent text-sm text-[var(--color-text-primary)] placeholder:text-[var(--color-text-tertiary)] focus:outline-none"
          />
          {query && (
            <button onClick={() => setQuery('')} className="text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)]">
              <X size={14} />
            </button>
          )}
        </div>

        {/* Results */}
        <div ref={listRef} className="max-h-80 overflow-y-auto py-1">
          {loading && (
            <p className="px-4 py-6 text-sm text-[var(--color-text-tertiary)] text-center">Searching…</p>
          )}
          {!loading && query && results.length === 0 && (
            <p className="px-4 py-6 text-sm text-[var(--color-text-tertiary)] text-center">No results found</p>
          )}
          {!loading && results.length > 0 && (
            <>
              {renderSection('Tasks', grouped.tasks)}
              {renderSection('Agents', grouped.agents)}
              {renderSection('Messages', grouped.messages)}
            </>
          )}
          {!query && (
            <p className="px-4 py-6 text-sm text-[var(--color-text-tertiary)] text-center">
              Type to search across your project
            </p>
          )}
        </div>

        {/* Footer */}
        <div className="px-3 py-2 border-t border-[var(--color-border)] flex items-center gap-3 text-[10px] text-[var(--color-text-tertiary)]">
          <span><kbd className="font-mono">↑↓</kbd> navigate</span>
          <span><kbd className="font-mono">↵</kbd> open</span>
          <span><kbd className="font-mono">esc</kbd> close</span>
        </div>
      </div>
    </div>
  );
}
