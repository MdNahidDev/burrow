import { Bookmark, Clock, Cpu, Download, Plus, Shield, Trash2 } from 'lucide-react';
import { useState } from 'react';
import type { CleanupRun, MaintenanceProfile, OsTarget, WhitelistEntry } from '../types/burrow';
import { formatBytes } from '../utils/format';
import { isTauriRuntime } from '../utils/tauriBridge';

interface ProfilesViewProps {
  os: OsTarget;
  profiles: MaintenanceProfile[];
  whitelist: WhitelistEntry[];
  history: CleanupRun[];
  onLoadProfile: (profile: MaintenanceProfile) => void;
  onSaveCurrentProfile: (name: string, description: string) => void;
  onDeleteProfile: (id: string) => void;
  onAddWhitelist: (pattern: string, reason: string, targetOs: OsTarget | 'all') => void;
  onDeleteWhitelist: (id: string) => void;
}

export function ProfilesView({
  os,
  profiles,
  whitelist,
  history,
  onLoadProfile,
  onSaveCurrentProfile,
  onDeleteProfile,
  onAddWhitelist,
  onDeleteWhitelist,
}: ProfilesViewProps) {
  const [profileName, setProfileName] = useState('');
  const [profileDesc, setProfileDesc] = useState('');
  const [wlPattern, setWlPattern] = useState('');
  const [wlReason, setWlReason] = useState('');

  const runningInTauri = isTauriRuntime();

  const handleSaveProfile = (e: React.FormEvent) => {
    e.preventDefault();
    if (!profileName.trim()) return;
    onSaveCurrentProfile(profileName.trim(), profileDesc.trim());
    setProfileName('');
    setProfileDesc('');
  };

  const handleAddWhitelist = (e: React.FormEvent) => {
    e.preventDefault();
    if (!wlPattern.trim()) return;
    onAddWhitelist(wlPattern.trim(), wlReason.trim() || 'User-protected path', os);
    setWlPattern('');
    setWlReason('');
  };

  return (
    <div className="space-y-5">
      {/* Native Offline Windows App Strip */}
      <div className="rounded-2xl glass-panel p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="space-y-1 min-w-0">
          <div className="flex items-center gap-2 text-sm font-semibold text-[var(--text-primary)]">
            <Cpu className="w-4 h-4 text-[var(--status-safe)] shrink-0" />
            <span>Offline Windows Desktop Engine</span>
          </div>
          <p className="text-xs text-[var(--text-secondary)]">
            {runningInTauri
              ? 'Connected directly to the native Rust engine on your Windows PC for instant scanning, cleaning, and telemetry.'
              : 'Download the Windows desktop bundle to run Burrow offline on your PC or compile the native .exe installer.'}
          </p>
        </div>

        {!runningInTauri && (
          <a
            href="/api/download/burrow-windows.zip"
            download="Burrow-Windows.zip"
            className="inline-flex items-center justify-center gap-2 px-4 py-2 text-xs font-semibold rounded-full bg-[var(--pill-active-bg)] text-[var(--pill-active-text)] hover:opacity-90 transition-opacity whitespace-nowrap shrink-0"
          >
            <Download className="w-3.5 h-3.5" />
            Download for Windows (.zip)
          </a>
        )}
      </div>

      {/* Presets & Protected Whitelist */}
      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-4">
        {/* Saved Presets */}
        <div className="rounded-2xl glass-panel overflow-hidden flex flex-col min-w-0">
          <div className="px-5 py-3.5 border-b border-[var(--border-subtle)] flex items-center justify-between">
            <div className="flex items-center gap-2 text-sm font-semibold text-[var(--text-primary)]">
              <Bookmark className="w-4 h-4 text-[var(--status-warn)]" />
              Saved presets
            </div>
            <span className="text-xs tabular-nums text-[var(--text-muted)]">
              {profiles.length} saved
            </span>
          </div>

          <form onSubmit={handleSaveProfile} className="p-4 border-b border-[var(--border-subtle)] bg-[var(--bg-inset)] space-y-2.5">
            <div className="text-xs font-medium text-[var(--text-secondary)]">
              Save current cleanup selections
            </div>
            <div className="flex flex-col sm:flex-row gap-2">
              <input
                type="text"
                value={profileName}
                onChange={(e) => setProfileName(e.target.value)}
                placeholder="Preset name (e.g. Monthly PC Cleanup)"
                className="flex-1 px-3 py-1.5 text-xs rounded-lg border border-[var(--glass-border)] bg-[var(--bg-surface)] text-[var(--text-primary)] placeholder:text-[var(--text-muted)]"
              />
              <button
                type="submit"
                disabled={!profileName.trim()}
                className="inline-flex items-center justify-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold rounded-full bg-[var(--pill-active-bg)] text-[var(--pill-active-text)] hover:opacity-90 disabled:opacity-40 transition-opacity whitespace-nowrap shrink-0"
              >
                <Plus className="w-3.5 h-3.5" />
                Save
              </button>
            </div>
            <input
              type="text"
              value={profileDesc}
              onChange={(e) => setProfileDesc(e.target.value)}
              placeholder="Short note about what this cleans..."
              className="w-full px-3 py-1.5 text-xs rounded-lg border border-[var(--glass-border)] bg-[var(--bg-surface)] text-[var(--text-primary)] placeholder:text-[var(--text-muted)]"
            />
          </form>

          <div className="divide-y divide-[var(--border-subtle)]">
            {profiles.map((prof) => (
              <div key={prof.id} className="px-5 py-3.5 flex items-start justify-between gap-4">
                <div className="min-w-0 space-y-1">
                  <div className="text-sm font-medium text-[var(--text-primary)]">
                    {prof.name}
                  </div>
                  <p className="text-xs text-[var(--text-secondary)]">
                    {prof.description}
                  </p>
                  <div className="flex flex-wrap gap-x-3 text-[11px] text-[var(--text-muted)] tabular-nums">
                    <span>{prof.cleanTargetIds.length} cleanup items</span>
                    <span>{prof.optimizeTaskIds.length} tune-ups</span>
                    <span>{prof.minStaleDays}d idle threshold</span>
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    onClick={() => onLoadProfile(prof)}
                    className="px-3 py-1 text-xs font-medium rounded-full glass-panel glass-panel-hover text-[var(--text-primary)] whitespace-nowrap"
                  >
                    Apply
                  </button>
                  <button
                    onClick={() => onDeleteProfile(prof.id)}
                    aria-label={`Delete ${prof.name}`}
                    className="p-1.5 text-[var(--text-muted)] hover:text-[var(--status-danger)] transition-colors"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Protected Folders Whitelist */}
        <div className="rounded-2xl glass-panel overflow-hidden flex flex-col min-w-0">
          <div className="px-5 py-3.5 border-b border-[var(--border-subtle)] flex items-center justify-between">
            <div className="flex items-center gap-2 text-sm font-semibold text-[var(--text-primary)]">
              <Shield className="w-4 h-4 text-[var(--status-info)]" />
              Protected folders
            </div>
            <span className="text-xs tabular-nums text-[var(--text-muted)]">
              {whitelist.length} rule{whitelist.length === 1 ? '' : 's'}
            </span>
          </div>

          <form onSubmit={handleAddWhitelist} className="p-4 border-b border-[var(--border-subtle)] bg-[var(--bg-inset)] space-y-2.5">
            <div className="text-xs font-medium text-[var(--text-secondary)]">
              Keep matching folders untouched during cleanup
            </div>
            <div className="flex flex-col sm:flex-row gap-2">
              <input
                type="text"
                value={wlPattern}
                onChange={(e) => setWlPattern(e.target.value)}
                placeholder="Folder or pattern (e.g. *Steam*shadercache*)"
                className="flex-1 px-3 py-1.5 text-xs font-mono rounded-lg border border-[var(--glass-border)] bg-[var(--bg-surface)] text-[var(--text-primary)] placeholder:text-[var(--text-muted)]"
              />
              <button
                type="submit"
                disabled={!wlPattern.trim()}
                className="inline-flex items-center justify-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold rounded-full bg-[var(--pill-active-bg)] text-[var(--pill-active-text)] hover:opacity-90 disabled:opacity-40 transition-opacity whitespace-nowrap shrink-0"
              >
                <Plus className="w-3.5 h-3.5" />
                Protect
              </button>
            </div>
            <input
              type="text"
              value={wlReason}
              onChange={(e) => setWlReason(e.target.value)}
              placeholder="Reason to keep this safe..."
              className="w-full px-3 py-1.5 text-xs rounded-lg border border-[var(--glass-border)] bg-[var(--bg-surface)] text-[var(--text-primary)] placeholder:text-[var(--text-muted)]"
            />
          </form>

          <div className="divide-y divide-[var(--border-subtle)]">
            {whitelist.map((entry) => (
              <div key={entry.id} className="px-5 py-3 flex items-start justify-between gap-4">
                <div className="min-w-0 space-y-0.5">
                  <div className="text-xs font-mono font-medium text-[var(--text-primary)] break-all">
                    {entry.pattern}
                  </div>
                  <p className="text-xs text-[var(--text-secondary)]">
                    {entry.reason}
                  </p>
                </div>
                <button
                  onClick={() => onDeleteWhitelist(entry.id)}
                  aria-label={`Remove protection for ${entry.pattern}`}
                  className="p-1.5 text-[var(--text-muted)] hover:text-[var(--status-danger)] transition-colors shrink-0"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Activity Log */}
      <div className="rounded-2xl glass-panel overflow-hidden">
        <div className="px-5 py-3.5 border-b border-[var(--border-subtle)] flex items-center gap-2 text-sm font-semibold text-[var(--text-primary)]">
          <Clock className="w-4 h-4 text-[var(--text-muted)]" />
          Recent cleanup history
        </div>
        <div className="divide-y divide-[var(--border-subtle)]">
          {history.map((run) => (
            <div key={run.id} className="px-5 py-3 flex flex-wrap items-center justify-between gap-4 text-xs">
              <div className="min-w-0 space-y-0.5">
                <div className="flex flex-wrap items-center gap-3">
                  <span className="font-medium text-[var(--text-primary)]">
                    {run.summary}
                  </span>
                  <span className="text-[var(--status-safe)]">
                    {run.mode === 'dry-run' ? 'Safety check' : 'Completed'}
                  </span>
                </div>
                <div className="text-[var(--text-muted)]">
                  {new Date(run.timestamp).toLocaleString()}
                </div>
              </div>

              <div className="text-right tabular-nums shrink-0">
                <div className="font-semibold text-[var(--text-primary)]">
                  {formatBytes(run.reclaimedBytes)}
                </div>
                <div className="text-[var(--text-muted)]">
                  {run.itemCount} item{run.itemCount === 1 ? '' : 's'}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
