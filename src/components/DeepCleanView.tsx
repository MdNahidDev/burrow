import {
  AlertTriangle,
  Check,
  FileArchive,
  FolderX,
  Lock,
  RotateCcw,
  Search,
  Shield,
  Sparkles,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { CleanTarget, OsTarget, PurgeProject, SafetyTier, WhitelistEntry } from '../types/burrow';
import { formatBytes, formatNumber, formatRelativeDays, matchesWhitelist } from '../utils/format';
import { PlanetOrb } from './PlanetOrb';

interface DeepCleanViewProps {
  os: OsTarget;
  targets: CleanTarget[];
  purgeProjects: PurgeProject[];
  selectedIds: Set<string>;
  selectedPurgeIds: Set<string>;
  staleThresholdDays: number;
  whitelist: WhitelistEntry[];
  onToggleId: (id: string) => void;
  onSelectMany: (ids: string[]) => void;
  onTogglePurgeId: (id: string) => void;
  onSelectStalePurge: (ids: string[]) => void;
  onChangeThreshold: (days: number) => void;
  scanned: boolean;
  onSetScanned: (scanned: boolean) => void;
  onAddWhitelist: (pattern: string, reason: string) => void;
  onOpenDryRun: () => void;
}

export function DeepCleanView({
  os,
  targets,
  purgeProjects,
  selectedIds,
  selectedPurgeIds,
  staleThresholdDays,
  whitelist,
  onToggleId,
  onSelectMany,
  onTogglePurgeId,
  onSelectStalePurge,
  onChangeThreshold,
  scanned,
  onSetScanned,
  onAddWhitelist,
  onOpenDryRun,
}: DeepCleanViewProps) {
  const [scanning, setScanning] = useState(false);
  const [subTab, setSubTab] = useState<'cache' | 'installer' | 'clutter'>('cache');
  const [query, setQuery] = useState('');
  const [safetyFilter, setSafetyFilter] = useState<'all' | SafetyTier>('all');
  const scanTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (scanTimerRef.current !== null) {
        window.clearTimeout(scanTimerRef.current);
      }
    };
  }, []);

  const activeWhitelistPatterns = useMemo(
    () => whitelist.filter((w) => w.os === os || w.os === 'all').map((w) => w.pattern),
    [whitelist, os],
  );

  const tabTargets = useMemo(
    () => targets.filter((t) => t.kind === (subTab === 'installer' ? 'installer' : 'cache')),
    [targets, subTab],
  );

  const filteredTargets = useMemo(() => {
    const q = query.trim().toLowerCase();
    return tabTargets.filter((t) => {
      if (safetyFilter !== 'all' && t.safety !== safetyFilter) return false;
      if (!q) return true;
      return (
        t.title.toLowerCase().includes(q) ||
        t.path.toLowerCase().includes(q) ||
        t.category.toLowerCase().includes(q)
      );
    });
  }, [tabTargets, query, safetyFilter]);

  const filteredPurge = useMemo(() => {
    const q = query.trim().toLowerCase();
    return purgeProjects.filter((p) => {
      if (!q) return true;
      return (
        p.projectName.toLowerCase().includes(q) ||
        p.artifactType.toLowerCase().includes(q) ||
        p.framework.toLowerCase().includes(q)
      );
    });
  }, [purgeProjects, query]);

  const cacheTotal = useMemo(
    () => targets.filter((t) => t.kind === 'cache').reduce((s, t) => s + t.sizeBytes, 0),
    [targets],
  );
  const installerTotal = useMemo(
    () => targets.filter((t) => t.kind === 'installer').reduce((s, t) => s + t.sizeBytes, 0),
    [targets],
  );
  const clutterTotal = useMemo(
    () => purgeProjects.reduce((s, p) => s + p.sizeBytes, 0),
    [purgeProjects],
  );

  const selectedBytes = useMemo(() => {
    const cleanB = targets
      .filter((t) => selectedIds.has(t.id) && !matchesWhitelist(t.path, activeWhitelistPatterns))
      .reduce((s, t) => s + t.sizeBytes, 0);
    const purgeB = purgeProjects
      .filter((p) => selectedPurgeIds.has(p.id))
      .reduce((s, p) => s + p.sizeBytes, 0);
    return cleanB + purgeB;
  }, [targets, selectedIds, activeWhitelistPatterns, purgeProjects, selectedPurgeIds]);

  const selectedCount = useMemo(() => {
    const cleanC = targets.filter(
      (t) => selectedIds.has(t.id) && !matchesWhitelist(t.path, activeWhitelistPatterns),
    ).length;
    return cleanC + selectedPurgeIds.size;
  }, [targets, selectedIds, activeWhitelistPatterns, selectedPurgeIds]);

  const handleStartScan = () => {
    if (scanTimerRef.current !== null) {
      window.clearTimeout(scanTimerRef.current);
    }
    setScanning(true);
    scanTimerRef.current = window.setTimeout(() => {
      scanTimerRef.current = null;
      setScanning(false);
      onSetScanned(true);
    }, 320);
  };

  const selectSafeInTab = () => {
    if (subTab === 'clutter') {
      onSelectStalePurge(
        purgeProjects.filter((p) => p.staleDays >= staleThresholdDays).map((p) => p.id),
      );
      return;
    }
    const next = new Set(selectedIds);
    for (const item of tabTargets) {
      if (item.safety === 'safe' && !matchesWhitelist(item.path, activeWhitelistPatterns)) {
        next.add(item.id);
      }
    }
    onSelectMany(Array.from(next));
  };

  const clearInTab = () => {
    if (subTab === 'clutter') {
      onSelectStalePurge([]);
      return;
    }
    const tabIds = new Set(tabTargets.map((t) => t.id));
    onSelectMany(Array.from(selectedIds).filter((id) => !tabIds.has(id)));
  };

  const safetyColor = (tier: SafetyTier) => {
    if (tier === 'safe') return 'text-[var(--status-safe)]';
    if (tier === 'moderate') return 'text-[var(--status-warn)]';
    return 'text-[var(--status-danger)]';
  };

  const safetyLabel = (tier: SafetyTier) => {
    if (tier === 'safe') return 'Safe to remove';
    if (tier === 'moderate') return 'Review first';
    return 'System files';
  };

  // Hero Orb Stage matching Screenshot 1
  if (!scanned) {
    return (
      <div className="min-h-[calc(100vh-148px)] flex flex-col items-center justify-center text-center px-4">
        <div className="mb-8">
          <PlanetOrb kind="earth" size={198} />
        </div>

        <p className="font-serif-verse text-[17px] leading-[1.65] text-[var(--text-primary)] max-w-md">
          Mountain rain washes old dust away.
          <br />
          The ebbing tide leaves all things new.
        </p>

        <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
          <button
            onClick={handleStartScan}
            disabled={scanning}
            className="px-9 py-3 rounded-full bg-[var(--pill-active-bg)] text-[var(--pill-active-text)] text-sm font-semibold shadow-[var(--glass-shadow)] hover:opacity-90 disabled:opacity-60 transition-opacity"
          >
            {scanning ? 'Scanning PC...' : 'Scan your PC'}
          </button>
        </div>

        <button
          onClick={() => onSetScanned(true)}
          className="mt-5 text-xs text-[var(--text-muted)] hover:text-[var(--text-secondary)] transition-colors tabular-nums"
        >
          {formatBytes(cacheTotal + installerTotal + clutterTotal)} ready across {targets.length + purgeProjects.length} cleanup categories
        </button>
      </div>
    );
  }

  // Scanned Results Stage
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex items-center p-1 rounded-full glass-panel">
            <button
              onClick={() => setSubTab('cache')}
              className={`px-3.5 py-1.5 text-xs font-medium rounded-full transition-colors whitespace-nowrap ${
                subTab === 'cache'
                  ? 'bg-[var(--pill-active-bg)] text-[var(--pill-active-text)]'
                  : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
              }`}
            >
              Temp & caches ({formatBytes(cacheTotal)})
            </button>
            <button
              onClick={() => setSubTab('installer')}
              className={`inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-medium rounded-full transition-colors whitespace-nowrap ${
                subTab === 'installer'
                  ? 'bg-[var(--pill-active-bg)] text-[var(--pill-active-text)]'
                  : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
              }`}
            >
              <FileArchive className="w-3.5 h-3.5" />
              Old installers ({formatBytes(installerTotal)})
            </button>
            <button
              onClick={() => setSubTab('clutter')}
              className={`inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-medium rounded-full transition-colors whitespace-nowrap ${
                subTab === 'clutter'
                  ? 'bg-[var(--pill-active-bg)] text-[var(--pill-active-text)]'
                  : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
              }`}
            >
              <FolderX className="w-3.5 h-3.5" />
              Build clutter ({formatBytes(clutterTotal)})
            </button>
          </div>

          <button
            onClick={() => onSetScanned(false)}
            aria-label="Return to scan home"
            title="Return to orb view"
            className="p-2 rounded-full glass-panel glass-panel-hover text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
          >
            <RotateCcw className="w-3.5 h-3.5" />
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <span className="text-xs text-[var(--text-secondary)] tabular-nums">
            Selected <strong className="text-[var(--status-safe)] font-semibold">{formatBytes(selectedBytes)}</strong>
          </span>
          <button
            onClick={onOpenDryRun}
            disabled={selectedCount === 0}
            className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold rounded-full bg-[var(--pill-active-bg)] text-[var(--pill-active-text)] hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed transition-opacity whitespace-nowrap"
          >
            <Sparkles className="w-3.5 h-3.5" />
            Review & clean ({selectedCount})
          </button>
        </div>
      </div>

      {/* Filters Row */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative">
            <Search className="w-3.5 h-3.5 text-[var(--text-muted)] absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={subTab === 'clutter' ? 'Search project folders...' : 'Search junk or folders...'}
              className="pl-8 pr-3 py-1.5 w-56 text-xs rounded-full glass-panel text-[var(--text-primary)] placeholder:text-[var(--text-muted)]"
            />
          </div>

          {subTab !== 'clutter' ? (
            <div className="inline-flex items-center gap-1 p-1 rounded-full glass-panel">
              {(['all', 'safe', 'moderate', 'caution'] as const).map((tier) => (
                <button
                  key={tier}
                  onClick={() => setSafetyFilter(tier)}
                  className={`px-2.5 py-1 text-xs rounded-full capitalize transition-colors whitespace-nowrap ${
                    safetyFilter === tier
                      ? 'bg-[var(--accent-tint)] text-[var(--text-primary)] font-medium'
                      : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                  }`}
                >
                  {tier}
                </button>
              ))}
            </div>
          ) : (
            <div className="inline-flex items-center gap-1 p-1 rounded-full glass-panel">
              {[7, 30, 60, 90].map((days) => (
                <button
                  key={days}
                  onClick={() => onChangeThreshold(days)}
                  className={`px-2.5 py-1 text-xs rounded-full transition-colors whitespace-nowrap ${
                    staleThresholdDays === days
                      ? 'bg-[var(--accent-tint)] text-[var(--text-primary)] font-medium'
                      : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                  }`}
                >
                  {days}d+ untouched
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={selectSafeInTab}
            className="px-3 py-1.5 text-xs font-medium rounded-full glass-panel glass-panel-hover text-[var(--text-primary)]"
          >
            {subTab === 'clutter' ? `Select ${staleThresholdDays}d+` : 'Select safe'}
          </button>
          <button
            onClick={clearInTab}
            className="px-3 py-1.5 text-xs font-medium rounded-full glass-panel glass-panel-hover text-[var(--text-secondary)]"
          >
            Clear
          </button>
        </div>
      </div>

      {/* Results List */}
      <div className="rounded-2xl glass-panel overflow-hidden">
        {subTab !== 'clutter' ? (
          <div className="divide-y divide-[var(--border-subtle)]">
            {filteredTargets.map((item) => {
              const isWhitelisted = matchesWhitelist(item.path, activeWhitelistPatterns);
              const isChecked = selectedIds.has(item.id) && !isWhitelisted;

              return (
                <div
                  key={item.id}
                  onClick={() => !isWhitelisted && onToggleId(item.id)}
                  className={`px-5 py-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-4 transition-colors ${
                    isWhitelisted
                      ? 'opacity-55 bg-[var(--bg-inset)]'
                      : 'cursor-pointer hover:bg-[var(--bg-surface-hover)]'
                  }`}
                >
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-x-2.5 gap-y-0.5">
                      <span className="text-sm font-medium text-[var(--text-primary)]">
                        {item.title}
                      </span>
                      <span className={`inline-flex items-center gap-1 text-xs font-medium ${safetyColor(item.safety)}`}>
                        {item.safety === 'caution' && <AlertTriangle className="w-3 h-3" />}
                        {safetyLabel(item.safety)}
                      </span>
                      {item.requiresAdmin && (
                        <span className="inline-flex items-center gap-1 text-xs text-[var(--status-warn)]">
                          <Lock className="w-3 h-3" />
                          {os === 'windows' ? 'Admin prompt' : 'Password needed'}
                        </span>
                      )}
                      {isWhitelisted && (
                        <span className="inline-flex items-center gap-1 text-xs font-medium text-[var(--status-info)]">
                          <Shield className="w-3 h-3" />
                          Protected
                        </span>
                      )}
                    </div>

                    <p className="text-xs text-[var(--text-secondary)]">
                      {item.description}
                    </p>

                    <div className="flex flex-wrap items-center gap-x-3 text-xs text-[var(--text-muted)] tabular-nums">
                      <span className="font-mono truncate max-w-full">{item.path}</span>
                      <span>{formatNumber(item.itemCount)} items</span>
                      <span>Updated {formatRelativeDays(item.lastModifiedDays)}</span>
                    </div>
                  </div>

                  <div className="flex items-center justify-between sm:justify-end gap-4 shrink-0">
                    {!isWhitelisted && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onAddWhitelist(item.path, `Protected from ${item.title}`);
                        }}
                        className="inline-flex items-center gap-1 px-2.5 py-1 text-xs text-[var(--text-secondary)] hover:text-[var(--status-info)] rounded-full border border-[var(--glass-border)] transition-colors whitespace-nowrap"
                      >
                        <Shield className="w-3 h-3" />
                        Keep safe
                      </button>
                    )}

                    <span className="text-sm font-semibold tabular-nums text-[var(--text-primary)] min-w-[74px] text-right">
                      {formatBytes(item.sizeBytes)}
                    </span>

                    <button
                      type="button"
                      disabled={isWhitelisted}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (!isWhitelisted) onToggleId(item.id);
                      }}
                      aria-label={`Select ${item.title}`}
                      className={`w-4 h-4 rounded flex items-center justify-center border transition-colors shrink-0 ${
                        isChecked
                          ? 'bg-[var(--pill-active-bg)] border-[var(--pill-active-bg)] text-[var(--pill-active-text)]'
                          : 'border-[var(--border-strong)]'
                      }`}
                    >
                      {isChecked && <Check className="w-3 h-3 stroke-[2.5]" />}
                    </button>
                  </div>
                </div>
              );
            })}

            {filteredTargets.length === 0 && (
              <div className="py-12 text-center text-xs text-[var(--text-muted)]">
                No cleanup items match your filter.
              </div>
            )}
          </div>
        ) : (
          <div className="divide-y divide-[var(--border-subtle)]">
            {filteredPurge.map((project) => {
              const checked = selectedPurgeIds.has(project.id);
              const isStale = project.staleDays >= staleThresholdDays;

              return (
                <div
                  key={project.id}
                  onClick={() => onTogglePurgeId(project.id)}
                  className="px-5 py-3.5 flex items-center justify-between gap-4 cursor-pointer hover:bg-[var(--bg-surface-hover)] transition-colors"
                >
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2.5">
                      <span className="text-sm font-medium text-[var(--text-primary)]">
                        {project.projectName}
                      </span>
                      <span className="px-2 py-0.5 rounded bg-[var(--bg-inset)] font-mono text-[11px] text-[var(--text-secondary)]">
                        {project.artifactType}
                      </span>
                      <span className="text-xs text-[var(--text-muted)]">
                        {project.framework}
                      </span>
                      {isStale && (
                        <span className="text-xs font-medium text-[var(--status-safe)]">
                          Untouched {project.staleDays}d
                        </span>
                      )}
                    </div>
                    <div className="text-xs font-mono text-[var(--text-muted)] truncate">
                      {project.path} ({formatNumber(project.fileCount)} files)
                    </div>
                  </div>

                  <div className="flex items-center gap-4 shrink-0">
                    <span className="text-sm font-semibold tabular-nums text-[var(--text-primary)]">
                      {formatBytes(project.sizeBytes)}
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
        )}
      </div>
    </div>
  );
}
