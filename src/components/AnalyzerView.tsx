import { ChevronRight, Copy, FolderOpen, FolderTree, RefreshCw, RotateCcw } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { DiskNode, OsTarget } from '../types/burrow';
import { formatBytes, formatRelativeDays } from '../utils/format';
import { scanLocalDirectoryPicker } from '../utils/localFolderScanner';
import { diskNodeFromNative } from '../utils/nativeData';
import { analyzePathTauri, pickFolderTauri } from '../utils/tauriBridge';
import { computeSquarifiedTreemap } from '../utils/treemap';
import { PlanetOrb } from './PlanetOrb';

interface AnalyzerViewProps {
  os: OsTarget;
  native?: boolean;
  diskTree: DiskNode;
  mapped: boolean;
  onSetMapped: (mapped: boolean) => void;
  onRefreshHostScan: () => void;
  onNotify: (msg: string) => void;
}

type AnalyzerTab = 'treemap' | 'large' | 'duplicates';

const CATEGORY_FILL_VAR: Record<string, string> = {
  dev: 'var(--cat-dev)',
  system: 'var(--cat-system)',
  app: 'var(--cat-app)',
  media: 'var(--cat-media)',
  archive: 'var(--cat-archive)',
  other: 'var(--cat-other)',
};

function flattenFiles(node: DiskNode, out: DiskNode[] = []): DiskNode[] {
  if (node.kind === 'file') {
    out.push(node);
    return out;
  }
  for (const child of node.children ?? []) {
    flattenFiles(child, out);
  }
  return out;
}

export function AnalyzerView({
  os,
  native = false,
  diskTree,
  mapped,
  onSetMapped,
  onRefreshHostScan,
  onNotify,
}: AnalyzerViewProps) {
  const [tab, setTab] = useState<AnalyzerTab>('treemap');
  const [localOverrideTree, setLocalOverrideTree] = useState<DiskNode | null>(null);
  const [localScanMeta, setLocalScanMeta] = useState<string | null>(null);
  const [scanningLocal, setScanningLocal] = useState(false);
  const [pathStack, setPathStack] = useState<string[]>([]);
  const [hoveredNode, setHoveredNode] = useState<{ node: DiskNode; pct: number } | null>(null);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const [boxSize, setBoxSize] = useState({ width: 880, height: 380 });

  const activeRoot = localOverrideTree ?? diskTree;

  useEffect(() => {
    setPathStack([]);
    setHoveredNode(null);
  }, [activeRoot.id]);

  useEffect(() => {
    setLocalOverrideTree(null);
    setLocalScanMeta(null);
  }, [os]);

  useEffect(() => {
    if (!mapped || tab !== 'treemap') return;
    const el = containerRef.current;
    if (!el) return;
    const initialW = Math.max(320, Math.floor(el.clientWidth));
    if (initialW > 0) {
      setBoxSize({ width: initialW, height: 390 });
    }
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const w = Math.max(320, Math.floor(entry.contentRect.width));
        setBoxSize({ width: w, height: 390 });
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [mapped, tab]);

  const { currentNode, breadcrumbs } = useMemo(() => {
    let curr = activeRoot;
    const crumbs: DiskNode[] = [activeRoot];
    for (const id of pathStack) {
      const next = curr.children?.find((c) => c.id === id);
      if (!next) break;
      curr = next;
      crumbs.push(next);
    }
    return { currentNode: curr, breadcrumbs: crumbs };
  }, [activeRoot, pathStack]);

  const treemapRects = useMemo(() => {
    const children = currentNode.children ?? [];
    return computeSquarifiedTreemap(children, boxSize.width, boxSize.height);
  }, [currentNode, boxSize]);

  const allFiles = useMemo(() => flattenFiles(activeRoot), [activeRoot]);

  const largeFiles = useMemo(
    () =>
      allFiles
        .filter((f) => f.sizeBytes >= 1024 * 1024)
        .slice()
        .sort((a, b) => b.sizeBytes - a.sizeBytes)
        .slice(0, 30),
    [allFiles],
  );

  const duplicateGroups = useMemo(() => {
    const groups = new Map<string, DiskNode[]>();
    for (const file of allFiles) {
      if (!file.hashGroup) continue;
      const list = groups.get(file.hashGroup) ?? [];
      list.push(file);
      groups.set(file.hashGroup, list);
    }
    return Array.from(groups.entries())
      .filter(([, files]) => files.length > 1)
      .map(([key, files]) => ({
        key,
        files,
        wastedBytes: files.slice(1).reduce((s, f) => s + f.sizeBytes, 0),
      }))
      .sort((a, b) => b.wastedBytes - a.wastedBytes);
  }, [allFiles]);

  // Map a real folder on this PC with the native engine ('' = your user folder).
  const runNativeScan = async (choose: boolean) => {
    setScanningLocal(true);
    try {
      let target = '';
      if (choose) {
        const picked = await pickFolderTauri();
        if (!picked) return;
        target = picked;
      }
      onNotify('Mapping your folder… large drives can take a minute.');
      const result = await analyzePathTauri(target);
      const root = diskNodeFromNative(result.root);
      setLocalOverrideTree(root);
      setLocalScanMeta(
        `${root.path} — ${result.scannedFiles.toLocaleString()} files, ${result.scannedDirs.toLocaleString()} folders${result.truncated ? ' (stopped early after 90 seconds; sizes are partial)' : ''}`,
      );
      setPathStack([]);
      onSetMapped(true);
      onNotify(`Mapped "${root.name}" (${formatBytes(root.sizeBytes)})`);
    } catch (error) {
      onNotify(typeof error === 'string' ? error : error instanceof Error ? error.message : 'Unable to scan that folder.');
    } finally {
      setScanningLocal(false);
    }
  };

  const handleLocalScan = async () => {
    if (native) {
      await runNativeScan(true);
      return;
    }
    setScanningLocal(true);
    try {
      const result = await scanLocalDirectoryPicker();
      if (!result) return;
      setLocalOverrideTree(result.root);
      setLocalScanMeta(
        `Folder ${result.root.name} (${result.scannedFiles} files, ${result.scannedDirs} folders${result.truncated ? ', capped at 4,000 entries' : ''})`,
      );
      onSetMapped(true);
      onNotify(`Mapped folder "${result.root.name}" (${formatBytes(result.root.sizeBytes)})`);
    } catch (error) {
      onNotify(error instanceof Error ? error.message : 'Unable to scan local folder.');
    } finally {
      setScanningLocal(false);
    }
  };

  // Hero Orb Stage matching Screenshot 4
  // In the installed app never fall back to the demo disk: map a real folder first.
  if (!mapped || (native && !localOverrideTree)) {
    return (
      <div className="min-h-[calc(100vh-148px)] flex flex-col items-center justify-center text-center px-4">
        <div className="mb-8">
          <PlanetOrb kind="jupiter" size={198} />
        </div>

        <p className="font-serif-verse text-[17px] leading-[1.65] text-[var(--text-primary)] max-w-md">
          The widest eye of all.
          <br />
          No grain too small to find.
        </p>

        <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
          <button
            onClick={handleLocalScan}
            disabled={scanningLocal}
            className="px-7 py-3 rounded-full glass-panel glass-panel-hover text-sm font-medium text-[var(--text-primary)] disabled:opacity-50"
          >
            {scanningLocal ? 'Scanning folder...' : 'Choose a drive'}
          </button>
          <button
            onClick={() => (native ? runNativeScan(false) : onSetMapped(true))}
            disabled={scanningLocal}
            className="px-8 py-3 rounded-full bg-[var(--pill-active-bg)] text-[var(--pill-active-text)] text-sm font-semibold shadow-[var(--glass-shadow)] hover:opacity-90 transition-opacity disabled:opacity-50"
          >
            {native && scanningLocal ? 'Mapping…' : native ? 'Map my user folder' : 'Map your disk'}
          </button>
        </div>

        {!native && (
          <p className="mt-5 text-xs text-[var(--text-muted)] tabular-nums">
            Ready to inspect {activeRoot.name} ({formatBytes(activeRoot.sizeBytes)})
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* Top Bar */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex items-center p-1 rounded-full glass-panel">
            <button
              onClick={() => setTab('treemap')}
              className={`px-3.5 py-1.5 text-xs font-medium rounded-full transition-colors whitespace-nowrap ${
                tab === 'treemap'
                  ? 'bg-[var(--pill-active-bg)] text-[var(--pill-active-text)]'
                  : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
              }`}
            >
              Visual map
            </button>
            <button
              onClick={() => setTab('large')}
              className={`px-3.5 py-1.5 text-xs font-medium rounded-full transition-colors whitespace-nowrap ${
                tab === 'large'
                  ? 'bg-[var(--pill-active-bg)] text-[var(--pill-active-text)]'
                  : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
              }`}
            >
              Largest files ({largeFiles.length})
            </button>
            <button
              onClick={() => setTab('duplicates')}
              className={`px-3.5 py-1.5 text-xs font-medium rounded-full transition-colors whitespace-nowrap ${
                tab === 'duplicates'
                  ? 'bg-[var(--pill-active-bg)] text-[var(--pill-active-text)]'
                  : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
              }`}
            >
              Duplicates ({duplicateGroups.length})
            </button>
          </div>

          <button
            onClick={() => onSetMapped(false)}
            aria-label="Return to orb view"
            title="Return to orb view"
            className="p-2 rounded-full glass-panel glass-panel-hover text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
          >
            <RotateCcw className="w-3.5 h-3.5" />
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {localOverrideTree && (
            <button
              onClick={() => {
                setLocalOverrideTree(null);
                setLocalScanMeta(null);
              }}
              className="px-3.5 py-1.5 text-xs font-medium rounded-full glass-panel glass-panel-hover text-[var(--text-primary)]"
            >
              Reset drive
            </button>
          )}
          {os === 'host' && (
            <button
              onClick={onRefreshHostScan}
              className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-medium rounded-full glass-panel glass-panel-hover text-[var(--text-primary)]"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              Rescan host
            </button>
          )}
          <button
            onClick={handleLocalScan}
            disabled={scanningLocal}
            className="inline-flex items-center gap-1.5 px-4 py-1.5 text-xs font-semibold rounded-full bg-[var(--pill-active-bg)] text-[var(--pill-active-text)] hover:opacity-90 disabled:opacity-50 transition-opacity"
          >
            <FolderOpen className="w-3.5 h-3.5" />
            {scanningLocal ? 'Scanning...' : 'Choose a drive'}
          </button>
        </div>
      </div>

      {localScanMeta && (
        <div className="px-4 py-2.5 rounded-xl border border-[var(--status-safe)] bg-[var(--status-safe-tint)] text-xs text-[var(--status-safe)]">
          {localScanMeta}
        </div>
      )}

      {tab === 'treemap' && (
        <div className="rounded-2xl glass-panel overflow-hidden">
          <div className="px-4 py-3 border-b border-[var(--border-subtle)] flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-1 text-xs">
              <FolderTree className="w-3.5 h-3.5 text-[var(--status-warn)] mr-1" />
              {breadcrumbs.map((crumb, idx) => (
                <div key={crumb.id} className="inline-flex items-center gap-1">
                  {idx > 0 && <ChevronRight className="w-3 h-3 text-[var(--text-muted)]" />}
                  <button
                    onClick={() => setPathStack(pathStack.slice(0, idx))}
                    className={`px-2 py-0.5 rounded-md hover:bg-[var(--bg-surface-hover)] transition-colors ${
                      idx === breadcrumbs.length - 1
                        ? 'text-[var(--text-primary)] font-semibold'
                        : 'text-[var(--text-muted)]'
                    }`}
                  >
                    {crumb.name}
                  </button>
                </div>
              ))}
            </div>

            <div className="text-xs tabular-nums text-[var(--text-secondary)]">
              {hoveredNode
                ? `${hoveredNode.node.name} — ${formatBytes(hoveredNode.node.sizeBytes)} (${hoveredNode.pct.toFixed(1)}%)`
                : `Folder total ${formatBytes(currentNode.sizeBytes)}`}
            </div>
          </div>

          <div ref={containerRef} className="p-3 bg-[var(--bg-inset)]">
            {treemapRects.length > 0 ? (
              <svg
                width={boxSize.width}
                height={boxSize.height}
                className="block w-full rounded-xl overflow-hidden select-none"
              >
                {treemapRects.map((rect) => {
                  const canDrill = rect.node.kind === 'directory' && (rect.node.children?.length ?? 0) > 0;
                  const fill = CATEGORY_FILL_VAR[rect.node.category ?? 'other'] ?? 'var(--cat-other)';
                  const showLabel = rect.width > 74 && rect.height > 40;
                  const showSize = rect.width > 64 && rect.height > 56;

                  return (
                    <g
                      key={rect.node.id}
                      onClick={() => {
                        if (canDrill) {
                          setPathStack([...pathStack, rect.node.id]);
                        }
                      }}
                      onMouseEnter={() => setHoveredNode({ node: rect.node, pct: rect.pct })}
                      onMouseLeave={() => setHoveredNode(null)}
                      className={canDrill ? 'cursor-pointer' : 'cursor-default'}
                    >
                      <rect
                        x={rect.x + 1.5}
                        y={rect.y + 1.5}
                        width={Math.max(0, rect.width - 3)}
                        height={Math.max(0, rect.height - 3)}
                        rx={6}
                        fill={fill}
                        fillOpacity={hoveredNode?.node.id === rect.node.id ? 0.98 : 0.84}
                        stroke="var(--treemap-stroke)"
                        strokeWidth={1}
                      />
                      {showLabel && (
                        <text
                          x={rect.x + 10}
                          y={rect.y + 22}
                          fill="var(--text-treemap)"
                          fontSize={12}
                          fontWeight={600}
                        >
                          {rect.node.name.length > Math.floor(rect.width / 8)
                            ? `${rect.node.name.slice(0, Math.max(4, Math.floor(rect.width / 8) - 1))}…`
                            : rect.node.name}
                        </text>
                      )}
                      {showSize && (
                        <text
                          x={rect.x + 10}
                          y={rect.y + 40}
                          fill="var(--text-treemap-sub)"
                          fontSize={11}
                        >
                          {formatBytes(rect.node.sizeBytes)} ({rect.pct.toFixed(0)}%)
                        </text>
                      )}
                    </g>
                  );
                })}
              </svg>
            ) : (
              <div className="h-[390px] flex items-center justify-center text-xs text-[var(--text-muted)]">
                {currentNode.path} ({formatBytes(currentNode.sizeBytes)})
              </div>
            )}
          </div>

          {/* Direct Children List */}
          <div className="divide-y divide-[var(--border-subtle)] border-t border-[var(--border-subtle)]">
            {(currentNode.children ?? []).map((child) => {
              const pct = currentNode.sizeBytes > 0 ? (child.sizeBytes / currentNode.sizeBytes) * 100 : 0;
              const canDrill = child.kind === 'directory' && (child.children?.length ?? 0) > 0;

              return (
                <div
                  key={child.id}
                  onClick={() => canDrill && setPathStack([...pathStack, child.id])}
                  className={`px-5 py-2.5 flex items-center justify-between gap-4 text-xs ${
                    canDrill ? 'cursor-pointer hover:bg-[var(--bg-surface-hover)]' : ''
                  }`}
                >
                  <div className="min-w-0 flex items-center gap-3">
                    <span
                      className="w-2.5 h-2.5 rounded-xs shrink-0"
                      style={{ backgroundColor: CATEGORY_FILL_VAR[child.category ?? 'other'] ?? 'var(--cat-other)' }}
                    />
                    <span className="font-medium text-[var(--text-primary)] truncate">
                      {child.name}
                    </span>
                    <span className="font-mono text-[var(--text-muted)] hidden md:inline truncate">
                      {child.path}
                    </span>
                  </div>
                  <div className="flex items-center gap-4 shrink-0 tabular-nums">
                    <span className="text-[var(--text-muted)] w-14 text-right">
                      {pct.toFixed(1)}%
                    </span>
                    <span className="text-[var(--text-primary)] font-semibold w-20 text-right">
                      {formatBytes(child.sizeBytes)}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {tab === 'large' && (
        <div className="rounded-2xl glass-panel overflow-hidden">
          <div className="divide-y divide-[var(--border-subtle)]">
            {largeFiles.map((file) => (
              <div key={file.id} className="px-5 py-3 flex items-center justify-between gap-4 text-xs">
                <div className="min-w-0 space-y-0.5">
                  <div className="font-medium text-[var(--text-primary)] truncate">
                    {file.name}
                  </div>
                  <div className="flex flex-wrap items-center gap-x-3 text-[var(--text-muted)]">
                    <span className="font-mono truncate">{file.path}</span>
                    <span>Modified {formatRelativeDays(file.modifiedDaysAgo)}</span>
                  </div>
                </div>
                <div className="tabular-nums font-semibold text-[var(--text-primary)] shrink-0">
                  {formatBytes(file.sizeBytes)}
                </div>
              </div>
            ))}
            {largeFiles.length === 0 && (
              <div className="py-10 text-center text-xs text-[var(--text-muted)]">
                No files over 1 MB found in this folder.
              </div>
            )}
          </div>
        </div>
      )}

      {tab === 'duplicates' && (
        <div className="rounded-2xl glass-panel overflow-hidden">
          <div className="divide-y divide-[var(--border-subtle)]">
            {duplicateGroups.map((group) => (
              <div key={group.key} className="p-5 space-y-2.5">
                <div className="flex items-center justify-between gap-4">
                  <div className="flex items-center gap-2.5 text-xs font-medium text-[var(--text-primary)]">
                    <Copy className="w-3.5 h-3.5 text-[var(--status-warn)]" />
                    <span>{group.files[0].name}</span>
                    <span className="text-[var(--text-muted)]">
                      {group.files.length} identical copies
                    </span>
                  </div>
                  <span className="text-xs tabular-nums font-semibold text-[var(--status-warn)]">
                    {formatBytes(group.wastedBytes)} extra space
                  </span>
                </div>
                <div className="space-y-1 pl-6">
                  {group.files.map((f, idx) => (
                    <div key={f.id} className="text-xs font-mono text-[var(--text-secondary)] truncate">
                      {idx === 0 ? 'Original: ' : 'Copy: '}
                      {f.path}
                    </div>
                  ))}
                </div>
              </div>
            ))}
            {duplicateGroups.length === 0 && (
              <div className="py-10 text-center text-xs text-[var(--text-muted)]">
                No duplicate large files detected in this folder.
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
