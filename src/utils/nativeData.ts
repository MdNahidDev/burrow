import { WINDOWS_CLEAN_TARGETS } from '../data/osProfiles';
import type {
  AppLeftover,
  CleanTarget,
  DiskNode,
  InstalledApp,
  PurgeProject,
  StartupItem,
} from '../types/burrow';
import type {
  CleanScanResult,
  NativeApp,
  NativeDiskNode,
  NativeDownload,
  NativePurge,
  NativeStartup,
  NativeUpdate,
} from './tauriBridge';
import { inferCategory } from './localFolderScanner';

/** Known cache/temp locations Burrow can clean. Sizes start at zero until a real scan fills them in. */
export function knownCleanTargets(): CleanTarget[] {
  return WINDOWS_CLEAN_TARGETS.filter(
    (t) => t.kind === 'cache' && t.id !== 'win-wsl-docker',
  ).map((t) => ({ ...t, sizeBytes: 0, itemCount: 0, lastModifiedDays: 0 }));
}

export function applyScanResults(base: CleanTarget[], results: CleanScanResult[]): CleanTarget[] {
  const byId = new Map(results.map((r) => [r.id, r]));
  return base.map((t) => {
    const hit = byId.get(t.id);
    return hit ? { ...t, path: hit.path, sizeBytes: hit.sizeBytes, itemCount: hit.itemCount } : t;
  });
}

function stableId(prefix: string, value: string): string {
  let h = 5381;
  for (let i = 0; i < value.length; i++) h = ((h << 5) + h + value.charCodeAt(i)) | 0;
  return `${prefix}-${(h >>> 0).toString(36)}`;
}

export function downloadToTarget(d: NativeDownload): CleanTarget {
  return {
    id: stableId('dl', d.path),
    kind: 'installer',
    category: 'Old installers & downloads',
    title: d.name,
    path: d.path,
    os: 'windows',
    sizeBytes: d.sizeBytes,
    itemCount: 1,
    safety: 'moderate',
    requiresAdmin: false,
    description: 'Large file in your Downloads folder. Check that you no longer need it before removing it.',
    commandPreview: '',
    lastModifiedDays: d.modifiedDaysAgo,
  };
}

const ARTIFACT_TYPES = ['node_modules', 'target', 'dist', '.next', 'Pods', 'bin/obj', '.venv', '__pycache__'];

export function purgeFromNative(list: NativePurge[]): PurgeProject[] {
  return list.map((p) => ({
    id: stableId('pg', p.path),
    projectName: p.projectName,
    artifactType: (ARTIFACT_TYPES.includes(p.artifactType)
      ? p.artifactType
      : 'dist') as PurgeProject['artifactType'],
    framework: p.framework,
    path: p.path,
    os: 'windows',
    sizeBytes: p.sizeBytes,
    staleDays: p.staleDays,
    fileCount: p.fileCount,
  }));
}

// Keeps digits that are part of a product name ("7-Zip", "Visual C++ 2015-2022") and
// drops only things that look like a version number ("23.01", "14.38.33135").
function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\bv?\d+(\.\d+)+\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Pair each available update with the one installed program it really belongs to. */
function matchUpdates(apps: NativeApp[], updates: NativeUpdate[]): Map<string, NativeUpdate> {
  const matched = new Map<string, NativeUpdate>();
  for (const u of updates) {
    const key = normalizeName(u.name);
    const same = apps.filter((a) => normalizeName(a.name) === key);
    // Several installed entries share this name (editions, 32/64-bit): only trust an exact version match.
    const pick = same.length === 1 ? same[0] : same.filter((a) => a.version === u.version)[0];
    if (pick && !matched.has(pick.id)) matched.set(pick.id, u);
  }
  return matched;
}

export function appsFromNative(apps: NativeApp[], updates: NativeUpdate[]): InstalledApp[] {
  const matched = matchUpdates(apps, updates);
  const claimed = new Set([...matched.values()].map((u) => u.id));
  const remaining = new Map(updates.filter((u) => !claimed.has(u.id)).map((u) => [u.id, u]));

  const out: InstalledApp[] = apps.map((a) => {
    const upd = matched.get(a.id);
    return {
      id: a.id,
      name: a.name,
      bundleId: upd?.id ?? a.id,
      version: a.version || '—',
      latestVersion: upd?.available ?? (a.version || '—'),
      publisher: a.publisher || 'Unknown publisher',
      os: 'windows',
      binarySizeBytes: a.binarySizeBytes,
      lastUsedDays: a.installedDaysAgo,
      updateSource: upd ? 'winget' : 'none',
      leftovers: a.leftovers.map(
        (l): AppLeftover => ({
          id: l.id,
          path: l.path,
          kind: l.kind as AppLeftover['kind'],
          sizeBytes: l.sizeBytes,
          requiresAdmin: l.requiresAdmin,
        }),
      ),
    };
  });

  // Updates for things that are not in the classic program list (Store apps etc.)
  for (const u of remaining.values()) {
    out.push({
      id: `winget:${u.id}`,
      name: u.name,
      bundleId: u.id,
      version: u.version,
      latestVersion: u.available,
      publisher: u.id.split('.')[0] ?? 'Unknown publisher',
      os: 'windows',
      binarySizeBytes: 0,
      lastUsedDays: -1,
      updateSource: 'winget',
      leftovers: [],
    });
  }
  return out;
}

export function startupFromNative(list: NativeStartup[]): StartupItem[] {
  const hive: Record<string, string> = {
    HKCU: 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run',
    HKLM: 'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Run',
    HKLM32: 'HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Run',
  };
  return list.map((s) => ({
    id: `${s.scope}:${s.name}`,
    name: s.name,
    publisher: s.publisher || 'Unknown publisher',
    mechanism: 'RegistryRun',
    path: `${hive[s.scope] ?? s.scope}\\${s.name}`,
    os: 'windows',
    impact: s.scope === 'HKCU' ? 'medium' : 'low',
    enabled: s.enabled,
    requiresAdmin: s.scope !== 'HKCU',
  }));
}

export function diskNodeFromNative(n: NativeDiskNode): DiskNode {
  return {
    id: n.id,
    name: n.name,
    path: n.path,
    sizeBytes: n.sizeBytes,
    kind: n.kind,
    category: inferCategory(n.name, n.kind === 'directory'),
    modifiedDaysAgo: n.modifiedDaysAgo,
    hashGroup: n.hashGroup,
    children: n.children?.map(diskNodeFromNative),
  };
}
