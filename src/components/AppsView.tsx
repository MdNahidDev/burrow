import {
  ArrowDown,
  ArrowUp,
  ArrowUpRight,
  Check,
  Lock,
  RefreshCw,
  Search,
  Sparkles,
  X,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import type { InstalledApp, OsTarget, StartupItem } from '../types/burrow';
import { formatBytes, formatRelativeDays } from '../utils/format';
import { AppBadge } from './AppBadge';

interface AppsViewProps {
  os: OsTarget;
  apps: InstalledApp[];
  startupItems: StartupItem[];
  selectedUninstallIds: Set<string>;
  selectedUpgradeIds: Set<string>;
  onToggleUninstall: (appId: string) => void;
  onToggleUpgrade: (appId: string) => void;
  onToggleStartup: (id: string) => void;
  onOpenDryRun: () => void;
  onRefresh: () => void;
}

type AppsSubTab = 'uninstall' | 'updates' | 'startup';
type SortField = 'size' | 'name' | 'used';

export function AppsView({
  os,
  apps,
  startupItems,
  selectedUninstallIds,
  selectedUpgradeIds,
  onToggleUninstall,
  onToggleUpgrade,
  onToggleStartup,
  onOpenDryRun,
  onRefresh,
}: AppsViewProps) {
  const [tab, setTab] = useState<AppsSubTab>('uninstall');
  const [sortBy, setSortBy] = useState<SortField>('size');
  const [sortDesc, setSortDesc] = useState(true);
  const [query, setQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [inspectedAppId, setInspectedAppId] = useState<string | null>(null);

  const totalAppFootprint = (app: InstalledApp) =>
    app.leftovers.reduce((sum, l) => sum + l.sizeBytes, 0);

  const filteredApps = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = apps.filter((app) => {
      if (tab === 'updates' && app.version === app.latestVersion) return false;
      if (!q) return true;
      return (
        app.name.toLowerCase().includes(q) ||
        app.bundleId.toLowerCase().includes(q) ||
        app.publisher.toLowerCase().includes(q)
      );
    });

    return list.slice().sort((a, b) => {
      const dir = sortDesc ? -1 : 1;
      if (sortBy === 'name') return a.name.localeCompare(b.name) * (sortDesc ? 1 : -1);
      if (sortBy === 'used') return (a.lastUsedDays - b.lastUsedDays) * dir;
      return (totalAppFootprint(a) - totalAppFootprint(b)) * dir;
    });
  }, [apps, tab, query, sortBy, sortDesc]);

  const filteredStartup = useMemo(() => {
    const q = query.trim().toLowerCase();
    return startupItems.filter((item) => {
      if (!q) return true;
      return (
        item.name.toLowerCase().includes(q) ||
        item.publisher.toLowerCase().includes(q) ||
        item.mechanism.toLowerCase().includes(q)
      );
    });
  }, [startupItems, query]);

  const inspectedApp = useMemo(
    () => apps.find((a) => a.id === inspectedAppId) ?? null,
    [apps, inspectedAppId],
  );

  const totalFootprintAll = useMemo(
    () => filteredApps.reduce((s, a) => s + totalAppFootprint(a), 0),
    [filteredApps],
  );

  const outdatedCount = useMemo(
    () => apps.filter((a) => a.version !== a.latestVersion).length,
    [apps],
  );

  const selectedCount = selectedUninstallIds.size + selectedUpgradeIds.size;

  const toggleSort = (field: SortField) => {
    if (sortBy === field) setSortDesc(!sortDesc);
    else {
      setSortBy(field);
      setSortDesc(field !== 'name');
    }
  };

  return (
    <div className="space-y-5 pb-16">
      {/* Top Sub-Pill & Sort Strip (matching Screenshot 6) */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-2.5">
          <div className="inline-flex items-center p-1 rounded-full glass-panel">
            {(
              [
                { id: 'uninstall', label: 'Uninstall' },
                { id: 'updates', label: outdatedCount > 0 ? `Updates (${outdatedCount})` : 'Updates' },
                { id: 'startup', label: 'Startup' },
              ] as const
            ).map((item) => (
              <button
                key={item.id}
                onClick={() => setTab(item.id)}
                className={`px-3.5 py-1.5 text-xs font-medium rounded-full transition-colors whitespace-nowrap ${
                  tab === item.id
                    ? 'bg-[var(--pill-active-bg)] text-[var(--pill-active-text)]'
                    : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                }`}
              >
                {item.label}
              </button>
            ))}
          </div>

          <button
            onClick={onRefresh}
            aria-label="Refresh app inventory"
            className="p-2 rounded-full glass-panel glass-panel-hover text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-4 text-xs text-[var(--text-secondary)]">
          {tab !== 'startup' && (
            <>
              <button
                onClick={() => toggleSort('name')}
                className={`inline-flex items-center gap-1 transition-colors ${
                  sortBy === 'name' ? 'text-[var(--text-primary)] font-medium' : 'hover:text-[var(--text-primary)]'
                }`}
              >
                Name
                {sortBy === 'name' && (sortDesc ? <ArrowUp className="w-3 h-3" /> : <ArrowDown className="w-3 h-3" />)}
              </button>
              <button
                onClick={() => toggleSort('size')}
                className={`inline-flex items-center gap-1 transition-colors ${
                  sortBy === 'size' ? 'text-[var(--text-primary)] font-medium' : 'hover:text-[var(--text-primary)]'
                }`}
              >
                App size
                {sortBy === 'size' && (sortDesc ? <ArrowDown className="w-3 h-3" /> : <ArrowUp className="w-3 h-3" />)}
              </button>
              <button
                onClick={() => toggleSort('used')}
                className={`inline-flex items-center gap-1 transition-colors ${
                  sortBy === 'used' ? 'text-[var(--text-primary)] font-medium' : 'hover:text-[var(--text-primary)]'
                }`}
              >
                Last used
                {sortBy === 'used' && (sortDesc ? <ArrowDown className="w-3 h-3" /> : <ArrowUp className="w-3 h-3" />)}
              </button>
            </>
          )}

          <div className="flex items-center gap-1.5">
            {searchOpen && (
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search apps..."
                autoFocus
                className="px-3 py-1 w-44 text-xs rounded-full bg-[var(--bg-inset)] border border-[var(--glass-border)] text-[var(--text-primary)] placeholder:text-[var(--text-muted)]"
              />
            )}
            <button
              onClick={() => {
                if (searchOpen) setQuery('');
                setSearchOpen(!searchOpen);
              }}
              aria-label="Search apps"
              className="p-1.5 rounded-full text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-surface-hover)] transition-colors"
            >
              <Search className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </div>

      {/* Meta Line */}
      <div className="flex items-center justify-between px-1 text-xs">
        <div className="flex items-baseline gap-3">
          <span className="font-semibold text-[var(--text-primary)]">
            {tab === 'uninstall' ? 'Installed Apps' : tab === 'updates' ? 'Available Updates' : 'Startup Apps'}
          </span>
          <span className="text-[var(--text-muted)] tabular-nums">
            {tab === 'startup'
              ? `${filteredStartup.length} entries`
              : `${filteredApps.length} apps, ${formatBytes(totalFootprintAll)}`}
          </span>
        </div>

        {selectedCount > 0 && (
          <button
            onClick={onOpenDryRun}
            className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold rounded-full bg-[var(--pill-active-bg)] text-[var(--pill-active-text)] hover:opacity-90 transition-opacity"
          >
            <Sparkles className="w-3.5 h-3.5" />
            {selectedUninstallIds.size > 0 && selectedUpgradeIds.size > 0
              ? `Uninstall & update (${selectedCount})`
              : selectedUpgradeIds.size > 0
                ? `Update selected (${selectedUpgradeIds.size})`
                : `Uninstall selected (${selectedUninstallIds.size})`}
          </button>
        )}
      </div>

      {/* Main Spacious Glass List + Optional Leftover Drawer */}
      <div className={inspectedApp && tab !== 'startup' ? 'grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_360px] gap-4 items-start' : ''}>
        {tab !== 'startup' ? (
          <div className="space-y-1">
            {filteredApps.map((app) => {
              const footprint = totalAppFootprint(app);
              const outdated = app.version !== app.latestVersion;
              const isSelected =
                tab === 'uninstall' ? selectedUninstallIds.has(app.id) : selectedUpgradeIds.has(app.id);
              const isInspected = inspectedApp?.id === app.id;

              return (
                <div
                  key={app.id}
                  onClick={() => setInspectedAppId(isInspected ? null : app.id)}
                  className={`px-4 py-3 rounded-xl flex items-center justify-between gap-4 cursor-pointer transition-colors ${
                    isInspected
                      ? 'glass-panel'
                      : 'hover:bg-[var(--bg-surface-hover)] border border-transparent'
                  }`}
                >
                  <div className="flex items-center gap-3.5 min-w-0">
                    <AppBadge name={app.name} />
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-[var(--text-primary)] truncate">
                        {app.name}
                      </div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-x-2.5 text-xs text-[var(--text-muted)] tabular-nums">
                        <span>{app.version}</span>
                        <span>{formatBytes(footprint)}</span>
                        <span>Used {formatRelativeDays(app.lastUsedDays)}</span>
                        {outdated && (
                          <span className="inline-flex items-center gap-0.5 text-[var(--status-safe)] font-medium">
                            <ArrowUpRight className="w-3 h-3" />
                            Update {app.latestVersion}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>

                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      if (tab === 'uninstall') onToggleUninstall(app.id);
                      else onToggleUpgrade(app.id);
                    }}
                    aria-label={`Select ${app.name}`}
                    className={`w-4 h-4 rounded flex items-center justify-center border transition-colors shrink-0 ${
                      isSelected
                        ? 'bg-[var(--pill-active-bg)] border-[var(--pill-active-bg)] text-[var(--pill-active-text)]'
                        : 'border-[var(--border-strong)] hover:border-[var(--text-primary)]'
                    }`}
                  >
                    {isSelected && <Check className="w-3 h-3 stroke-[2.5]" />}
                  </button>
                </div>
              );
            })}

            {filteredApps.length === 0 && (
              <div className="py-16 text-center text-xs text-[var(--text-muted)]">
                {tab === 'updates' ? 'All tracked apps are up to date.' : 'No installed apps match your search.'}
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-1">
            {filteredStartup.map((item) => (
              <div
                key={item.id}
                className="px-4 py-3 rounded-xl flex flex-col sm:flex-row sm:items-center justify-between gap-4 hover:bg-[var(--bg-surface-hover)] transition-colors"
              >
                <div className="flex items-center gap-3.5 min-w-0">
                  <AppBadge name={item.name} />
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium text-[var(--text-primary)]">
                        {item.name}
                      </span>
                      <span
                        className={`text-xs font-medium capitalize ${
                          item.impact === 'high'
                            ? 'text-[var(--status-danger)]'
                            : item.impact === 'medium'
                              ? 'text-[var(--status-warn)]'
                              : 'text-[var(--status-safe)]'
                        }`}
                      >
                        {item.impact} impact
                      </span>
                    </div>
                    <div className="mt-0.5 text-xs text-[var(--text-muted)] truncate">
                      {item.publisher} ({item.mechanism})
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-3 shrink-0 pl-11 sm:pl-0">
                  {item.locked ? (
                    <span className="inline-flex items-center gap-1.5 text-xs text-[var(--status-info)]">
                      <Lock className="w-3.5 h-3.5" />
                      Protected system item
                    </span>
                  ) : (
                    <>
                      <span className="text-xs text-[var(--text-muted)]">
                        {item.enabled ? 'Starts at sign-in' : 'Paused'}
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
        )}

        {/* Leftover Inspector Glass Card (on app row click) */}
        {inspectedApp && tab !== 'startup' && (
          <div className="rounded-2xl glass-panel p-5 space-y-4">
            <div className="flex items-start justify-between gap-2 pb-3 border-b border-[var(--border-subtle)]">
              <div className="min-w-0">
                <h2 className="text-sm font-semibold text-[var(--text-primary)] truncate">
                  {inspectedApp.name}
                </h2>
                <p className="mt-0.5 text-xs text-[var(--text-muted)] truncate">
                  {inspectedApp.publisher}
                </p>
              </div>
              <button
                onClick={() => setInspectedAppId(null)}
                aria-label="Close app details"
                className="p-1 rounded-full text-[var(--text-muted)] hover:text-[var(--text-primary)]"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between text-xs text-[var(--text-secondary)]">
                <span>Leftover locations</span>
                <span className="font-medium tabular-nums text-[var(--text-primary)]">
                  {formatBytes(totalAppFootprint(inspectedApp))}
                </span>
              </div>
              <div className="space-y-1.5">
                {inspectedApp.leftovers.map((loc) => (
                  <div key={loc.id} className="px-3 py-2 rounded-lg bg-[var(--bg-inset)] text-xs">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium text-[var(--text-primary)] inline-flex items-center gap-1.5">
                        {loc.kind}
                        {loc.requiresAdmin && <Lock className="w-3 h-3 text-[var(--status-warn)]" />}
                      </span>
                      <span className="tabular-nums text-[var(--text-secondary)]">
                        {formatBytes(loc.sizeBytes)}
                      </span>
                    </div>
                    <div className="mt-0.5 font-mono text-[11px] text-[var(--text-muted)] break-all">
                      {loc.path}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {inspectedApp.version !== inspectedApp.latestVersion && (
              <div className="pt-2 border-t border-[var(--border-subtle)] flex items-center justify-between gap-3">
                <div className="text-xs">
                  <div className="font-medium text-[var(--text-primary)]">
                    Version {inspectedApp.latestVersion} available
                  </div>
                  <div className="text-[var(--text-muted)]">
                    Managed via {inspectedApp.updateSource === 'winget' ? 'Windows Package Manager' : 'Microsoft Store'}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => onToggleUpgrade(inspectedApp.id)}
                  className={`px-3 py-1.5 rounded-full text-xs font-medium transition-colors whitespace-nowrap ${
                    selectedUpgradeIds.has(inspectedApp.id)
                      ? 'bg-[var(--pill-active-bg)] text-[var(--pill-active-text)]'
                      : 'glass-panel glass-panel-hover text-[var(--text-primary)]'
                  }`}
                >
                  {selectedUpgradeIds.has(inspectedApp.id) ? 'Queued' : 'Stage update'}
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
