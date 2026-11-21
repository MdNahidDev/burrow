import {
  CheckCircle2,
  FolderX,
  HardDrive,
  Lock,
  Play,
  ShieldCheck,
  Sparkles,
  Trash2,
  X,
  Zap,
} from 'lucide-react';
import type {
  CleanTarget,
  InstalledApp,
  OptimizeTask,
  PurgeProject,
  StartupItem,
} from '../types/burrow';
import { useEffect } from 'react';
import { formatBytes } from '../utils/format';

export interface ActionExecutionItem {
  id: string;
  label: string;
  detail: string;
  bytes: number;
  status: string;
  ok: boolean;
}

interface DryRunDrawerProps {
  open: boolean;
  dryRun: boolean;
  executing: boolean;
  cleanTargets: CleanTarget[];
  purgeProjects: PurgeProject[];
  uninstallApps: InstalledApp[];
  upgradeApps: InstalledApp[];
  optimizeTasks: OptimizeTask[];
  startupChanges: StartupItem[];
  results: ActionExecutionItem[] | null;
  onRunAction: (asDryRun: boolean) => void;
  onClose: () => void;
}

export function DryRunDrawer({
  open,
  executing,
  cleanTargets,
  purgeProjects,
  uninstallApps,
  upgradeApps,
  optimizeTasks,
  startupChanges,
  results,
  onRunAction,
  onClose,
}: DryRunDrawerProps) {
  useEffect(() => {
    if (!open) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [open, onClose]);

  if (!open) return null;

  const totalActions =
    cleanTargets.length +
    purgeProjects.length +
    uninstallApps.length +
    upgradeApps.length +
    optimizeTasks.length +
    startupChanges.length;

  const totalBytes =
    cleanTargets.reduce((s, c) => s + c.sizeBytes, 0) +
    purgeProjects.reduce((s, p) => s + p.sizeBytes, 0) +
    uninstallApps.reduce(
      (s, a) => s + a.leftovers.reduce((ls, l) => ls + l.sizeBytes, 0),
      0,
    );

  const requiresAdmin =
    cleanTargets.some((c) => c.requiresAdmin) ||
    optimizeTasks.some((o) => o.requiresAdmin) ||
    startupChanges.some((s) => s.requiresAdmin) ||
    uninstallApps.some((a) => a.leftovers.some((l) => l.requiresAdmin));

  const resultReclaimed = results
    ? results.reduce((sum, item) => sum + item.bytes, 0)
    : 0;

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-50 flex justify-end bg-[var(--bg-scrim)]"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-2xl h-full glass-drawer border-l border-[var(--glass-border)] flex flex-col"
      >
        {/* Header */}
        <div className="px-6 py-4 border-b border-[var(--border-subtle)] flex items-center justify-between gap-4">
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-[var(--text-primary)]">
              {results ? 'Action Summary' : 'Confirm Windows Actions'}
            </h2>
            <p className="text-xs text-[var(--text-secondary)] mt-0.5 tabular-nums">
              {results
                ? `Completed ${results.length} action${results.length === 1 ? '' : 's'} (${formatBytes(resultReclaimed)})`
                : `${totalActions} selected action${totalActions === 1 ? '' : 's'}${totalBytes > 0 ? ` (${formatBytes(totalBytes)} reclaimable)` : ''}`}
            </p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="p-2 rounded-full text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-surface-hover)] transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Safety Notice */}
        <div className="px-6 py-2.5 border-b border-[var(--border-subtle)] flex items-center gap-2 text-xs text-[var(--text-secondary)]">
          {requiresAdmin ? (
            <>
              <Lock className="w-3.5 h-3.5 text-[var(--status-warn)] shrink-0" />
              <span>Some items may request Windows Administrator approval when applied.</span>
            </>
          ) : (
            <>
              <ShieldCheck className="w-3.5 h-3.5 text-[var(--status-safe)] shrink-0" />
              <span>Safe user-level actions. Protected folders remain untouched.</span>
            </>
          )}
        </div>

        {/* Action Queue / Completion Report */}
        <div className="flex-1 overflow-y-auto p-6 space-y-5">
          {results ? (
            <div className="space-y-3">
              <div className="rounded-2xl glass-panel p-4 flex items-center justify-between gap-4 border border-[var(--status-safe)] bg-[var(--status-safe-tint)]">
                <div className="flex items-center gap-3 min-w-0">
                  <CheckCircle2 className="w-5 h-5 text-[var(--status-safe)] shrink-0" />
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-[var(--text-primary)]">
                      Finished on Windows
                    </div>
                    <div className="text-xs text-[var(--text-secondary)]">
                      {results.filter((r) => r.ok).length} of {results.length} actions completed cleanly
                    </div>
                  </div>
                </div>
                {resultReclaimed > 0 && (
                  <div className="text-right tabular-nums shrink-0">
                    <div className="text-sm font-semibold text-[var(--status-safe)]">
                      {formatBytes(resultReclaimed)}
                    </div>
                    <div className="text-[11px] text-[var(--text-muted)]">space handled</div>
                  </div>
                )}
              </div>

              <div className="rounded-2xl glass-panel divide-y divide-[var(--border-subtle)] overflow-hidden">
                {results.map((item) => (
                  <div key={item.id} className="px-4 py-3 flex items-center justify-between gap-3 text-xs">
                    <div className="min-w-0">
                      <div className="font-medium text-[var(--text-primary)] truncate">
                        {item.label}
                      </div>
                      <div className="text-[var(--text-muted)] truncate">{item.detail}</div>
                    </div>
                    <div className="text-right shrink-0 tabular-nums">
                      <div className={item.ok ? 'text-[var(--status-safe)] font-medium' : 'text-[var(--status-warn)] font-medium'}>
                        {item.status}
                      </div>
                      {item.bytes > 0 && (
                        <div className="text-[var(--text-muted)]">{formatBytes(item.bytes)}</div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : totalActions === 0 ? (
            <div className="py-16 text-center text-xs text-[var(--text-muted)]">
              No actions selected yet. Choose items in Clean, Apps, or Optimize to run them here.
            </div>
          ) : (
            <>
              {cleanTargets.length > 0 && (
                <section className="space-y-2">
                  <div className="flex items-center gap-2 text-xs font-semibold text-[var(--text-secondary)]">
                    <HardDrive className="w-3.5 h-3.5 text-[var(--status-safe)]" />
                    Temp, caches & installers ({cleanTargets.length})
                  </div>
                  <div className="rounded-2xl glass-panel divide-y divide-[var(--border-subtle)] overflow-hidden">
                    {cleanTargets.map((t) => (
                      <div key={t.id} className="px-4 py-2.5 flex items-center justify-between gap-3 text-xs">
                        <div className="min-w-0">
                          <div className="font-medium text-[var(--text-primary)] truncate">{t.title}</div>
                          <div className="font-mono text-[11px] text-[var(--text-muted)] truncate">{t.path}</div>
                        </div>
                        <span className="font-semibold tabular-nums text-[var(--text-primary)] shrink-0">
                          {formatBytes(t.sizeBytes)}
                        </span>
                      </div>
                    ))}
                  </div>
                </section>
              )}

              {purgeProjects.length > 0 && (
                <section className="space-y-2">
                  <div className="flex items-center gap-2 text-xs font-semibold text-[var(--text-secondary)]">
                    <FolderX className="w-3.5 h-3.5 text-[var(--status-warn)]" />
                    Build clutter ({purgeProjects.length})
                  </div>
                  <div className="rounded-2xl glass-panel divide-y divide-[var(--border-subtle)] overflow-hidden">
                    {purgeProjects.map((p) => (
                      <div key={p.id} className="px-4 py-2.5 flex items-center justify-between gap-3 text-xs">
                        <div className="min-w-0">
                          <div className="font-medium text-[var(--text-primary)] truncate">
                            {p.projectName} ({p.artifactType})
                          </div>
                          <div className="font-mono text-[11px] text-[var(--text-muted)] truncate">{p.path}</div>
                        </div>
                        <span className="font-semibold tabular-nums text-[var(--text-primary)] shrink-0">
                          {formatBytes(p.sizeBytes)}
                        </span>
                      </div>
                    ))}
                  </div>
                </section>
              )}

              {uninstallApps.length > 0 && (
                <section className="space-y-2">
                  <div className="flex items-center gap-2 text-xs font-semibold text-[var(--text-secondary)]">
                    <Trash2 className="w-3.5 h-3.5 text-[var(--status-danger)]" />
                    Apps to uninstall ({uninstallApps.length})
                  </div>
                  <div className="rounded-2xl glass-panel divide-y divide-[var(--border-subtle)] overflow-hidden">
                    {uninstallApps.map((app) => {
                      const bytes = app.leftovers.reduce((s, l) => s + l.sizeBytes, 0);
                      return (
                        <div key={app.id} className="px-4 py-2.5 flex items-center justify-between gap-3 text-xs">
                          <div className="min-w-0">
                            <div className="font-medium text-[var(--text-primary)] truncate">{app.name}</div>
                            <div className="text-[var(--text-muted)]">
                              Removes app and {app.leftovers.length} leftover location{app.leftovers.length === 1 ? '' : 's'}
                            </div>
                          </div>
                          <span className="font-semibold tabular-nums text-[var(--text-primary)] shrink-0">
                            {formatBytes(bytes)}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </section>
              )}

              {upgradeApps.length > 0 && (
                <section className="space-y-2">
                  <div className="flex items-center gap-2 text-xs font-semibold text-[var(--text-secondary)]">
                    <Sparkles className="w-3.5 h-3.5 text-[var(--status-safe)]" />
                    App updates ({upgradeApps.length})
                  </div>
                  <div className="rounded-2xl glass-panel divide-y divide-[var(--border-subtle)] overflow-hidden">
                    {upgradeApps.map((app) => (
                      <div key={app.id} className="px-4 py-2.5 flex items-center justify-between gap-3 text-xs">
                        <div className="min-w-0">
                          <div className="font-medium text-[var(--text-primary)] truncate">{app.name}</div>
                          <div className="text-[var(--text-muted)]">
                            {app.version} to {app.latestVersion}
                          </div>
                        </div>
                        <span className="text-xs font-medium text-[var(--status-safe)] shrink-0">
                          Ready
                        </span>
                      </div>
                    ))}
                  </div>
                </section>
              )}

              {(optimizeTasks.length > 0 || startupChanges.length > 0) && (
                <section className="space-y-2">
                  <div className="flex items-center gap-2 text-xs font-semibold text-[var(--text-secondary)]">
                    <Zap className="w-3.5 h-3.5 text-[var(--status-info)]" />
                    System tune-ups & startup ({optimizeTasks.length + startupChanges.length})
                  </div>
                  <div className="rounded-2xl glass-panel divide-y divide-[var(--border-subtle)] overflow-hidden">
                    {optimizeTasks.map((opt) => (
                      <div key={opt.id} className="px-4 py-2.5 flex items-center justify-between gap-3 text-xs">
                        <div className="min-w-0">
                          <div className="font-medium text-[var(--text-primary)] truncate">{opt.title}</div>
                          <div className="text-[var(--text-muted)] truncate">{opt.description}</div>
                        </div>
                        <span className="text-xs font-medium text-[var(--status-safe)] shrink-0">
                          {opt.estimatedGain}
                        </span>
                      </div>
                    ))}
                    {startupChanges.map((st) => (
                      <div key={st.id} className="px-4 py-2.5 flex items-center justify-between gap-3 text-xs">
                        <div className="min-w-0">
                          <div className="font-medium text-[var(--text-primary)] truncate">{st.name}</div>
                          <div className="text-[var(--text-muted)]">{st.publisher}</div>
                        </div>
                        <span className="text-xs text-[var(--text-secondary)] shrink-0">
                          {st.enabled ? 'Enable at sign-in' : 'Pause startup'}
                        </span>
                      </div>
                    ))}
                  </div>
                </section>
              )}
            </>
          )}
        </div>

        {/* Footer Action Buttons */}
        <div className="px-6 py-4 border-t border-[var(--border-subtle)] flex flex-wrap items-center justify-between gap-3">
          <button
            onClick={onClose}
            className="px-4 py-2 text-xs font-medium rounded-full glass-panel glass-panel-hover text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
          >
            {results ? 'Done' : 'Cancel'}
          </button>

          {!results && totalActions > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              <button
                onClick={() => onRunAction(true)}
                disabled={executing}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium rounded-full glass-panel glass-panel-hover text-[var(--text-primary)] disabled:opacity-50 whitespace-nowrap"
              >
                <ShieldCheck className="w-3.5 h-3.5 text-[var(--status-safe)]" />
                {executing ? 'Checking...' : 'Test safely'}
              </button>
              <button
                onClick={() => onRunAction(false)}
                disabled={executing}
                className="inline-flex items-center gap-1.5 px-5 py-2 text-xs font-semibold rounded-full bg-[var(--pill-active-bg)] text-[var(--pill-active-text)] hover:opacity-90 disabled:opacity-50 transition-opacity whitespace-nowrap"
              >
                <Play className="w-3.5 h-3.5" />
                {executing ? 'Running...' : 'Clean & apply now'}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
