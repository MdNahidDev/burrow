import { Check, Lock, RotateCcw, Zap } from 'lucide-react';
import { useState } from 'react';
import type { OptimizeTask, OsTarget, StartupItem } from '../types/burrow';
import { PlanetOrb } from './PlanetOrb';

interface OptimizeViewProps {
  os: OsTarget;
  tasks: OptimizeTask[];
  startupItems: StartupItem[];
  selectedOptimizeIds: Set<string>;
  appliedOptimizeIds?: Set<string>;
  expanded: boolean;
  onSetExpanded: (expanded: boolean) => void;
  onToggleOptimize: (id: string) => void;
  onToggleStartup: (id: string) => void;
  onOpenDryRun: () => void;
}

export function OptimizeView({
  os,
  tasks,
  startupItems,
  selectedOptimizeIds,
  appliedOptimizeIds,
  expanded,
  onSetExpanded,
  onToggleOptimize,
  onToggleStartup,
  onOpenDryRun,
}: OptimizeViewProps) {
  const [tab, setTab] = useState<'optimize' | 'startup'>('optimize');

  const impactClass = (impact: StartupItem['impact']) => {
    if (impact === 'high') return 'text-[var(--status-danger)]';
    if (impact === 'medium') return 'text-[var(--status-warn)]';
    return 'text-[var(--status-safe)]';
  };

  // Hero Orb Stage matching Screenshot 5
  if (!expanded) {
    return (
      <div className="min-h-[calc(100vh-148px)] flex flex-col items-center justify-center text-center px-4">
        <div className="mb-8">
          <PlanetOrb kind="mercury" size={198} />
        </div>

        <p className="font-serif-verse text-[17px] leading-[1.65] text-[var(--text-primary)] max-w-md">
          Closest to the sun, swiftest in flight.
          <br />
          The lightest touch, and nothing stalls.
        </p>

        <div className="mt-8">
          <button
            onClick={() => onSetExpanded(true)}
            className="px-11 py-3 rounded-full bg-[var(--pill-active-bg)] text-[var(--pill-active-text)] text-sm font-semibold shadow-[var(--glass-shadow)] hover:opacity-90 transition-opacity"
          >
            Optimize
          </button>
        </div>

        <p className="mt-5 text-xs text-[var(--text-muted)] tabular-nums">
          {tasks.length} safe tune-ups and {startupItems.length} startup controls ready for {os === 'windows' ? 'Windows' : os === 'macos' ? 'macOS' : 'Live Host'}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-2">
          <div className="inline-flex items-center p-1 rounded-full glass-panel">
            <button
              onClick={() => setTab('optimize')}
              className={`px-3.5 py-1.5 text-xs font-medium rounded-full transition-colors whitespace-nowrap ${
                tab === 'optimize'
                  ? 'bg-[var(--pill-active-bg)] text-[var(--pill-active-text)]'
                  : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
              }`}
            >
              System tune-ups ({tasks.length})
            </button>
            <button
              onClick={() => setTab('startup')}
              className={`px-3.5 py-1.5 text-xs font-medium rounded-full transition-colors whitespace-nowrap ${
                tab === 'startup'
                  ? 'bg-[var(--pill-active-bg)] text-[var(--pill-active-text)]'
                  : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
              }`}
            >
              Startup items ({startupItems.length})
            </button>
          </div>

          <button
            onClick={() => onSetExpanded(false)}
            aria-label="Return to orb view"
            title="Return to orb view"
            className="p-2 rounded-full glass-panel glass-panel-hover text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
          >
            <RotateCcw className="w-3.5 h-3.5" />
          </button>
        </div>

        <button
          onClick={onOpenDryRun}
          disabled={selectedOptimizeIds.size === 0}
          className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold rounded-full bg-[var(--pill-active-bg)] text-[var(--pill-active-text)] hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed transition-opacity whitespace-nowrap"
        >
          <Zap className="w-3.5 h-3.5" />
          Review & apply ({selectedOptimizeIds.size})
        </button>
      </div>

      {tab === 'optimize' ? (
        <div className="rounded-2xl glass-panel overflow-hidden">
          <div className="divide-y divide-[var(--border-subtle)]">
            {tasks.map((task) => {
              const checked = selectedOptimizeIds.has(task.id);
              const applied = appliedOptimizeIds?.has(task.id) ?? false;
              return (
                <div
                  key={task.id}
                  onClick={() => onToggleOptimize(task.id)}
                  className="px-5 py-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4 cursor-pointer hover:bg-[var(--bg-surface-hover)] transition-colors"
                >
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
                      <span className="text-sm font-medium text-[var(--text-primary)]">
                        {task.title}
                      </span>
                      <span className="text-xs text-[var(--text-muted)]">
                        {task.category}
                      </span>
                      {applied && (
                        <span className="text-xs font-medium text-[var(--status-safe)]">
                          Applied
                        </span>
                      )}
                      {task.requiresAdmin && (
                        <span className="inline-flex items-center gap-1 text-xs text-[var(--status-warn)]">
                          <Lock className="w-3 h-3" />
                          {os === 'windows' ? 'Admin prompt' : 'Password needed'}
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-[var(--text-secondary)]">
                      {task.description}
                    </p>
                  </div>

                  <div className="flex items-center justify-between sm:justify-end gap-4 shrink-0">
                    <span className="text-xs font-medium text-[var(--status-safe)]">
                      {task.estimatedGain}
                    </span>
                    <span
                      className={`w-4 h-4 rounded flex items-center justify-center border transition-colors ${
                        checked
                          ? 'bg-[var(--pill-active-bg)] border-[var(--pill-active-bg)] text-[var(--pill-active-text)]'
                          : 'border-[var(--border-strong)]'
                      }`}
                    >
                      {checked && <Check className="w-3 h-3 stroke-[2.5]" />}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        <div className="rounded-2xl glass-panel overflow-hidden">
          <div className="divide-y divide-[var(--border-subtle)]">
            {startupItems.map((item) => (
              <div
                key={item.id}
                className="px-5 py-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-4 hover:bg-[var(--bg-surface-hover)] transition-colors"
              >
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
                    <span className="text-sm font-medium text-[var(--text-primary)]">
                      {item.name}
                    </span>
                    <span className="text-xs text-[var(--text-muted)]">
                      {item.mechanism}
                    </span>
                    <span className={`text-xs font-medium capitalize ${impactClass(item.impact)}`}>
                      {item.impact} impact
                    </span>
                  </div>
                  <div className="text-xs text-[var(--text-muted)] truncate">
                    {item.publisher} ({item.path})
                  </div>
                </div>

                <div className="flex items-center gap-3 shrink-0">
                  {item.locked ? (
                    <span className="inline-flex items-center gap-1.5 text-xs text-[var(--status-info)]">
                      <Lock className="w-3.5 h-3.5" />
                      Protected system item
                    </span>
                  ) : (
                    <>
                      <span
                        className={`text-xs ${
                          item.enabled ? 'text-[var(--status-safe)]' : 'text-[var(--text-muted)]'
                        }`}
                      >
                        {item.enabled ? 'Enabled' : 'Disabled'}
                      </span>
                      <button
                        onClick={() => onToggleStartup(item.id)}
                        role="switch"
                        aria-checked={item.enabled}
                        className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
                          item.enabled ? 'bg-[var(--status-safe)]' : 'bg-[var(--border-strong)]'
                        }`}
                      >
                        <span
                          className={`inline-block h-3.5 w-3.5 transform rounded-full bg-[var(--switch-thumb)] shadow-xs transition-transform ${
                            item.enabled ? 'translate-x-4.5' : 'translate-x-1'
                          }`}
                        />
                      </button>
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
