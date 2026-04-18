import { useState, useEffect, useCallback } from 'react';
import { useProject } from '../hooks/useProject.tsx';
import { Folder, FolderOpen, FileText, FileCode, Image, Music, File, ChevronRight, ChevronDown, Edit3, Save, X, Loader2, PanelLeftClose, PanelLeft } from 'lucide-react';

interface FileEntry {
  name: string;
  type: 'file' | 'directory';
  size: number;
  extension: string;
}

interface DirListing {
  path: string;
  parent: string | null;
  entries: FileEntry[];
}

const TEXT_EXTS = new Set(['md', 'txt', 'json', 'yaml', 'yml', 'ts', 'tsx', 'js', 'jsx', 'dart', 'py', 'rs', 'toml', 'cfg', 'sh', 'html', 'css', 'sql', 'lock', 'env', 'gitignore', 'dockerignore', 'dockerfile', 'makefile', 'xml', 'svg', 'csv', 'log', 'ini', 'conf', 'properties', 'bat', 'ps1', 'rb', 'go', 'java', 'c', 'cpp', 'h', 'hpp']);
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg']);
const AUDIO_EXTS = new Set(['mp3', 'wav', 'ogg', 'm4a', 'opus']);

function getFileIcon(ext: string, size: number) {
  const s = size ?? 14;
  if (IMAGE_EXTS.has(ext)) return <Image size={s} strokeWidth={1.5} className="text-purple-400 shrink-0" />;
  if (AUDIO_EXTS.has(ext)) return <Music size={s} strokeWidth={1.5} className="text-green-400 shrink-0" />;
  if (['ts', 'tsx', 'js', 'jsx', 'py', 'rs', 'go', 'java', 'c', 'cpp', 'rb', 'dart'].includes(ext)) return <FileCode size={s} strokeWidth={1.5} className="text-blue-400 shrink-0" />;
  if (TEXT_EXTS.has(ext)) return <FileText size={s} strokeWidth={1.5} className="text-[var(--color-text-tertiary)] shrink-0" />;
  return <File size={s} strokeWidth={1.5} className="text-[var(--color-text-tertiary)] shrink-0" />;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// Auto-collapsing dirs

function TreeNode({ entry, basePath, projectName, selectedPath, onSelect }: {
  entry: FileEntry;
  basePath: string;
  projectName: string;
  selectedPath: string | null;
  onSelect: (path: string, entry: FileEntry) => void;
}) {
  const fullPath = basePath ? `${basePath}/${entry.name}` : entry.name;
  const [expanded, setExpanded] = useState(false);
  const [children, setChildren] = useState<FileEntry[] | null>(null);
  const [loading, setLoading] = useState(false);

  const isDir = entry.type === 'directory';
  const isSelected = selectedPath === fullPath;

  const loadChildren = useCallback(async () => {
    if (children !== null) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(projectName)}/files?path=${encodeURIComponent(fullPath)}`);
      if (res.ok) {
        const data: DirListing = await res.json();
        setChildren(data.entries);
      }
    } catch { /* ignore */ }
    setLoading(false);
  }, [children, fullPath, projectName]);

  const handleClick = () => {
    if (isDir) {
      const next = !expanded;
      setExpanded(next);
      if (next) loadChildren();
    } else {
      onSelect(fullPath, entry);
    }
  };

  return (
    <div>
      <div
        onClick={handleClick}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleClick(); } }}
        role="treeitem"
        tabIndex={0}
        className={`flex items-center gap-1.5 px-2 py-0.5 cursor-pointer text-xs rounded transition-colors ${
          isSelected ? 'bg-[var(--color-surface-hover)] text-[var(--color-text-primary)]' : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]'
        }`}
      >
        {isDir ? (
          <>
            {loading ? <Loader2 size={12} className="animate-spin shrink-0" /> : expanded ? <ChevronDown size={12} className="shrink-0" /> : <ChevronRight size={12} className="shrink-0" />}
            {expanded ? <FolderOpen size={14} strokeWidth={1.5} className="text-yellow-500 shrink-0" /> : <Folder size={14} strokeWidth={1.5} className="text-yellow-600 shrink-0" />}
          </>
        ) : (
          <>
            <span className="w-3" />
            {getFileIcon(entry.extension, 14)}
          </>
        )}
        <span className="truncate flex-1">{entry.name}</span>
        {!isDir && <span className="text-[10px] text-[var(--color-text-tertiary)] shrink-0">{formatSize(entry.size)}</span>}
      </div>
      {isDir && expanded && children && (
        <div className="ml-3">
          {children.map(child => (
            <TreeNode key={child.name} entry={child} basePath={fullPath} projectName={projectName} selectedPath={selectedPath} onSelect={onSelect} />
          ))}
          {children.length === 0 && <div className="text-[10px] text-[var(--color-text-tertiary)] px-2 py-0.5 italic">empty</div>}
        </div>
      )}
    </div>
  );
}

function FilePreview({ projectName, path, entry }: { projectName: string; path: string; entry: FileEntry }) {
  const [content, setContent] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [editContent, setEditContent] = useState('');
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [binaryInfo, setBinaryInfo] = useState<{ size: number; mimeType: string } | null>(null);

  const ext = entry.extension.toLowerCase();
  const isImage = IMAGE_EXTS.has(ext);
  const isAudio = AUDIO_EXTS.has(ext);

  const readUrl = `/api/projects/${encodeURIComponent(projectName)}/files/read?path=${encodeURIComponent(path)}`;

  useEffect(() => {
    setContent(null);
    setEditing(false);
    setError(null);
    setBinaryInfo(null);
    setLoading(true);

    if (isImage || isAudio) {
      setLoading(false);
      return;
    }

    fetch(readUrl)
      .then(async res => {
        if (!res.ok) throw new Error(`${res.status}`);
        const ct = res.headers.get('content-type') || '';
        if (ct.includes('application/json')) {
          const data = await res.json();
          if (data.binary) {
            setBinaryInfo({ size: data.size, mimeType: data.mimeType });
          } else {
            setContent(data.content ?? '');
          }
        } else {
          // raw text response
          setContent(await res.text());
        }
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [path, readUrl, isImage, isAudio]);

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(projectName)}/files/write`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path, content: editContent }),
      });
      if (!res.ok) throw new Error(`${res.status}`);
      setContent(editContent);
      setEditing(false);
    } catch (e: any) {
      alert(`Save failed: ${e.message}`);
    }
    setSaving(false);
  };

  if (loading) return <div className="flex items-center justify-center h-full text-[var(--color-text-tertiary)]"><Loader2 size={20} className="animate-spin" /></div>;
  if (error) return <div className="p-4 text-red-400 text-sm">Error loading file: {error}</div>;

  if (isImage) {
    return (
      <div className="flex items-center justify-center h-full p-4">
        <img src={readUrl} alt={entry.name} className="max-w-full max-h-full object-contain rounded" />
      </div>
    );
  }

  if (isAudio) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-4 p-4">
        <Music size={48} className="text-green-400" />
        <p className="text-sm text-[var(--color-text-primary)]">{entry.name}</p>
        <audio controls src={readUrl} className="w-full max-w-md" />
      </div>
    );
  }

  if (binaryInfo) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-2 p-4 text-[var(--color-text-secondary)]">
        <File size={48} strokeWidth={1} />
        <p className="text-sm font-medium">{entry.name}</p>
        <p className="text-xs">{binaryInfo.mimeType} · {formatSize(binaryInfo.size)}</p>
      </div>
    );
  }

  // Text file
  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-[var(--color-border)] shrink-0">
        <span className="text-xs text-[var(--color-text-secondary)] flex-1 truncate">{path}</span>
        {editing ? (
          <>
            <button onClick={handleSave} disabled={saving} className="flex items-center gap-1 px-2 py-0.5 text-xs rounded bg-[var(--color-primary)] text-white hover:opacity-90 disabled:opacity-50">
              {saving ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />} Save
            </button>
            <button onClick={() => { setEditing(false); setEditContent(''); }} className="flex items-center gap-1 px-2 py-0.5 text-xs rounded text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]">
              <X size={12} /> Cancel
            </button>
          </>
        ) : (
          <button onClick={() => { setEditing(true); setEditContent(content ?? ''); }} className="flex items-center gap-1 px-2 py-0.5 text-xs rounded text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]">
            <Edit3 size={12} /> Edit
          </button>
        )}
      </div>
      <div className="flex-1 overflow-auto">
        {editing ? (
          <textarea
            value={editContent}
            onChange={e => setEditContent(e.target.value)}
            className="w-full h-full p-3 text-xs font-mono bg-[var(--color-surface)] text-[var(--color-text-primary)] resize-none focus:outline-none"
            spellCheck={false}
          />
        ) : (
          <pre className="p-3 text-xs font-mono text-[var(--color-text-primary)] whitespace-pre-wrap break-words">{content}</pre>
        )}
      </div>
    </div>
  );
}

export default function Files() {
  const { projectName } = useProject();
  const [rootEntries, setRootEntries] = useState<FileEntry[]>([]);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [selectedEntry, setSelectedEntry] = useState<FileEntry | null>(null);
  const [loading, setLoading] = useState(true);
  const [treeCollapsed, setTreeCollapsed] = useState(false);

  useEffect(() => {
    if (!projectName) return;
    setLoading(true);
    fetch(`/api/projects/${encodeURIComponent(projectName)}/files?path=`)
      .then(r => r.json())
      .then((data: DirListing) => setRootEntries(data.entries))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [projectName]);

  const handleSelect = (path: string, entry: FileEntry) => {
    setSelectedPath(path);
    setSelectedEntry(entry);
  };

  if (!projectName) return <div className="p-8 text-[var(--color-text-secondary)]">No project selected</div>;

  return (
    <div className="flex h-full">
      {/* Left panel: tree */}
      <div className={`${treeCollapsed ? 'w-0 overflow-hidden' : 'w-[280px]'} shrink-0 border-r border-[var(--color-border)] overflow-y-auto py-2 transition-all duration-200`}>
        <div className="flex items-center justify-between px-3 pb-2">
          <span className="text-[10px] uppercase tracking-wider text-[var(--color-text-tertiary)] font-medium">Files</span>
          <button onClick={() => setTreeCollapsed(true)} className="p-0.5 rounded hover:bg-[var(--color-surface-hover)] text-[var(--color-text-tertiary)]" aria-label="Collapse file tree">
            <PanelLeftClose size={14} />
          </button>
        </div>
        {loading ? (
          <div className="flex justify-center py-4"><Loader2 size={16} className="animate-spin text-[var(--color-text-tertiary)]" /></div>
        ) : rootEntries.length === 0 ? (
          <div className="px-3 text-xs text-[var(--color-text-tertiary)]">No files found. Check project cwd in settings.</div>
        ) : (
          rootEntries.map(entry => (
            <TreeNode key={entry.name} entry={entry} basePath="" projectName={projectName} selectedPath={selectedPath} onSelect={handleSelect} />
          ))
        )}
      </div>

      {/* Right panel: preview */}
      <div className="flex-1 min-w-0">
        {treeCollapsed && (
          <button onClick={() => setTreeCollapsed(false)} className="absolute top-2 left-2 z-10 p-1 rounded hover:bg-[var(--color-surface-hover)] text-[var(--color-text-tertiary)]" aria-label="Expand file tree">
            <PanelLeft size={16} />
          </button>
        )}
        {selectedPath && selectedEntry ? (
          <FilePreview projectName={projectName} path={selectedPath} entry={selectedEntry} />
        ) : (
          <div className="flex items-center justify-center h-full text-[var(--color-text-tertiary)] text-sm">
            Select a file to preview
          </div>
        )}
      </div>
    </div>
  );
}
