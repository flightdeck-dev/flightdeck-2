import { useState, useEffect, useCallback } from 'react';
import useSWR from 'swr';
import { useProject } from '../hooks/useProject.tsx';
import { api } from '../lib/api.ts';
import { Plus, X } from 'lucide-react';

interface EnabledModel {
  runtime: string;
  model: string;
  enabled: boolean;
  isDefault?: boolean;
}

interface RoleInfo {
  id: string;
  name: string;
  description: string;
  icon: string;
  color: string;
  source: string;
  enabledModels: EnabledModel[];
  permissions: Record<string, boolean>;
  instructions: string;
}

function RoleCard({ role, onClick, isSelected, disabledRuntimes }: { role: RoleInfo; onClick: () => void; isSelected: boolean; disabledRuntimes: string[] }) {
  const enabledCount = role.enabledModels.filter(m => m.enabled).length;
  const defaultModel = role.enabledModels.find(m => m.isDefault && m.enabled);
  const defaultModelDisabled = defaultModel ? disabledRuntimes.includes(defaultModel.runtime) : false;
  return (
    <button
      onClick={onClick}
      className={`w-full text-left p-4 rounded-xl border transition-colors ${
        isSelected
          ? 'border-[var(--color-primary)] bg-[var(--color-primary)]/5'
          : 'border-[var(--color-border)] bg-[var(--color-surface)] hover:bg-[var(--color-surface-hover)]'
      }`}
    >
      <div className="flex items-center gap-3">
        <span className="text-xl">{role.icon}</span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-[var(--color-text-primary)]">{role.name}</span>
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-[var(--color-surface-secondary)] text-[var(--color-text-tertiary)] border border-[var(--color-border)]">
              {role.source}
            </span>
          </div>
          <p className="text-xs text-[var(--color-text-tertiary)] truncate mt-0.5">{role.description}</p>
        </div>
        <div className="text-right">
          {defaultModelDisabled && (
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-yellow-500/10 text-yellow-500 block mb-1">
              ⚠️ Default model unavailable
            </span>
          )}
          <span className="text-xs text-[var(--color-text-secondary)]">
            {enabledCount} model{enabledCount !== 1 ? 's' : ''}
          </span>
        </div>
      </div>
    </button>
  );
}

function RoleDetail({ role, project, onUpdate }: { role: RoleInfo; project: string; onUpdate: () => void }) {
  const { status } = useProject();
  const { data: availableModels = {} } = useSWR(
    ['availableModels', project],
    () => api.getAvailableModels(project)
  );
  const { data: allRuntimes = [] } = useSWR<Array<{ id: string; name: string; supportsAcp?: boolean; supportsModelDiscovery?: boolean }>>(
    ['runtimes', project],
    () => api.getRuntimes(project)
  );
  const [prompt, setPrompt] = useState(role.instructions);
  const [promptDirty, setPromptDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [activeRuntime, setActiveRuntime] = useState<string | null>(null);

  useEffect(() => {
    setPrompt(role.instructions);
    setPromptDirty(false);
  }, [role.id, role.instructions]);

  // Build models grouped by runtime — show ALL discovered models
  const modelsByRuntime: Record<string, { modelId: string; displayName?: string; configured: boolean }[]> = {};
  const seen = new Set<string>();

  for (const [runtime, models] of Object.entries(availableModels)) {
    if (Array.isArray(models)) {
      // Flat array of models (current format)
      for (const m of models) {
        if (typeof m === 'object' && m !== null && ('id' in m || 'modelId' in m)) {
          const mo = m as { id?: string; modelId?: string; displayName?: string };
          const modelId = mo.modelId ?? mo.id!;
          const key = `${runtime}:${modelId}`;
          if (!seen.has(key)) {
            seen.add(key);
            const isConfigured = role.enabledModels.some(em => em.runtime === runtime && em.model === modelId);
            (modelsByRuntime[runtime] ??= []).push({
              modelId,
              displayName: mo.displayName,
              configured: isConfigured,
            });
          }
        }
      }
    }
    }
  }

  for (const em of role.enabledModels) {
    const key = `${em.runtime}:${em.model}`;
    if (!seen.has(key)) {
      seen.add(key);
      (modelsByRuntime[em.runtime] ??= []).push({ modelId: em.model, configured: true });
    }
  }

  // Ensure all known runtimes appear as tabs even without discovered models
  for (const rt of allRuntimes) {
    if (!modelsByRuntime[rt.id]) {
      modelsByRuntime[rt.id] = [];
    }
  }

  // Get user config for runtime ordering and filtering
  const disabledRuntimes: string[] = (status?.config as any)?.disabledRuntimes ?? [];
  const runtimeOrder: string[] = (status?.config as any)?.runtimeOrder ?? [];

  const runtimes = Object.keys(modelsByRuntime)
    .filter(rt => !disabledRuntimes.includes(rt))
    .sort((a, b) => {
      const ia = runtimeOrder.indexOf(a);
      const ib = runtimeOrder.indexOf(b);
      // Both in order: sort by position
      if (ia !== -1 && ib !== -1) return ia - ib;
      // One in order: it comes first
      if (ia !== -1) return -1;
      if (ib !== -1) return 1;
      // Neither: alphabetical
      return a.localeCompare(b);
    });
  const currentRuntime = activeRuntime && runtimes.includes(activeRuntime) ? activeRuntime : runtimes[0] ?? null;
  const currentModels = currentRuntime ? modelsByRuntime[currentRuntime] ?? [] : [];

  const isEnabled = (runtime: string, modelId: string) =>
    role.enabledModels.some(m => m.runtime === runtime && m.model === modelId && m.enabled);

  const isDefault = (runtime: string, modelId: string) =>
    role.enabledModels.some(m => m.runtime === runtime && m.model === modelId && m.isDefault);

  const toggleModel = async (runtime: string, modelId: string) => {
    const current = [...role.enabledModels];
    const idx = current.findIndex(m => m.runtime === runtime && m.model === modelId);
    if (idx >= 0) {
      current[idx] = { ...current[idx], enabled: !current[idx].enabled };
    } else {
      current.push({ runtime, model: modelId, enabled: true });
    }
    try {
      await api.updateRoleModels(project, role.id, current);
      onUpdate();
    } catch (e) { console.error('Failed to update models:', e); }
  };

  const setDefault = async (runtime: string, modelId: string) => {
    const current = role.enabledModels.map(m => ({ ...m, isDefault: m.runtime === runtime && m.model === modelId }));
    const idx = current.findIndex(m => m.runtime === runtime && m.model === modelId);
    if (idx < 0) {
      current.push({ runtime, model: modelId, enabled: true, isDefault: true });
    } else {
      current[idx].enabled = true;
    }
    try {
      await api.updateRoleModels(project, role.id, current);
      onUpdate();
    } catch (e) { console.error('Failed to set default:', e); }
  };

  const savePrompt = async () => {
    setSaving(true);
    try {
      await api.updateRolePrompt(project, role.id, prompt);
      setPromptDirty(false);
      onUpdate();
    } catch (e) { console.error('Failed to save prompt:', e); }
    setSaving(false);
  };

  const enabledCount = role.enabledModels.filter(m => m.enabled).length;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <span className="text-2xl">{role.icon}</span>
        <div>
          <h2 className="text-lg font-semibold text-[var(--color-text-primary)]">{role.name}</h2>
          <p className="text-sm text-[var(--color-text-secondary)]">{role.description}</p>
        </div>
        <span className="text-xs px-2 py-0.5 rounded-full bg-[var(--color-surface-secondary)] text-[var(--color-text-tertiary)] border border-[var(--color-border)]">
          {role.source}
        </span>
      </div>

      {/* Model Pool */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium text-[var(--color-text-secondary)] uppercase tracking-wider">Model Pool</h3>
          <span className="text-xs text-[var(--color-text-tertiary)]">{enabledCount} enabled</span>
        </div>

        {runtimes.length === 0 ? (
          <div className="p-4 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]">
            <p className="text-xs text-[var(--color-text-tertiary)]">No models discovered yet. Models are auto-discovered on daemon startup.</p>
          </div>
        ) : (
          <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] overflow-hidden">
            {/* Runtime tabs */}
            <div className="flex flex-wrap border-b border-[var(--color-border)] bg-[var(--color-surface-secondary)]">
              {runtimes.map(rt => {
                const count = modelsByRuntime[rt]?.length ?? 0;
                const isActive = rt === currentRuntime;
                const rtInfo = allRuntimes.find(r => r.id === rt);
                const noDiscovery = rtInfo?.supportsModelDiscovery === false;
                const notAcp = rtInfo?.supportsAcp === false && !rtInfo?.supportsModelDiscovery;
                // Status: has models = normal, no models + no discovery support = "default only", no models + discoverable = "discovering..."
                const statusHint = count > 0 ? '' : noDiscovery || notAcp ? ' ·' : ' ⟳';
                return (
                  <button
                    key={rt}
                    onClick={() => setActiveRuntime(rt)}
                    className={`px-3 py-2 text-xs font-medium border-b-2 transition-colors ${
                      isActive
                        ? 'border-[var(--color-primary)] text-[var(--color-primary)] bg-[var(--color-surface)]'
                        : 'border-transparent text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)]'
                    }`}
                    title={count > 0 ? `${count} models` : noDiscovery || notAcp ? 'Uses default model' : 'Discovering models...'}
                  >
                    {rt}
                    {count > 0 ? (
                      <span className="ml-1 opacity-60">({count})</span>
                    ) : (
                      <span className="ml-1 opacity-40">{statusHint}</span>
                    )}
                  </button>
                );
              })}
            </div>

            {/* Model list */}
            <div className="p-4 space-y-1.5 max-h-72 overflow-y-auto">
              {currentModels.length === 0 && (() => {
                const rtInfo = allRuntimes.find(r => r.id === currentRuntime);
                const noDiscovery = rtInfo?.supportsModelDiscovery === false;
                const notAcp = rtInfo?.supportsAcp === false && !rtInfo?.supportsModelDiscovery;
                return (
                  <p className="text-xs text-[var(--color-text-tertiary)]">
                    {noDiscovery || notAcp
                      ? 'This runtime uses a default model. Model selection is not available.'
                      : 'No models discovered yet. Models are auto-discovered on daemon startup. If this runtime is not installed, no models will appear.'}
                  </p>
                );
              })()}
              {currentModels.map(({ modelId, displayName, configured }) => (
                <div key={modelId} className="flex items-center gap-3 py-1">
                  <input
                    type="checkbox"
                    checked={isEnabled(currentRuntime!, modelId)}
                    onChange={() => toggleModel(currentRuntime!, modelId)}
                    className="w-4 h-4 rounded border-[var(--color-border)] accent-[var(--color-primary)]"
                  />
                  <div className="flex-1 min-w-0">
                    <span className="text-sm font-mono text-[var(--color-text-primary)] truncate block">
                      {displayName ?? modelId}
                    </span>
                    {displayName && (
                      <span className="text-[10px] text-[var(--color-text-tertiary)] font-mono">{modelId}</span>
                    )}
                  </div>
                  {configured && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--color-surface-secondary)] text-[var(--color-text-tertiary)]">configured</span>
                  )}
                  <button
                    onClick={() => setDefault(currentRuntime!, modelId)}
                    className={`text-sm ${
                      isDefault(currentRuntime!, modelId) ? 'text-yellow-500' : 'text-[var(--color-text-tertiary)] hover:text-yellow-500'
                    } transition-colors`}
                    title={isDefault(currentRuntime!, modelId) ? 'Default model' : 'Set as default'}
                  >
                    {isDefault(currentRuntime!, modelId) ? '★' : '☆'}
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
      </section>

      {/* System Prompt */}
      <section className="space-y-3">
        <h3 className="text-sm font-medium text-[var(--color-text-secondary)] uppercase tracking-wider">System Prompt</h3>
        <textarea
          value={prompt}
          onChange={role.source !== 'built-in' ? e => { setPrompt(e.target.value); setPromptDirty(true); } : undefined}
          readOnly={role.source === 'built-in'}
          className={`w-full h-48 p-3 text-sm font-mono rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text-primary)] resize-y focus:outline-none ${
            role.source === 'built-in' ? 'opacity-60 cursor-default' : 'focus:border-[var(--color-primary)]'
          }`}
        />
        {role.source === 'built-in' && (
          <p className="text-xs text-[var(--color-text-tertiary)]">Built-in prompts are read-only. Create a custom role to use your own prompt.</p>
        )}
        {promptDirty && role.source !== 'built-in' && (
          <div className="flex justify-end">
            <button
              onClick={savePrompt}
              disabled={saving}
              className="px-3 py-1.5 text-xs rounded-md bg-[var(--color-primary)] text-white font-medium hover:opacity-90 disabled:opacity-50 transition-colors"
            >
              {saving ? 'Saving...' : 'Save Prompt'}
            </button>
          </div>
        )}
      </section>
    </div>
  );
}

export default function Roles() {
  const { projectName, status } = useProject();
  const disabledRuntimes: string[] = (status?.config as any)?.disabledRuntimes ?? [];
  const [roles, setRoles] = useState<RoleInfo[]>([]);
  const [selectedRole, setSelectedRole] = useState<string | null>(null);


  const { data: rolesData, mutate: mutateRoles } = useSWR(
    projectName ? ['roles', projectName] : null,
    () => api.getRoles(projectName!)
  );


  // Sync SWR data to local state
  useEffect(() => {
    if (rolesData) setRoles(rolesData);
  }, [rolesData]);

  const loadRoles = useCallback(() => { mutateRoles(); }, [mutateRoles]);


  const selected = roles.find(r => r.id === selectedRole) ?? null;

  if (!projectName) {
    return <div className="p-8 text-[var(--color-text-secondary)]">Select a project to manage roles.</div>;
  }

  const [showCreate, setShowCreate] = useState(false);

  return (
    <div className="max-w-5xl space-y-8">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Roles</h1>
        <button
          onClick={() => setShowCreate(true)}
          className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg bg-[var(--color-primary)] text-white font-medium hover:opacity-90 transition-colors"
        >
          <Plus size={16} strokeWidth={1.5} />
          Custom Role
        </button>
      </div>

      <div className="flex gap-6">
        {/* Role list */}
        <div className="w-80 flex-shrink-0 space-y-2">
          {roles.map(role => (
            <RoleCard
              key={role.id}
              role={role}
              isSelected={selectedRole === role.id}
              onClick={() => setSelectedRole(role.id)}
              disabledRuntimes={disabledRuntimes}
            />
          ))}
          {roles.length === 0 && (
            <p className="text-sm text-[var(--color-text-tertiary)]">No roles found.</p>
          )}
        </div>

        {/* Detail panel */}
        <div className="flex-1 min-w-0">
          {selected ? (
            <RoleDetail role={selected} project={projectName} onUpdate={loadRoles} />
          ) : (
            <div className="flex items-center justify-center h-48 text-sm text-[var(--color-text-tertiary)] border border-dashed border-[var(--color-border)] rounded-xl">
              Select a role to view details
            </div>
          )}
        </div>
      </div>

      {showCreate && <CreateRoleModal project={projectName} onClose={() => setShowCreate(false)} onCreated={() => { loadRoles(); setShowCreate(false); }} />}
    </div>
  );
}

function CreateRoleModal({ project, onClose, onCreated }: { project: string; onClose: () => void; onCreated: () => void }) {
  const [id, setId] = useState('');
  const [name, setName] = useState('');
  const [icon, setIcon] = useState('🤖');
  const [description, setDescription] = useState('');
  const [instructions, setInstructions] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!id.trim() || !name.trim()) return;
    setLoading(true);
    try {
      await api.createRole(project, {
        id: id.trim(),
        name: name.trim(),
        icon: icon.trim() || '🤖',
        description: description.trim(),
        instructions: instructions.trim(),
      });
      onCreated();
    } catch (err) {
      alert(`Failed to create: ${err}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div className="bg-[var(--color-surface-secondary)] border border-[var(--color-border)] rounded-lg shadow-xl w-[520px] p-5" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-semibold text-[var(--color-text-primary)]">Create Custom Role</h3>
          <button onClick={onClose} className="p-1 rounded hover:bg-[var(--color-surface-hover)] text-[var(--color-text-tertiary)]">
            <X size={14} strokeWidth={1.5} />
          </button>
        </div>
        <form onSubmit={handleSubmit} className="space-y-3">
          <div className="flex gap-3">
            <div className="flex-1">
              <label className="block text-xs text-[var(--color-text-secondary)] mb-1">ID</label>
              <input
                autoFocus
                value={id}
                onChange={e => setId(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
                className="w-full px-3 py-1.5 text-sm rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--color-accent)] font-mono"
                placeholder="my-custom-role"
              />
            </div>
            <div className="w-16">
              <label className="block text-xs text-[var(--color-text-secondary)] mb-1">Icon</label>
              <input
                value={icon}
                onChange={e => setIcon(e.target.value)}
                className="w-full px-3 py-1.5 text-sm rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--color-accent)] text-center"
              />
            </div>
          </div>
          <div>
            <label className="block text-xs text-[var(--color-text-secondary)] mb-1">Name</label>
            <input
              value={name}
              onChange={e => setName(e.target.value)}
              className="w-full px-3 py-1.5 text-sm rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--color-accent)]"
              placeholder="My Custom Role"
            />
          </div>
          <div>
            <label className="block text-xs text-[var(--color-text-secondary)] mb-1">Description</label>
            <input
              value={description}
              onChange={e => setDescription(e.target.value)}
              className="w-full px-3 py-1.5 text-sm rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--color-accent)]"
              placeholder="What this role does..."
            />
          </div>
          <div>
            <label className="block text-xs text-[var(--color-text-secondary)] mb-1">System Prompt</label>
            <textarea
              value={instructions}
              onChange={e => setInstructions(e.target.value)}
              rows={6}
              className="w-full px-3 py-1.5 text-sm font-mono rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--color-accent)] resize-none"
              placeholder="You are a..."
            />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={onClose} className="px-3 py-1.5 text-xs rounded-md text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] transition-colors">
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading || !id.trim() || !name.trim()}
              className="px-3 py-1.5 text-xs rounded-md bg-[var(--color-primary)] text-white font-medium hover:opacity-90 disabled:opacity-50 transition-colors"
            >
              {loading ? 'Creating...' : 'Create Role'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

