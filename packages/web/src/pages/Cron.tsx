import { useState } from 'react';
import useSWR from 'swr';
import { useProject } from '../hooks/useProject.tsx';
import { api } from '../lib/api.ts';
import type { CronJob } from '../lib/types.ts';
import { Clock, Plus, Play, Trash2 } from 'lucide-react';
import { Modal, ModalHeader, ModalFooter } from '../components/Modal.tsx';

const PRESETS = [
  { label: 'Every 5 minutes', value: '*/5 * * * *' },
  { label: 'Every hour', value: '0 * * * *' },
  { label: 'Every day at 9am', value: '0 9 * * *' },
  { label: 'Every week (Mon 9am)', value: '0 9 * * 1' },
];

function cronToHuman(expr: string): string {
  const parts = expr.split(' ');
  if (parts.length !== 5) return expr;
  const [min, hour, dom, , dow] = parts;
  if (expr === '*/5 * * * *') return 'Every 5 minutes';
  if (expr === '0 * * * *') return 'Every hour';
  if (min !== '*' && hour !== '*' && dom === '*' && dow === '*') return `Daily at ${hour}:${min.padStart(2, '0')}`;
  if (min !== '*' && hour !== '*' && dow !== '*') return `Weekly on day ${dow} at ${hour}:${min.padStart(2, '0')}`;
  return expr;
}

function timeAgo(iso: string | null): string {
  if (!iso) return '—';
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return `${Math.floor(diff / 86400000)}d ago`;
}

function timeUntil(iso: string | null): string {
  if (!iso) return '—';
  const diff = new Date(iso).getTime() - Date.now();
  if (diff < 0) return 'overdue';
  if (diff < 60000) return 'soon';
  if (diff < 3600000) return `in ${Math.floor(diff / 60000)}m`;
  if (diff < 86400000) return `in ${Math.floor(diff / 3600000)}h`;
  return `in ${Math.floor(diff / 86400000)}d`;
}

export default function Cron() {
  const { projectName } = useProject();
  const [showCreate, setShowCreate] = useState(false);

  const { data: jobs = [], isLoading: loading, mutate: refresh } = useSWR(
    projectName ? ['cron', projectName] : null,
    () => api.listCron(projectName!)
  );

  const toggleEnabled = async (job: CronJob) => {
    if (!projectName) return;
    try {
      if (job.enabled) await api.disableCron(projectName, job.id);
      else await api.enableCron(projectName, job.id);
      await refresh();
    } catch (e) { alert(`Failed: ${e}`); }
  };

  const runNow = async (job: CronJob) => {
    if (!projectName) return;
    try {
      await api.runCron(projectName, job.id);
      await refresh();
    } catch (e) { alert(`Failed: ${e}`); }
  };

  const deleteJob = async (job: CronJob) => {
    if (!projectName) return;
    if (!window.confirm(`Delete cron job "${job.name}"?`)) return;
    try {
      await api.deleteCron(projectName, job.id);
      await refresh();
    } catch (e) { alert(`Failed: ${e}`); }
  };

  if (!projectName) return <div className="p-8 text-[var(--color-text-secondary)]">Select a project</div>;

  return (
    <div className="max-w-5xl space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Cron Jobs ({jobs.length})</h1>
        <button
          onClick={() => setShowCreate(true)}
          className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg bg-[var(--color-primary)] text-white font-medium hover:opacity-90 transition-colors"
        >
          <Plus size={16} strokeWidth={1.5} />
          New Job
        </button>
      </div>

      {loading ? (
        <div className="text-sm text-[var(--color-text-secondary)]">Loading...</div>
      ) : jobs.length === 0 ? (
        <div className="text-center py-12 text-[var(--color-text-tertiary)]">
          <Clock size={32} strokeWidth={1} className="mx-auto mb-3 opacity-50" />
          <p className="text-sm">No cron jobs yet</p>
          <p className="text-xs mt-1">Create one to schedule recurring tasks</p>
        </div>
      ) : (
        <div className="space-y-2">
          {jobs.map(job => (
            <div
              key={job.id}
              className="flex items-center gap-4 px-4 py-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-secondary)] hover:bg-[var(--color-surface-hover)] transition-colors"
            >
              {/* Toggle */}
              <button
                onClick={() => toggleEnabled(job)}
                className={`w-8 h-4 rounded-full relative transition-colors ${job.enabled ? 'bg-[var(--color-status-running)]' : 'bg-[var(--color-border)]'}`}
              >
                <span className={`absolute top-0.5 w-3 h-3 rounded-full bg-white transition-transform ${job.enabled ? 'left-4' : 'left-0.5'}`} />
              </button>

              {/* Info */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-[var(--color-text-primary)] truncate">{job.name}</span>
                  {job.skill && <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--color-surface-hover)] text-[var(--color-text-tertiary)]">{job.skill}</span>}
                  {job.state.lastRunStatus === 'error' && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-500/20 text-red-400">error</span>
                  )}
                </div>
                <div className="flex items-center gap-3 mt-0.5 text-xs text-[var(--color-text-tertiary)]">
                  <span title={job.schedule.expr}>{cronToHuman(job.schedule.expr)}</span>
                  <span>·</span>
                  <span>Last: {timeAgo(job.state.lastRunAt)}</span>
                  <span>·</span>
                  <span>Next: {timeUntil(job.state.nextRunAt)}</span>
                </div>
              </div>

              {/* Actions */}
              <div className="flex items-center gap-1">
                <button
                  onClick={() => runNow(job)}
                  className="p-1.5 rounded hover:bg-[var(--color-surface-hover)] text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)] transition-colors"
                  title="Run now"
                  aria-label={`Run ${job.name} now`}
                >
                  <Play size={14} strokeWidth={1.5} />
                </button>
                <button
                  onClick={() => deleteJob(job)}
                  className="p-1.5 rounded hover:bg-[var(--color-surface-hover)] text-[var(--color-text-tertiary)] hover:text-red-400 transition-colors"
                  title="Delete"
                  aria-label={`Delete ${job.name}`}
                >
                  <Trash2 size={14} strokeWidth={1.5} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {showCreate && <CreateCronModal project={projectName} onClose={() => setShowCreate(false)} onCreated={refresh} />}
    </div>
  );
}

function CreateCronModal({ project, onClose, onCreated }: { project: string; onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState('');
  const [schedule, setSchedule] = useState('0 * * * *');
  const [customSchedule, setCustomSchedule] = useState('');
  const [prompt, setPrompt] = useState('');
  const [skill, setSkill] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [loading, setLoading] = useState(false);
  const [useCustom, setUseCustom] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !prompt.trim()) return;
    setLoading(true);
    try {
      await api.createCron(project, {
        name: name.trim(),
        schedule: useCustom ? customSchedule.trim() : schedule,
        prompt: prompt.trim(),
        skill: skill.trim() || undefined,
        enabled,
      });
      onCreated();
      onClose();
    } catch (err) {
      alert(`Failed to create: ${err}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal onClose={onClose} aria-label="Create Cron Job">
      <ModalHeader onClose={onClose}>Create Cron Job</ModalHeader>
        <form onSubmit={handleSubmit} className="px-6 py-4 space-y-3">
          <div>
            <label className="block text-xs text-[var(--color-text-secondary)] mb-1">Name</label>
            <input
              autoFocus
              value={name}
              onChange={e => setName(e.target.value)}
              className="w-full px-3 py-1.5 text-sm rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--color-accent)]"
              placeholder="daily-standup"
            />
          </div>
          <div>
            <label className="block text-xs text-[var(--color-text-secondary)] mb-1">Schedule</label>
            <div className="space-y-2">
              <div className="flex flex-wrap gap-1.5">
                {PRESETS.map(p => (
                  <button
                    key={p.value}
                    type="button"
                    onClick={() => { setSchedule(p.value); setUseCustom(false); }}
                    className={`px-2 py-1 text-xs rounded-md border transition-colors ${
                      !useCustom && schedule === p.value
                        ? 'border-[var(--color-accent)] text-[var(--color-accent)] bg-[var(--color-accent)]/10'
                        : 'border-[var(--color-border)] text-[var(--color-text-tertiary)] hover:border-[var(--color-text-tertiary)]'
                    }`}
                  >
                    {p.label}
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => setUseCustom(true)}
                  className={`px-2 py-1 text-xs rounded-md border transition-colors ${
                    useCustom
                      ? 'border-[var(--color-accent)] text-[var(--color-accent)] bg-[var(--color-accent)]/10'
                      : 'border-[var(--color-border)] text-[var(--color-text-tertiary)] hover:border-[var(--color-text-tertiary)]'
                  }`}
                >
                  Custom
                </button>
              </div>
              {useCustom && (
                <input
                  value={customSchedule}
                  onChange={e => setCustomSchedule(e.target.value)}
                  className="w-full px-3 py-1.5 text-sm rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--color-accent)] font-mono"
                  placeholder="*/10 * * * *"
                />
              )}
            </div>
          </div>
          <div>
            <label className="block text-xs text-[var(--color-text-secondary)] mb-1">Prompt</label>
            <textarea
              value={prompt}
              onChange={e => setPrompt(e.target.value)}
              rows={3}
              className="w-full px-3 py-1.5 text-sm rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--color-accent)] resize-none"
              placeholder="Check project status and report any issues..."
            />
          </div>
          <div>
            <label className="block text-xs text-[var(--color-text-secondary)] mb-1">Skill (optional)</label>
            <input
              value={skill}
              onChange={e => setSkill(e.target.value)}
              className="w-full px-3 py-1.5 text-sm rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--color-accent)]"
              placeholder="skill-name"
            />
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setEnabled(!enabled)}
              className={`w-8 h-4 rounded-full relative transition-colors ${enabled ? 'bg-[var(--color-status-running)]' : 'bg-[var(--color-border)]'}`}
            >
              <span className={`absolute top-0.5 w-3 h-3 rounded-full bg-white transition-transform ${enabled ? 'left-4' : 'left-0.5'}`} />
            </button>
            <span className="text-xs text-[var(--color-text-secondary)]">Enabled</span>
          </div>
          <ModalFooter>
            <button type="button" onClick={onClose} className="px-3 py-1.5 text-xs rounded-md text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] transition-colors">
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading || !name.trim() || !prompt.trim()}
              className="px-3 py-1.5 text-xs rounded-md bg-[var(--color-accent)] text-white font-medium hover:opacity-90 disabled:opacity-50 transition-colors"
            >
              {loading ? 'Creating...' : 'Create'}
            </button>
          </ModalFooter>
        </form>
    </Modal>
  );
}
