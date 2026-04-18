import { useState, useEffect, useRef } from 'react';
import { Folder, FolderOpen, ChevronUp, Loader2 } from 'lucide-react';
import { Modal } from './Modal.tsx';

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
  const [showNewFolder, setShowNewFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const valueRef = useRef(value);
  valueRef.current = value;

  const browse = async (path?: string) => {
    setLoading(true);
    setError('');
    try {
      const url = '/api/browse-directory' + (path ? `?path=${encodeURIComponent(path)}` : '');
      const res = await fetch(url);
      // #4: Check res.ok before parsing JSON
      if (!res.ok) {
        setError(`Failed to browse directory (${res.status})`);
        setLoading(false);
        return;
      }
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

  // #5: Use ref for value to avoid re-triggering on value changes
  useEffect(() => {
    browse(valueRef.current || undefined);
  }, []);

  const createFolder = async () => {
    if (!newFolderName.trim()) return;
    try {
      await fetch('/api/create-directory', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: current + '/' + newFolderName.trim() }),
      });
      setNewFolderName('');
      setShowNewFolder(false);
      browse(current); // refresh
    } catch { setError('Failed to create directory'); }
  };

  return (
    <Modal onClose={onClose} aria-label="Select Directory" size="md" className="flex flex-col" style={{ height: '70vh', maxHeight: '500px' }}>
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-[var(--color-border)]">
        <FolderOpen size={16} className="text-amber-500 shrink-0" />
        <span className="text-sm font-semibold" style={{ color: 'var(--color-text-primary)' }}>Select Directory</span>
      </div>

      {/* Current path */}
      <div className="flex items-center gap-2 px-4 py-2 bg-[var(--color-surface)] border-b border-[var(--color-border)]">
        <span className="flex-1 truncate text-xs font-mono text-[var(--color-text-secondary)]" title={current}>{current}</span>
        {parent && parent !== current && (
          <button
            type="button"
            onClick={() => browse(parent)}
            className="p-1 rounded shrink-0 hover:opacity-80 text-[var(--color-text-secondary)]"
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
            <Loader2 size={20} className="animate-spin text-[var(--color-text-tertiary)]" />
          </div>
        ) : error ? (
          <div className="px-4 py-3 text-xs text-red-500">{error}</div>
        ) : folders.length === 0 ? (
          <div className="px-4 py-6 text-xs text-center text-[var(--color-text-tertiary)]">No subdirectories</div>
        ) : (
          <div className="py-1">
            {folders.map((f) => (
              <button
                key={f.path}
                onClick={() => browse(f.path)}
                className="w-full text-left flex items-center gap-2 px-4 py-1.5 text-sm transition-colors text-[var(--color-text-primary)] hover:bg-[var(--color-surface-hover)]"
              >
                <Folder size={16} className="text-amber-500/70 shrink-0" />
                <span className="truncate">{f.name}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* New Folder */}
      <div className="px-4 py-2 border-t border-[var(--color-border)]">
        {showNewFolder ? (
          <div className="flex items-center gap-2">
            <input
              autoFocus
              value={newFolderName}
              onChange={e => setNewFolderName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') createFolder(); if (e.key === 'Escape') setShowNewFolder(false); }}
              placeholder="folder name"
              className="flex-1 px-2 py-1 text-xs rounded border font-mono bg-[var(--color-surface)] border-[var(--color-border)] text-[var(--color-text-primary)]"
            />
            <button onClick={createFolder} className="px-2 py-1 text-xs rounded font-medium bg-[var(--color-primary)] text-white">Create</button>
            <button onClick={() => setShowNewFolder(false)} className="px-2 py-1 text-xs text-[var(--color-text-tertiary)]" aria-label="Cancel new folder">✕</button>
          </div>
        ) : (
          <button onClick={() => setShowNewFolder(true)} className="text-xs flex items-center gap-1 hover:opacity-80 text-[var(--color-text-secondary)]">
            + New Folder
          </button>
        )}
      </div>

      {/* Actions */}
      <div className="flex justify-end gap-2 px-4 py-3 border-t border-[var(--color-border)]">
        <button
          type="button"
          onClick={onClose}
          className="px-3 py-1.5 text-xs rounded hover:opacity-80 text-[var(--color-text-secondary)]"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() => { onChange(current); onClose(); }}
          className="px-4 py-1.5 text-xs font-semibold rounded bg-[var(--color-primary)] text-white"
        >
          Select
        </button>
      </div>
    </Modal>
  );
}
