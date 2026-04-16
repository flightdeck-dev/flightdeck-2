import { useState, useEffect, useCallback } from 'react';
import { useFlightdeck } from '../hooks/useFlightdeck.tsx';
import { api } from '../lib/api.ts';

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

function RoleCard({ role, onClick, isSelected }: { role: RoleInfo; onClick: () => void; isSelected: boolean }) {
  const enabledCount = role.enabledModels.filter(m => m.enabled).length;
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
          <span className="text-xs text-[var(--color-text-secondary)]">
            {enabledCount} model{enabledCount !== 1 ? 's' : ''}
          </span>
        </div>
      </div>
    </button>
  );
}

function RoleDetail({ role, project, onUpdate }: { role: RoleInfo; project: string; onUpdate: () => void }) {
  const [availableModels, setAvailableModels] = useState<Record<string, unknown>>({});
  const [prompt, setPrompt] = useState(role.instructions);
  const [promptDirty, setPromptDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.getAvailableModels(project).then(setAvailableModels).catch(() => {});
  }, [project]);

  useEffect(() => {
    setPrompt(role.instructions);
    setPromptDirty(false);
  }, [role.id, role.instructions]);

  // Build flat list of all runtime:model combos (discovered + configured)
  const discoveredModels: { runtime: string; model: string }[] = [];
  for (const [runtime, groups] of Object.entries(availableModels)) {
    if (typeof groups === 'object' && groups !== null) {
      for (const models of Object.values(groups as Record<string, unknown>)) {
        if (Array.isArray(models)) {
          for (const m of models) {
            if (typeof m === 'object' && m !== null && 'id' in m) {
              discoveredModels.push({ runtime, model: (m as { id: string }).id });
            }
          }
        }
      }
    }
  }

  // Merge: discovered models + any configured models not yet discovered
  const seen = new Set(discoveredModels.map(m => `${m.runtime}:${m.model}`));
  const allModels = [...discoveredModels];
  for (const em of role.enabledModels) {
    const key = `${em.runtime}:${em.model}`;
    if (!seen.has(key)) {
      allModels.push({ runtime: em.runtime, model: em.model });
      seen.add(key);
    }
  }

  const isEnabled = (runtime: string, model: string) =>
    role.enabledModels.some(m => m.runtime === runtime && m.model === model && m.enabled);

  const isDefault = (runtime: string, model: string) =>
    role.enabledModels.some(m => m.runtime === runtime && m.model === model && m.isDefault);

  const toggleModel = async (runtime: string, model: string) => {
    const current = [...role.enabledModels];
    const idx = current.findIndex(m => m.runtime === runtime && m.model === model);
    if (idx >= 0) {
      current[idx] = { ...current[idx], enabled: !current[idx].enabled };
    } else {
      current.push({ runtime, model, enabled: true });
    }
    try {
      await api.updateRoleModels(project, role.id, current);
      onUpdate();
    } catch (e) { console.error('Failed to update models:', e); }
  };

  const setDefault = async (runtime: string, model: string) => {
    const current = role.enabledModels.map(m => ({ ...m, isDefault: m.runtime === runtime && m.model === model }));
    const idx = current.findIndex(m => m.runtime === runtime && m.model === model);
    if (idx < 0) {
      current.push({ runtime, model, enabled: true, isDefault: true });
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
        <h3 className="text-sm font-medium text-[var(--color-text-secondary)] uppercase tracking-wider">Model Pool</h3>
        <div className="p-4 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] space-y-2 max-h-80 overflow-y-auto">
          {allModels.length === 0 && (
            <p className="text-xs text-[var(--color-text-tertiary)]">No models configured. Start the daemon to discover available models.</p>
          )}
          {allModels.length > 0 && discoveredModels.length === 0 && (
            <p className="text-xs text-[var(--color-text-tertiary)] mb-2">Showing configured models. Start the daemon to discover more.</p>
          )}
          {allModels.map(({ runtime, model }) => (
            <div key={`${runtime}:${model}`} className="flex items-center gap-3 py-1">
              <input
                type="checkbox"
                checked={isEnabled(runtime, model)}
                onChange={() => toggleModel(runtime, model)}
                className="w-4 h-4 rounded border-[var(--color-border)] accent-[var(--color-primary)]"
              />
              <span className="flex-1 text-sm text-[var(--color-text-primary)] font-mono">
                {runtime}:{model}
              </span>
              <button
                onClick={() => setDefault(runtime, model)}
                className={`text-sm ${isDefault(runtime, model) ? 'text-yellow-500' : 'text-[var(--color-text-tertiary)] hover:text-yellow-500'} transition-colors`}
                title={isDefault(runtime, model) ? 'Default model' : 'Set as default'}
              >
                {isDefault(runtime, model) ? '★' : '☆'}
              </button>
            </div>
          ))}
        </div>
      </section>

      {/* System Prompt */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium text-[var(--color-text-secondary)] uppercase tracking-wider">System Prompt</h3>
          {role.source === 'built-in' && (
            <button
              onClick={async () => {
                try {
                  await api.updateRolePrompt(project, role.id, role.instructions);
                  onUpdate();
                } catch (e) { console.error(e); }
              }}
              className="text-xs px-2 py-1 rounded border border-[var(--color-border)] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] transition-colors"
            >
              Copy to Project
            </button>
          )}
        </div>
        <textarea
          value={prompt}
          onChange={e => { setPrompt(e.target.value); setPromptDirty(true); }}
          className="w-full h-48 p-3 text-sm font-mono rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text-primary)] resize-y focus:outline-none focus:border-[var(--color-primary)]"
        />
        {promptDirty && (
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
  const { projectName } = useFlightdeck();
  const [roles, setRoles] = useState<RoleInfo[]>([]);
  const [selectedRole, setSelectedRole] = useState<string | null>(null);
  const [preference, setPreference] = useState('');
  const [prefDirty, setPrefDirty] = useState(false);
  const [prefSaving, setPrefSaving] = useState(false);

  const loadRoles = useCallback(() => {
    if (!projectName) return;
    api.getRoles(projectName).then(setRoles).catch(() => {});
  }, [projectName]);

  const loadPreference = useCallback(() => {
    if (!projectName) return;
    api.getRolePreference(projectName).then(r => { setPreference(r.content); setPrefDirty(false); }).catch(() => {});
  }, [projectName]);

  useEffect(() => { loadRoles(); loadPreference(); }, [loadRoles, loadPreference]);

  const savePreference = async () => {
    if (!projectName) return;
    setPrefSaving(true);
    try {
      await api.updateRolePreference(projectName, preference);
      setPrefDirty(false);
    } catch (e) { console.error(e); }
    setPrefSaving(false);
  };

  const resetPreference = async () => {
    const defaultPref = `# Role & Model Selection Preference

## Role Assignment
- Use **worker** for implementation tasks
- Use **reviewer** for code review after worker submits
- Use **qa-tester** only for user-facing features
- Skip **tech-writer** unless explicitly requested

## Model Selection
- Complex architecture/refactoring → high-performance model
- Routine bug fixes, small changes → budget model
- Code review → mid-tier is fine
- If a task fails once, retry with a higher-tier model

## Runtime Preference
- Prefer the default runtime for general work
- Use alternative runtimes when the default is unavailable
`;
    setPreference(defaultPref);
    setPrefDirty(true);
  };

  const selected = roles.find(r => r.id === selectedRole) ?? null;

  if (!projectName) {
    return <div className="p-8 text-[var(--color-text-secondary)]">Select a project to manage roles.</div>;
  }

  return (
    <div className="max-w-5xl space-y-8">
      <h1 className="text-xl font-semibold">Roles</h1>

      <div className="flex gap-6">
        {/* Role list */}
        <div className="w-80 flex-shrink-0 space-y-2">
          {roles.map(role => (
            <RoleCard
              key={role.id}
              role={role}
              isSelected={selectedRole === role.id}
              onClick={() => setSelectedRole(role.id)}
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

      {/* Role Selection Preference */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium text-[var(--color-text-secondary)] uppercase tracking-wider">Role Selection Preference</h2>
          <button
            onClick={resetPreference}
            className="text-xs px-2 py-1 rounded border border-[var(--color-border)] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] transition-colors"
          >
            Reset to Default
          </button>
        </div>
        <textarea
          value={preference}
          onChange={e => { setPreference(e.target.value); setPrefDirty(true); }}
          className="w-full h-48 p-3 text-sm font-mono rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text-primary)] resize-y focus:outline-none focus:border-[var(--color-primary)]"
          placeholder="Define how Lead should select roles and models..."
        />
        {prefDirty && (
          <div className="flex justify-end">
            <button
              onClick={savePreference}
              disabled={prefSaving}
              className="px-3 py-1.5 text-xs rounded-md bg-[var(--color-primary)] text-white font-medium hover:opacity-90 disabled:opacity-50 transition-colors"
            >
              {prefSaving ? 'Saving...' : 'Save Preference'}
            </button>
          </div>
        )}
      </section>
    </div>
  );
}
