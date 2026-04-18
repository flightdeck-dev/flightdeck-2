import { useState, useEffect } from 'react';
import { Folder, FolderOpen, ChevronUp, Loader2, X } from 'lucide-react';

interface FolderEntry {
  name: string;
  path: string;
}

interface BrowseResult {
  path: string;
  parent: string;
  entries: FolderEntry[];
  error?: string;
}

interface Props {
  value: string;
  onChange: (path: string) => void;
  onClose: () => void;
}

export function FolderPicker({ value, onChange, onClose }: Props) {
  const [current, setCurrent] = useState(value || '');
  const [parent, setParent] = useState('');
  const [folders, setFolders] = useState<FolderEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const browse = async (path?: string) => {
    setLoading(true);
    setError('');
    try {
      const url = '/api/browse-directory' + (path ? `?path=${encodeURIComponent(path)}` : '');
      const res = await fetch(url);
      const data: BrowseResult = await res.json();
      if (data.error) {
        setError(data.error);
      } else {
        setCurrent(data.path);
        setParent(data.parent);
        setFolders(data.entries || []);
      }
    } catch {
      setError('Failed to browse directory');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    browse(value || undefined);
  }, []);

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="flex flex-col w-full max-w-lg rounded-lg border shadow-xl"
        style={{
          background: 'var(--color-surface-secondary)',
          borderColor: 'var(--color-border)',
          height: '70vh',
          maxHeight: '500px',
        }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center gap-2 px-4 py-3" style={{ borderBottom: '1px solid var(--color-border)' }}>
          <FolderOpen size={16} className="text-amber-500 shrink-0" />
          <span className="text-sm font-semibold" style={{ color: 'var(--color-text-primary)' }}>Select Directory</span>
          <span className="flex-1" />
          <button type="button" onClick={onClose} className="p-1 rounded hover:opacity-80" style={{ color: 'var(--color-text-tertiary)' }} aria-label="Close">
            <X size={14} strokeWidth={1.5} />
          </button>
        </div>

        {/* Current path */}
        <div className="flex items-center gap-2 px-4 py-2" style={{ background: 'var(--color-surface)', borderBottom: '1px solid var(--color-border)' }}>
          <span className="flex-1 truncate text-xs font-mono" style={{ color: 'var(--color-text-secondary)' }} title={current}>{current}</span>
          {parent && parent !== current && (
            <button
              type="button"
              onClick={() => browse(parent)}
              className="p-1 rounded shrink-0 hover:opacity-80"
              style={{ color: 'var(--color-text-secondary)' }}
              title="Go up"
              aria-label="Go to parent directory"
            >
              <ChevronUp size={14} />
            </button>
          )}
        </div>

        {/* Folder list */}
        <div className="flex-1 min-h-0 overflow-y-auto">
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 size={20} className="animate-spin" style={{ color: 'var(--color-text-tertiary)' }} />
            </div>
          ) : error ? (
            <div className="px-4 py-3 text-xs text-red-500">{error}</div>
          ) : folders.length === 0 ? (
            <div className="px-4 py-6 text-xs text-center" style={{ color: 'var(--color-text-tertiary)' }}>No subdirectories</div>
          ) : (
            <div className="py-1">
              {folders.map((f) => (
                <button
                  key={f.path}
                  onClick={() => browse(f.path)}
                  className="w-full text-left flex items-center gap-2 px-4 py-1.5 text-sm transition-colors"
                  style={{ color: 'var(--color-text-primary)' }}
                  onMouseEnter={e => (e.currentTarget.style.background = 'var(--color-surface-hover)')}
                  onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                >
                  <Folder size={16} className="text-amber-500/70 shrink-0" />
                  <span className="truncate">{f.name}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="flex justify-end gap-2 px-4 py-3" style={{ borderTop: '1px solid var(--color-border)' }}>
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 text-xs rounded hover:opacity-80"
            style={{ color: 'var(--color-text-secondary)' }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => { onChange(current); onClose(); }}
            className="px-4 py-1.5 text-xs font-semibold rounded"
            style={{ background: 'var(--color-accent, #2383e2)', color: '#fff' }}
          >
            Select
          </button>
        </div>
      </div>
    </div>
  );
}
