import { Download, Moon, Pause, Play, Settings, ShieldCheck, Sparkles, Sun, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnalyzerView } from './components/AnalyzerView';
import { AppsView } from './components/AppsView';
import { DeepCleanView } from './components/DeepCleanView';
import { LeftoversDialog } from './components/LeftoversDialog';
import { DryRunDrawer, type ActionExecutionItem } from './components/DryRunDrawer';
import { OptimizeView } from './components/OptimizeView';
import { ProfilesView } from './components/ProfilesView';
import { StatusView } from './components/StatusView';
import {
  getTelemetryProfile,
  WINDOWS_APPS,
  WINDOWS_CLEAN_TARGETS,
  WINDOWS_DISK_TREE,
  WINDOWS_OPTIMIZE,
  WINDOWS_PURGE_PROJECTS,
  WINDOWS_STARTUP,
} from './data/osProfiles';
import type {
  CleanTarget,
  InstalledApp,
  MaintenanceProfile,
  OsTarget,
  PersistedState,
  PurgeProject,
  StartupItem,
  TelemetrySnapshot,
} from './types/burrow';
import { formatBytes, matchesWhitelist } from './utils/format';
import {
  addLocalHistory,
  addLocalProfile,
  addLocalWhitelist,
  deleteLocalProfile,
  deleteLocalWhitelist,
  loadLocalState,
} from './utils/localPersistence';
import {
  cleanWindowsTargetsTauri,
  deleteAppLeftoversTauri,
  fetchWindowsTelemetry,
  findAppLeftoversTauri,
  isTauriRuntime,
  listAppUpdatesTauri,
  listInstalledAppsTauri,
  listStartupItemsTauri,
  runWindowsOptimizeTauri,
  runWingetUpgradeTauri,
  scanDownloadsTauri,
  scanPurgeProjectsTauri,
  scanWindowsTargetsTauri,
  setStartupEnabledTauri,
  uninstallAppTauri,
  type LeftoverItem,
  type LeftoverQuery,
  type LeftoverResult,
} from './utils/tauriBridge';
import {
  appsFromNative,
  applyScanResults,
  downloadToTarget,
  knownCleanTargets,
  purgeFromNative,
  startupFromNative,
} from './utils/nativeData';

type MainTab = 'clean' | 'apps' | 'optimize' | 'analyzer' | 'status';
type SettingsTab = 'presets' | 'appearance';

const WINDOWS_OS = 'windows' as const;

const TOP_TABS: Array<{ id: MainTab; label: string }> = [
  { id: 'clean', label: 'Clean' },
  { id: 'apps', label: 'Apps' },
  { id: 'optimize', label: 'Optimize' },
  { id: 'analyzer', label: 'Analyze' },
  { id: 'status', label: 'Status' },
];

const BACKDROP_VAR_BY_TAB: Record<MainTab, string> = {
  clean: 'var(--backdrop-clean)',
  apps: 'var(--backdrop-apps)',
  optimize: 'var(--backdrop-optimize)',
  analyzer: 'var(--backdrop-analyze)',
  status: 'var(--backdrop-status)',
};

export default function App() {
  const [activeTab, setActiveTab] = useState<MainTab>('clean');
  const [darkMode, setDarkMode] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('presets');
  const [cleanScanned, setCleanScanned] = useState(false);
  const [optimizeExpanded, setOptimizeExpanded] = useState(false);
  const [analyzerMapped, setAnalyzerMapped] = useState(false);

  // Offline telemetry state (auto-upgrades to native Rust Tauri sysinfo on Windows PC)
  const [native] = useState(() => isTauriRuntime());
  const [telemetry, setTelemetry] = useState<TelemetrySnapshot | null>(() =>
    isTauriRuntime() ? null : getTelemetryProfile(WINDOWS_OS),
  );
  const [telemetryLoading, setTelemetryLoading] = useState(false);
  const [polling, setPolling] = useState(true);

  // Live working datasets that reflect GUI clean/uninstall/update actions immediately
  // In the installed app these start empty and are filled by real scans of this PC.
  const [cleanTargets, setCleanTargets] = useState<CleanTarget[]>(() =>
    isTauriRuntime() ? knownCleanTargets() : WINDOWS_CLEAN_TARGETS,
  );
  const [purgeProjects, setPurgeProjects] = useState<PurgeProject[]>(() =>
    isTauriRuntime() ? [] : WINDOWS_PURGE_PROJECTS,
  );
  const [appsList, setAppsList] = useState<InstalledApp[]>(() =>
    isTauriRuntime() ? [] : WINDOWS_APPS,
  );
  const [nativeStartup, setNativeStartup] = useState<StartupItem[]>([]);
  const [appsLoaded, setAppsLoaded] = useState(false);

  // Revo-style review window shown after a program has been uninstalled.
  const [leftoverQueue, setLeftoverQueue] = useState<LeftoverQuery[]>([]);
  const [leftoverReview, setLeftoverReview] = useState<{
    query: LeftoverQuery;
    items: LeftoverItem[];
    results: LeftoverResult[] | null;
    busy: boolean;
  } | null>(null);

  // Offline localStorage persistence for presets, whitelist, and run history
  const [persisted, setPersisted] = useState<PersistedState>(() => loadLocalState());

  // Working selections
  const [selectedCleanIds, setSelectedCleanIds] = useState<Set<string>>(
    () =>
      new Set(
        isTauriRuntime()
          ? ['win-user-temp', 'win-dx-shader', 'win-edge-chrome', 'win-nuget-npm']
          : ['win-user-temp', 'win-dx-shader', 'win-edge-chrome', 'win-nuget-npm', 'win-inst-cuda'],
      ),
  );
  const [selectedUninstallIds, setSelectedUninstallIds] = useState<Set<string>>(() => new Set());
  const [selectedUpgradeIds, setSelectedUpgradeIds] = useState<Set<string>>(() => new Set());
  const [selectedPurgeIds, setSelectedPurgeIds] = useState<Set<string>>(
    () => new Set(isTauriRuntime() ? [] : ['wp-1', 'wp-2', 'wp-3', 'wp-5']),
  );
  const [selectedOptimizeIds, setSelectedOptimizeIds] = useState<Set<string>>(
    () => new Set(['wo-dns', 'wo-thumb', 'wo-standby']),
  );
  const [appliedOptimizeIds, setAppliedOptimizeIds] = useState<Set<string>>(() => new Set());
  const [staleThresholdDays, setStaleThresholdDays] = useState(30);

  // Startup toggles stored locally per session
  const [startupStates, setStartupStates] = useState<Record<string, boolean>>({});

  // Action Confirmation & Execution Sheet state
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [dryRunDefault, setDryRunDefault] = useState(true);
  const [executingActions, setExecutingActions] = useState(false);
  const executingRef = useRef(false);
  const [actionResults, setActionResults] = useState<ActionExecutionItem[] | null>(null);

  // Toast feedback
  const [toast, setToast] = useState<string | null>(null);
  const showToast = useCallback((message: string) => {
    setToast(message);
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 3200);
    return () => clearTimeout(timer);
  }, [toast]);

  // Sync dark / frosted light theme classes on <html>
  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle('light', !darkMode);
    root.classList.toggle('dark', darkMode);
  }, [darkMode]);

  useEffect(() => {
    if (!settingsOpen) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSettingsOpen(false);
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [settingsOpen]);

  // Real scan of this PC: known cache folders, big downloads, and developer build folders.
  const refreshNativeWindowsTargets = useCallback(async () => {
    if (!isTauriRuntime()) return;
    try {
      const base = knownCleanTargets();
      const [results, downloads, purge] = await Promise.all([
        scanWindowsTargetsTauri(base.map((t) => ({ id: t.id, path: t.path }))),
        scanDownloadsTauri().catch(() => []),
        scanPurgeProjectsTauri().catch(() => []),
      ]);
      setCleanTargets([...applyScanResults(base, results), ...downloads.map(downloadToTarget)]);
      setPurgeProjects(purgeFromNative(purge));
    } catch {
      showToast('Could not finish scanning this PC. Please try again.');
    }
  }, [showToast]);

  // Real list of installed programs, available updates and startup items.
  const refreshNativeApps = useCallback(async () => {
    if (!isTauriRuntime()) return;
    try {
      // Show the program list straight away; the update check (winget) can be slow.
      const [apps, startup] = await Promise.all([
        listInstalledAppsTauri(),
        listStartupItemsTauri().catch(() => []),
      ]);
      setAppsList(appsFromNative(apps, []));
      setNativeStartup(startupFromNative(startup));
      setStartupStates({});
      setAppsLoaded(true);
      listAppUpdatesTauri()
        .then((updates) => setAppsList(appsFromNative(apps, updates)))
        .catch(() => showToast('Update checks need the Windows Package Manager, which was not found.'));
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Could not read the installed programs.');
    }
  }, [showToast]);

  useEffect(() => {
    if (native && activeTab === 'apps' && !appsLoaded) {
      refreshNativeApps();
    }
  }, [native, activeTab, appsLoaded, refreshNativeApps]);

  // Sample Windows telemetry completely offline (native Rust sysinfo in Tauri or local Windows profile)
  const sampleTelemetry = useCallback(async () => {
    if (!isTauriRuntime()) {
      setTelemetry(getTelemetryProfile(WINDOWS_OS));
      return;
    }
    setTelemetryLoading(true);
    try {
      const snap = await fetchWindowsTelemetry();
      setTelemetry(snap);
    } catch {
      // keep the previous real reading
    } finally {
      setTelemetryLoading(false);
    }
  }, []);

  useEffect(() => {
    if (activeTab !== 'status') return;
    sampleTelemetry();
    if (!polling) return;
    const interval = setInterval(() => {
      sampleTelemetry();
    }, 2000);
    return () => clearInterval(interval);
  }, [activeTab, sampleTelemetry, polling]);

  const startupItems = useMemo(
    () =>
      (native ? nativeStartup : WINDOWS_STARTUP).map((item) => ({
        ...item,
        enabled: startupStates[item.id] ?? item.enabled,
      })),
    [startupStates, native, nativeStartup],
  );

  const activeWhitelistPatterns = useMemo(
    () =>
      persisted.whitelist
        .filter((w) => w.os === WINDOWS_OS || w.os === 'all')
        .map((w) => w.pattern),
    [persisted.whitelist],
  );

  // Staged action arrays (honoring protected folders)
  const stagedCleanTargets = useMemo(
    () =>
      cleanTargets.filter(
        (t) => selectedCleanIds.has(t.id) && !matchesWhitelist(t.path, activeWhitelistPatterns),
      ),
    [cleanTargets, selectedCleanIds, activeWhitelistPatterns],
  );

  const stagedPurgeProjects = useMemo(
    () =>
      purgeProjects.filter(
        (p) => selectedPurgeIds.has(p.id) && !matchesWhitelist(p.path, activeWhitelistPatterns),
      ),
    [purgeProjects, selectedPurgeIds, activeWhitelistPatterns],
  );

  const stagedUninstallApps = useMemo(
    () => appsList.filter((a) => selectedUninstallIds.has(a.id)),
    [appsList, selectedUninstallIds],
  );

  const stagedUpgradeApps = useMemo(
    () => appsList.filter((a) => selectedUpgradeIds.has(a.id)),
    [appsList, selectedUpgradeIds],
  );

  const stagedOptimizeTasks = useMemo(
    () => WINDOWS_OPTIMIZE.filter((o) => selectedOptimizeIds.has(o.id)),
    [selectedOptimizeIds],
  );

  const stagedStartupChanges = useMemo(
    () => startupItems.filter((s) => s.id in startupStates),
    [startupItems, startupStates],
  );

  const totalSelectedReclaimable = useMemo(() => {
    const cleanBytes = stagedCleanTargets.reduce((s, t) => s + t.sizeBytes, 0);
    const purgeBytes = stagedPurgeProjects.reduce((s, p) => s + p.sizeBytes, 0);
    const uninstallBytes = stagedUninstallApps.reduce(
      (s, a) => s + a.leftovers.reduce((ls, l) => ls + l.sizeBytes, 0),
      0,
    );
    return cleanBytes + purgeBytes + uninstallBytes;
  }, [stagedCleanTargets, stagedPurgeProjects, stagedUninstallApps]);

  const toggleSet = (setter: React.Dispatch<React.SetStateAction<Set<string>>>, id: string) => {
    setter((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // Offline localStorage preset & whitelist handlers
  const handleAddWhitelist = (pattern: string, reason: string, targetOs: OsTarget | 'all' = WINDOWS_OS) => {
    setPersisted((prev) => addLocalWhitelist(prev, { pattern, reason, os: targetOs }));
    showToast(`Protected "${pattern}" locally`);
  };

  const handleDeleteWhitelist = (id: string) => {
    setPersisted((prev) => deleteLocalWhitelist(prev, id));
    showToast('Protection rule removed.');
  };

  const handleSaveProfile = (name: string, description: string) => {
    setPersisted((prev) =>
      addLocalProfile(prev, {
        name,
        description,
        os: WINDOWS_OS,
        cleanTargetIds: Array.from(selectedCleanIds),
        optimizeTaskIds: Array.from(selectedOptimizeIds),
        minStaleDays: staleThresholdDays,
        dryRunDefault,
      }),
    );
    showToast(`Saved "${name}"`);
  };

  const handleDeleteProfile = (id: string) => {
    setPersisted((prev) => deleteLocalProfile(prev, id));
    showToast('Preset deleted.');
  };

  const handleLoadProfile = (profile: MaintenanceProfile) => {
    setSelectedCleanIds(new Set(profile.cleanTargetIds));
    setSelectedOptimizeIds(new Set(profile.optimizeTaskIds));
    setStaleThresholdDays(profile.minStaleDays);
    setDryRunDefault(profile.dryRunDefault);
    setSettingsOpen(false);
    setActiveTab('clean');
    showToast(`Applied preset "${profile.name}"`);
  };

  const openActionRunner = () => {
    setActionResults(null);
    setDrawerOpen(true);
  };

  // What to search for once a program is gone (or when it has no uninstaller).
  const leftoverQueryFor = (app: InstalledApp, force: boolean): LeftoverQuery => {
    const binary = app.leftovers.find((l) => l.kind === 'Binary');
    return {
      appId: app.id,
      name: app.name,
      publisher: app.publisher === 'Unknown publisher' ? '' : app.publisher,
      installLocation: binary && binary.path !== app.name ? binary.path : '',
      force,
    };
  };

  // Show the next program's leftovers (one window at a time).
  useEffect(() => {
    if (leftoverReview || leftoverQueue.length === 0) return;
    const [next, ...rest] = leftoverQueue;
    setLeftoverQueue(rest);
    setLeftoverReview({ query: next, items: [], results: null, busy: true });
    findAppLeftoversTauri(next)
      .then((items) => setLeftoverReview({ query: next, items, results: null, busy: false }))
      .catch((err) => {
        showToast(typeof err === 'string' ? err : 'Could not search for leftovers.');
        setLeftoverReview(null);
      });
  }, [leftoverQueue, leftoverReview, showToast]);

  const handleDeleteLeftovers = async (selected: LeftoverItem[]) => {
    if (!leftoverReview) return;
    setLeftoverReview({ ...leftoverReview, busy: true });
    try {
      const results = await deleteAppLeftoversTauri(leftoverReview.query, selected);
      setLeftoverReview((prev) => (prev ? { ...prev, results, busy: false } : prev));
      const removed = results.filter((r) => r.ok).length;
      showToast(`Removed ${removed} of ${results.length} leftover items.`);
    } catch (err) {
      showToast(typeof err === 'string' ? err : 'Could not remove the leftovers.');
      setLeftoverReview((prev) => (prev ? { ...prev, busy: false } : prev));
    }
  };

  // Execute staged Windows actions via native Rust Tauri commands (or instant local preview update)
  const handleExecuteActions = async (asDryRun: boolean) => {
    if (executingRef.current) return;
    executingRef.current = true;
    setExecutingActions(true);
    try {
      const report: ActionExecutionItem[] = [];
      const tauriAttached = isTauriRuntime();
      const succeededFolderIds = new Set<string>();
      const succeededUninstallIds = new Set<string>();
      const succeededUpgradeIds = new Set<string>();
      const succeededOptimizeIds = new Set<string>();
      const queueForReview: LeftoverQuery[] = [];

      // 1. Temp, caches, installers, and build clutter folders
      const folderTargets = [
        ...stagedCleanTargets.map((t) => ({ id: t.id, title: t.title, path: t.path, bytes: t.sizeBytes })),
        ...stagedPurgeProjects.map((p) => ({
          id: p.id,
          title: `${p.projectName} (${p.artifactType})`,
          path: p.path,
          bytes: p.sizeBytes,
        })),
      ];

      if (folderTargets.length > 0) {
        if (tauriAttached) {
          const nativeReports = await cleanWindowsTargetsTauri(
            folderTargets.map((f) => ({ id: f.id, path: f.path })),
            asDryRun,
            activeWhitelistPatterns,
          );
          const byId = new Map(folderTargets.map((f) => [f.id, f]));
          for (const res of nativeReports) {
            const meta = byId.get(res.id);
            const ok = !res.status.startsWith('skipped');
            if (ok) succeededFolderIds.add(res.id);
            report.push({
              id: res.id,
              label: meta?.title ?? res.path,
              detail: res.path,
              bytes: res.bytes,
              status: res.status,
              ok,
            });
          }
        } else {
          for (const f of folderTargets) {
            succeededFolderIds.add(f.id);
            report.push({
              id: f.id,
              label: f.title,
              detail: f.path,
              bytes: f.bytes,
              status: asDryRun ? 'Safety check passed' : 'Cleaned',
              ok: true,
            });
          }
        }
      }

      // 2. App uninstalls & leftover cleanup (respecting protected folder whitelist)
      if (stagedUninstallApps.length > 0) {
        for (const app of stagedUninstallApps) {
          const eligibleLeftovers = app.leftovers.filter(
            (l) => !matchesWhitelist(l.path, activeWhitelistPatterns),
          );
          const leftoverBytes = eligibleLeftovers.reduce((s, l) => s + l.sizeBytes, 0);
          let ok = true;
          let status = asDryRun ? 'Ready to uninstall' : 'Uninstalled';

          if (tauriAttached && !asDryRun) {
            if (app.id.startsWith('winget:')) {
              ok = false;
              status = 'Store apps are removed from Windows Settings';
            } else {
              try {
                // Opens the program's own uninstall window; wait for it to close.
                await uninstallAppTauri(app.id);
                const stillThere = (await listInstalledAppsTauri()).some((a) => a.id === app.id);
                if (stillThere) {
                  ok = false;
                  status = 'Not removed (uninstall was cancelled or not finished)';
                }
              } catch (err) {
                ok = false;
                const msg = typeof err === 'string' ? err : err instanceof Error ? err.message : 'Uninstall failed';
                status = msg;
                if (msg.includes('no uninstaller')) {
                  queueForReview.push(leftoverQueryFor(app, true));
                  status = 'No uninstaller found: choose what to remove manually';
                }
              }
            }

            // Hunt for files and registry keys left behind; the person reviews them next.
            if (ok) {
              queueForReview.push(leftoverQueryFor(app, false));
            }
          }

          if (ok) succeededUninstallIds.add(app.id);
          report.push({
            id: app.id,
            label: `Uninstall ${app.name}`,
            detail: `${eligibleLeftovers.length} related locations`,
            bytes: leftoverBytes,
            status,
            ok,
          });
        }
      }

      // 3. App updates via winget
      if (stagedUpgradeApps.length > 0) {
        for (const app of stagedUpgradeApps) {
          let ok = true;
          let status = asDryRun ? `Ready (${app.latestVersion})` : `Updated to ${app.latestVersion}`;
          if (tauriAttached) {
            try {
              await runWingetUpgradeTauri(app.bundleId, asDryRun);
            } catch (err) {
              ok = false;
              status = err instanceof Error ? err.message : 'Update failed';
            }
          }
          if (ok) succeededUpgradeIds.add(app.id);
          report.push({
            id: `upg-${app.id}`,
            label: `Update ${app.name}`,
            detail: `${app.version} to ${app.latestVersion}`,
            bytes: 0,
            status,
            ok,
          });
        }
      }

      // 4. Windows system tune-ups (allowlisted by task ID in Rust)
      if (stagedOptimizeTasks.length > 0) {
        for (const task of stagedOptimizeTasks) {
          let ok = true;
          let status = asDryRun ? 'Verified' : 'Applied';
          if (tauriAttached) {
            try {
              await runWindowsOptimizeTauri(task.id, asDryRun);
            } catch (err) {
              ok = false;
              status = err instanceof Error ? err.message : 'Skipped';
            }
          }
          if (ok) succeededOptimizeIds.add(task.id);
          report.push({
            id: task.id,
            label: task.title,
            detail: task.estimatedGain,
            bytes: 0,
            status,
            ok,
          });
        }
      }

      // 5. Startup changes
      for (const st of stagedStartupChanges) {
        let ok = true;
        let status = asDryRun ? 'Verified' : st.enabled ? 'Enabled' : 'Paused';
        if (tauriAttached && !asDryRun) {
          const [scope, ...rest] = st.id.split(':');
          try {
            await setStartupEnabledTauri(scope, rest.join(':'), st.enabled);
          } catch (err) {
            ok = false;
            status = err instanceof Error ? err.message : 'Could not change this item';
          }
        }
        report.push({
          id: `st-${st.id}`,
          label: `${st.name} startup`,
          detail: st.publisher,
          bytes: 0,
          status,
          ok,
        });
      }

      const reclaimedBytes = report.filter((r) => r.ok).reduce((s, r) => s + r.bytes, 0);
      setActionResults(report);
      if (queueForReview.length > 0) setLeftoverQueue(queueForReview);

      // Update live UI state only for actions that actually succeeded
      if (!asDryRun) {
        if (tauriAttached) {
          await refreshNativeWindowsTargets();
          if (stagedUninstallApps.length > 0 || stagedUpgradeApps.length > 0 || stagedStartupChanges.length > 0) {
            await refreshNativeApps();
          }
        } else {
          setCleanTargets((prev) =>
            prev.map((t) =>
              succeededFolderIds.has(t.id) ? { ...t, sizeBytes: 0, itemCount: 0 } : t,
            ),
          );
        }

        if (succeededFolderIds.size > 0 && !tauriAttached) {
          setPurgeProjects((prev) => prev.filter((p) => !succeededFolderIds.has(p.id)));
        }

        if (!tauriAttached && (succeededUninstallIds.size > 0 || succeededUpgradeIds.size > 0)) {
          setAppsList((prev) =>
            prev
              .filter((a) => !succeededUninstallIds.has(a.id))
              .map((a) =>
                succeededUpgradeIds.has(a.id) ? { ...a, version: a.latestVersion } : a,
              ),
          );
        }

        if (succeededOptimizeIds.size > 0) {
          setAppliedOptimizeIds((prev) => new Set([...prev, ...succeededOptimizeIds]));
        }

        setSelectedCleanIds((prev) => {
          const next = new Set(prev);
          for (const id of succeededFolderIds) next.delete(id);
          return next;
        });
        setSelectedPurgeIds((prev) => {
          const next = new Set(prev);
          for (const id of succeededFolderIds) next.delete(id);
          return next;
        });
        setSelectedUninstallIds((prev) => {
          const next = new Set(prev);
          for (const id of succeededUninstallIds) next.delete(id);
          return next;
        });
        setSelectedUpgradeIds((prev) => {
          const next = new Set(prev);
          for (const id of succeededUpgradeIds) next.delete(id);
          return next;
        });
        setSelectedOptimizeIds((prev) => {
          const next = new Set(prev);
          for (const id of succeededOptimizeIds) next.delete(id);
          return next;
        });
        if (!tauriAttached) setStartupStates({});
      }

      const successCount = report.filter((r) => r.ok).length;
      setPersisted((prev) =>
        addLocalHistory(prev, {
          os: WINDOWS_OS,
          mode: asDryRun ? 'dry-run' : 'host-clean',
          summary: asDryRun
            ? `Checked ${successCount} Windows items`
            : `Cleaned & applied ${successCount} Windows items`,
          itemCount: successCount,
          reclaimedBytes,
          commandSnippet: asDryRun ? 'Safety check completed' : 'Applied directly in Burrow',
        }),
      );

      showToast(
        asDryRun
          ? `Safety check passed (${formatBytes(reclaimedBytes)})`
          : `Completed ${successCount} actions (${formatBytes(reclaimedBytes)} reclaimed)`,
      );
    } finally {
      executingRef.current = false;
      setExecutingActions(false);
    }
  };

  const runningInTauri = isTauriRuntime();

  return (
    <div
      className="min-h-screen flex flex-col text-[var(--text-primary)]"
      style={{ background: BACKDROP_VAR_BY_TAB[activeTab] }}
    >
      {/* Top Floating macOS Liquid Glass Bar — centered 5-tab pill + one quiet Settings icon */}
      <header className="sticky top-0 z-30 pt-4 pb-3 px-4 sm:px-7">
        <div className="max-w-[1220px] mx-auto flex items-center justify-between gap-3">
          {/* Left balancing spacer so the 5-tab pill stays mathematically centered */}
          <div className="w-9 h-9 hidden sm:block shrink-0" aria-hidden="true" />

          {/* Center: Iconic Floating Glass 5-Tab Segmented Pill */}
          <nav
            aria-label="Primary navigation"
            className="inline-flex items-center gap-1 p-1.5 rounded-full glass-pill mx-auto"
          >
            {/* Burrow Circular Emblem */}
            <span
              className="w-8 h-8 rounded-full bg-[var(--pill-active-bg)] text-[var(--pill-active-text)] inline-flex items-center justify-center shrink-0 mr-0.5"
              title="Burrow for Windows"
            >
              <svg viewBox="0 0 24 24" className="w-4 h-4" fill="currentColor" aria-hidden="true">
                <path d="M5 16c0-4.2 3.1-7.5 7.4-7.5 2.7 0 4.8 1.1 6.1 3 .6.8 1.5 1.1 2.2 1.2.4.1.6.5.3.9-.6.9-1.8 1.7-3.1 2.1-.6.2-1.1.8-1.4 1.5-.3.6-.8.8-1.4.8H6.5C5.6 18 5 17.2 5 16z" />
                <circle cx="15.8" cy="11.8" r="0.9" fill="var(--pill-active-bg)" />
              </svg>
            </span>

            {TOP_TABS.map((tab) => {
              const isActive = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={`px-4 py-1.5 text-xs sm:text-[13px] font-medium rounded-full transition-colors whitespace-nowrap ${
                    isActive
                      ? 'bg-[var(--pill-active-bg)] text-[var(--pill-active-text)] font-semibold'
                      : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                  }`}
                >
                  {tab.label}
                </button>
              );
            })}
          </nav>

          {/* Right: One quiet circular Settings icon button */}
          <button
            onClick={() => setSettingsOpen(true)}
            aria-label="Open Burrow Settings"
            title="Settings & Presets"
            className="w-9 h-9 rounded-full glass-pill hover:bg-[var(--bg-surface-hover)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] inline-flex items-center justify-center transition-colors shrink-0"
          >
            <Settings className="w-4 h-4" />
          </button>
        </div>
      </header>

      {/* Main Content Container */}
      <main className="flex-1 w-full max-w-[1220px] mx-auto px-4 sm:px-7 pb-8 pt-2">
        {activeTab === 'clean' && (
          <DeepCleanView
            os={WINDOWS_OS}
            targets={cleanTargets}
            purgeProjects={purgeProjects}
            selectedIds={selectedCleanIds}
            selectedPurgeIds={selectedPurgeIds}
            staleThresholdDays={staleThresholdDays}
            whitelist={persisted.whitelist}
            scanned={cleanScanned}
            onSetScanned={setCleanScanned}
            onToggleId={(id) => toggleSet(setSelectedCleanIds, id)}
            onSelectMany={(ids) => setSelectedCleanIds(new Set(ids))}
            onTogglePurgeId={(id) => toggleSet(setSelectedPurgeIds, id)}
            onSelectStalePurge={(ids) => setSelectedPurgeIds(new Set(ids))}
            onChangeThreshold={setStaleThresholdDays}
            onAddWhitelist={(pattern, reason) => handleAddWhitelist(pattern, reason, WINDOWS_OS)}
            onOpenDryRun={openActionRunner}
            onRescan={native ? refreshNativeWindowsTargets : undefined}
          />
        )}

        {activeTab === 'apps' && (
          <AppsView
            os={WINDOWS_OS}
            apps={appsList}
            startupItems={startupItems}
            selectedUninstallIds={selectedUninstallIds}
            selectedUpgradeIds={selectedUpgradeIds}
            onToggleUninstall={(id) => toggleSet(setSelectedUninstallIds, id)}
            onToggleUpgrade={(id) => toggleSet(setSelectedUpgradeIds, id)}
            onToggleStartup={(id) => {
              const current = startupItems.find((s) => s.id === id);
              if (!current) return;
              setStartupStates((prev) => ({ ...prev, [id]: !current.enabled }));
              showToast(`${current.name} marked ${current.enabled ? 'paused' : 'enabled'}.`);
            }}
            onOpenDryRun={openActionRunner}
            onRefresh={() => {
              if (native) refreshNativeApps();
              showToast('Refreshing your installed programs…');
            }}
          />
        )}

        {activeTab === 'optimize' && (
          <OptimizeView
            os={WINDOWS_OS}
            tasks={WINDOWS_OPTIMIZE}
            startupItems={startupItems}
            selectedOptimizeIds={selectedOptimizeIds}
            appliedOptimizeIds={appliedOptimizeIds}
            expanded={optimizeExpanded}
            onSetExpanded={setOptimizeExpanded}
            onToggleOptimize={(id) => toggleSet(setSelectedOptimizeIds, id)}
            onToggleStartup={(id) => {
              const current = startupItems.find((s) => s.id === id);
              if (!current) return;
              setStartupStates((prev) => ({ ...prev, [id]: !current.enabled }));
              showToast(`${current.name} marked ${current.enabled ? 'paused' : 'enabled'}.`);
            }}
            onOpenDryRun={openActionRunner}
          />
        )}

        {activeTab === 'analyzer' && (
          <AnalyzerView
            os={WINDOWS_OS}
            native={native}
            diskTree={WINDOWS_DISK_TREE}
            mapped={analyzerMapped}
            onSetMapped={setAnalyzerMapped}
            onRefreshHostScan={() => {
              refreshNativeWindowsTargets();
              showToast('Local drive refreshed.');
            }}
            onNotify={showToast}
          />
        )}

        {activeTab === 'status' && (
          <StatusView
            os={WINDOWS_OS}
            telemetry={telemetry}
            loading={telemetryLoading}
            polling={polling}
            onTogglePolling={() => setPolling(!polling)}
            onRefresh={sampleTelemetry}
          />
        )}
      </main>

      {/* Unified Frosted Glass Settings Sheet */}
      {settingsOpen && (
        <div
          onClick={() => setSettingsOpen(false)}
          className="fixed inset-0 z-50 flex justify-end bg-[var(--bg-scrim)]"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-4xl h-full glass-drawer border-l border-[var(--glass-border)] flex flex-col"
          >
            <div className="px-6 py-4 border-b border-[var(--border-subtle)] flex flex-wrap items-center justify-between gap-4">
              <div>
                <h2 className="text-base font-semibold text-[var(--text-primary)]">
                  Burrow Settings
                </h2>
                <p className="text-xs text-[var(--text-secondary)]">
                  Offline Windows preferences, saved presets, and protected folders
                </p>
              </div>

              <div className="flex items-center gap-3">
                <div className="inline-flex items-center p-1 rounded-full glass-panel">
                  <button
                    onClick={() => setSettingsTab('presets')}
                    className={`px-3 py-1 text-xs font-medium rounded-full transition-colors whitespace-nowrap ${
                      settingsTab === 'presets'
                        ? 'bg-[var(--pill-active-bg)] text-[var(--pill-active-text)]'
                        : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                    }`}
                  >
                    Presets & Protection
                  </button>
                  <button
                    onClick={() => setSettingsTab('appearance')}
                    className={`px-3 py-1 text-xs font-medium rounded-full transition-colors whitespace-nowrap ${
                      settingsTab === 'appearance'
                        ? 'bg-[var(--pill-active-bg)] text-[var(--pill-active-text)]'
                        : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                    }`}
                  >
                    Appearance & Behavior
                  </button>
                </div>

                <button
                  onClick={() => setSettingsOpen(false)}
                  aria-label="Close Settings"
                  className="p-2 rounded-full text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-surface-hover)] transition-colors"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-6">
              {settingsTab === 'presets' ? (
                <ProfilesView
                  os={WINDOWS_OS}
                  profiles={persisted.profiles}
                  whitelist={persisted.whitelist}
                  history={persisted.history}
                  onLoadProfile={handleLoadProfile}
                  onSaveCurrentProfile={handleSaveProfile}
                  onDeleteProfile={handleDeleteProfile}
                  onAddWhitelist={handleAddWhitelist}
                  onDeleteWhitelist={handleDeleteWhitelist}
                />
              ) : (
                <div className="space-y-5 max-w-2xl">
                  {/* Glass Theme Card */}
                  <div className="rounded-2xl glass-panel p-5 flex items-center justify-between gap-4">
                    <div className="space-y-1">
                      <div className="text-sm font-semibold text-[var(--text-primary)]">
                        Glass appearance
                      </div>
                      <p className="text-xs text-[var(--text-secondary)]">
                        Switch between dark Dusk Liquid Glass and bright Light Frost Glass
                      </p>
                    </div>
                    <button
                      onClick={() => setDarkMode(!darkMode)}
                      className="inline-flex items-center gap-2 px-4 py-2 text-xs font-medium rounded-full glass-panel glass-panel-hover text-[var(--text-primary)] whitespace-nowrap"
                    >
                      {darkMode ? <Sun className="w-3.5 h-3.5" /> : <Moon className="w-3.5 h-3.5" />}
                      {darkMode ? 'Dark Dusk' : 'Light Frost'}
                    </button>
                  </div>

                  {/* Safety & Live Polling Controls */}
                  <div className="rounded-2xl glass-panel divide-y divide-[var(--border-subtle)]">
                    <div className="p-5 flex items-center justify-between gap-4">
                      <div className="space-y-1">
                        <div className="text-sm font-semibold text-[var(--text-primary)]">
                          Default dry-run safety
                        </div>
                        <p className="text-xs text-[var(--text-secondary)]">
                          Keep safety confirmation active for saved presets
                        </p>
                      </div>
                      <button
                        onClick={() => setDryRunDefault(!dryRunDefault)}
                        role="switch"
                        aria-checked={dryRunDefault}
                        className="inline-flex items-center gap-2 px-4 py-1.5 text-xs font-medium rounded-full glass-panel glass-panel-hover text-[var(--text-primary)]"
                      >
                        <ShieldCheck className="w-3.5 h-3.5 text-[var(--status-safe)]" />
                        {dryRunDefault ? 'Safety on' : 'Direct apply'}
                      </button>
                    </div>

                    <div className="p-5 flex items-center justify-between gap-4">
                      <div className="space-y-1">
                        <div className="text-sm font-semibold text-[var(--text-primary)]">
                          Live hardware polling
                        </div>
                        <p className="text-xs text-[var(--text-secondary)]">
                          Refresh CPU, memory, disk, and process metrics every 2 seconds locally
                        </p>
                      </div>
                      <button
                        onClick={() => setPolling(!polling)}
                        className="inline-flex items-center gap-2 px-4 py-1.5 text-xs font-medium rounded-full glass-panel glass-panel-hover text-[var(--text-primary)]"
                      >
                        {polling ? (
                          <Pause className="w-3.5 h-3.5 text-[var(--status-safe)]" />
                        ) : (
                          <Play className="w-3.5 h-3.5 text-[var(--text-muted)]" />
                        )}
                        {polling ? 'Polling active' : 'Paused'}
                      </button>
                    </div>
                  </div>

                  {/* Staged Cleanup Runner */}
                  <div className="rounded-2xl glass-panel p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                    <div className="space-y-1">
                      <div className="text-sm font-semibold text-[var(--text-primary)]">
                        Queued Windows actions
                      </div>
                      <p className="text-xs text-[var(--text-secondary)] tabular-nums">
                        {totalSelectedReclaimable > 0
                          ? `${formatBytes(totalSelectedReclaimable, 1)} ready to clean across selected categories`
                          : 'Review any selected cleanups, app updates, or tune-ups'}
                      </p>
                    </div>
                    <button
                      onClick={() => {
                        setSettingsOpen(false);
                        openActionRunner();
                      }}
                      className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold rounded-full bg-[var(--pill-active-bg)] text-[var(--pill-active-text)] hover:opacity-90 transition-opacity whitespace-nowrap shrink-0"
                    >
                      <Sparkles className="w-3.5 h-3.5" />
                      Review & run
                    </button>
                  </div>

                  {/* Offline Runtime & Windows Download */}
                  <div className="rounded-2xl glass-panel p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4 text-xs text-[var(--text-secondary)]">
                    <div className="space-y-1 min-w-0">
                      <div className="text-sm font-semibold text-[var(--text-primary)]">
                        Local Windows desktop app
                      </div>
                      <p>
                        {runningInTauri
                          ? 'Running inside the native Rust Tauri desktop window. All scans, cleanups, app updates, and live hardware telemetry run directly on your Windows PC without internet.'
                          : 'Download the Windows bundle (.zip) containing the offline app, native Rust/Tauri desktop project, and one-click Windows launchers.'}
                      </p>
                    </div>
                    {!runningInTauri && (
                      <a
                        href="/api/download/burrow-windows.zip"
                        download="Burrow-Windows.zip"
                        className="inline-flex items-center justify-center gap-2 px-4 py-2 text-xs font-semibold rounded-full bg-[var(--pill-active-bg)] text-[var(--pill-active-text)] hover:opacity-90 transition-opacity whitespace-nowrap shrink-0"
                      >
                        <Download className="w-3.5 h-3.5" />
                        Download (.zip)
                      </a>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* One-Click Windows GUI Action Confirmation & Execution Sheet */}
      {leftoverReview && (
        <LeftoversDialog
          key={leftoverReview.query.appId + (leftoverReview.busy && leftoverReview.items.length === 0 ? '-loading' : '')}
          appName={leftoverReview.query.name}
          forced={leftoverReview.query.force}
          items={leftoverReview.items}
          busy={leftoverReview.busy}
          searching={leftoverReview.busy && leftoverReview.items.length === 0 && !leftoverReview.results}
          results={leftoverReview.results}
          onDelete={handleDeleteLeftovers}
          onClose={() => {
            setLeftoverReview(null);
            refreshNativeWindowsTargets();
          }}
        />
      )}

      <DryRunDrawer
        open={drawerOpen}
        dryRun={dryRunDefault}
        executing={executingActions}
        cleanTargets={stagedCleanTargets}
        purgeProjects={stagedPurgeProjects}
        uninstallApps={stagedUninstallApps}
        upgradeApps={stagedUpgradeApps}
        optimizeTasks={stagedOptimizeTasks}
        startupChanges={stagedStartupChanges}
        results={actionResults}
        onRunAction={handleExecuteActions}
        onClose={() => {
          setDrawerOpen(false);
          setActionResults(null);
        }}
      />

      {/* Frosted Toast Notification */}
      {toast && (
        <div className="fixed bottom-5 right-5 z-50 px-4 py-2.5 rounded-full glass-pill text-[var(--text-primary)] text-xs font-medium">
          {toast}
        </div>
      )}
    </div>
  );
}
