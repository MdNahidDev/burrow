import { Copy, FolderOpen, Loader2, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { formatBytes, formatRelativeDays } from '../utils/format';
import {
  deleteDuplicatesTauri,
  findDuplicatesTauri,
  revealInExplorerTauri,
  type DupResult,
} from '../utils/tauriBridge';

interface DuplicatesPanelProps {
  rootPath: string;
  rootName: string;
  onNotify: (msg: string) => void;
  /** Called with the paths that were really deleted, so the map can update. */
  onDeleted: (paths: string[]) => void;
}

export function DuplicatesPanel({ rootPath, rootName, onNotify, onDeleted }: DuplicatesPanelProps) {
  const [scanning, setScanning] = useState(false);
  const [result, setResult] = useState<DupResult | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [permanent, setPermanent] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const scan = async () => {
    setScanning(true);
    setResult(null);
    setSelected(new Set());
    try {
      const res = await findDuplicatesTauri(rootPath);
      setResult(res);
      if (res.groups.length === 0) onNotify('No duplicate files found in this folder.');
    } catch (err) {
      onNotify(typeof err === 'string' ? err : 'Could not search for duplicates.');
    } finally {
      setScanning(false);
    }
  };

  const groups = result?.groups ?? [];
  const sizeByPath = useMemo(() => {
    const m = new Map<string, number>();
    for (const g of groups) for (const f of g.files) m.set(f.path, g.sizeBytes);
    return m;
  }, [groups]);

  const selectedBytes = [...selected].reduce((s, p) => s + (sizeByPath.get(p) ?? 0), 0);
  const totalWasted = groups.reduce((s, g) => s + g.wastedBytes, 0);

  // Always keep at least one copy of every file.
  const toggle = (groupIdx: number, path: string) => {
    const g = groups[groupIdx];
    const next = new Set(selected);
    if (next.has(path)) {
      next.delete(path);
    } else {
      const wouldTickAll = g.files.every((f) => f.path === path || next.has(f.path));
      if (wouldTickAll) {
        onNotify('Keep at least one copy of each file.');
        return;
      }
      next.add(path);
    }
    setSelected(next);
  };

  // Keep the oldest copy of every file, tick the rest.
  const selectExtras = () => {
    const next = new Set<string>();
    for (const g of groups) g.files.slice(1).forEach((f) => next.add(f.path));
    setSelected(next);
  };

  const doDelete = async () => {
    setDeleting(true);
    try {
      const items = groups
        .map((g) => {
          const del = g.files.filter((f) => selected.has(f.path)).map((f) => f.path);
          const keep = g.files.find((f) => !selected.has(f.path))?.path;
          return keep && del.length > 0 ? { keep, delete: del } : null;
        })
        .filter((x): x is { keep: string; delete: string[] } => x !== null);

      const res = await deleteDuplicatesTauri(items, permanent);
      const done = res.filter((r) => r.ok).map((r) => r.path);
      const failed = res.length - done.length;
      const doneSet = new Set(done);
      setResult((prev) =>
        prev
          ? {
              ...prev,
              groups: prev.groups
                .map((g) => {
                  const files = g.files.filter((f) => !doneSet.has(f.path));
                  return { ...g, files, wastedBytes: g.sizeBytes * Math.max(0, files.length - 1) };
                })
                .filter((g) => g.files.length > 1),
            }
          : prev,
      );
      setSelected(new Set());
      onDeleted(done);
      onNotify(
        failed === 0
          ? `Removed ${done.length} duplicate${done.length === 1 ? '' : 's'}.`
          : `Removed ${done.length}. ${failed} could not be removed (${res.find((r) => !r.ok)?.message ?? 'see details'}).`,
      );
    } catch (err) {
      onNotify(typeof err === 'string' ? err : 'Could not remove the duplicates.');
    } finally {
      setDeleting(false);
      setConfirming(false);
    }
  };

  return (
    <div className="rounded-2xl glass-panel overflow-hidden">
      <div className="px-5 py-4 flex flex-wrap items-center justify-between gap-3 border-b border-[var(--border-subtle)]">
        <div className="text-xs text-[var(--text-secondary)]">
          {result
            ? `${groups.length} sets of identical files · ${formatBytes(totalWasted)} can be freed${result.truncated ? ' (search stopped early)' : ''}`
            : `Find files in ${rootName} that are exactly the same, compared by content, not by name.`}
        </div>
        <div className="flex items-center gap-2">
          {groups.length > 0 && (
            <>
              <button
                onClick={selectExtras}
                className="px-3.5 py-1.5 text-xs font-medium rounded-full glass-panel glass-panel-hover text-[var(--text-primary)]"
              >
                Select extra copies
              </button>
              <button
                onClick={() => setSelected(new Set())}
                className="px-3.5 py-1.5 text-xs font-medium rounded-full glass-panel glass-panel-hover text-[var(--text-secondary)]"
              >
                Clear
              </button>
            </>
          )}
          <button
            onClick={scan}
            disabled={scanning}
            className="inline-flex items-center gap-1.5 px-4 py-1.5 text-xs font-semibold rounded-full bg-[var(--pill-active-bg)] text-[var(--pill-active-text)] disabled:opacity-60"
          >
            {scanning && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            {scanning ? 'Searching…' : result ? 'Search again' : 'Find duplicates'}
          </button>
        </div>
      </div>

      <div className="divide-y divide-[var(--border-subtle)]">
        {groups.map((group, gi) => (
          <div key={group.hash} className="p-5 space-y-2.5">
            <div className="flex items-center justify-between gap-4">
              <div className="flex items-center gap-2.5 text-xs font-medium text-[var(--text-primary)] min-w-0">
                <Copy className="w-3.5 h-3.5 shrink-0 text-[var(--status-warn)]" />
                <span className="truncate">{group.files[0].name}</span>
                <span className="text-[var(--text-muted)] whitespace-nowrap">
                  {group.files.length} copies · {formatBytes(group.sizeBytes)} each
                </span>
              </div>
              <span className="text-xs tabular-nums font-semibold text-[var(--status-warn)] whitespace-nowrap">
                {formatBytes(group.wastedBytes)} extra
              </span>
            </div>
            <div className="space-y-0.5">
              {group.files.map((f) => {
                const ticked = selected.has(f.path);
                return (
                  <label
                    key={f.path}
                    className={`flex items-center gap-3 px-2 py-1.5 rounded-lg cursor-pointer hover:bg-[var(--bg-surface-hover)] ${
                      ticked ? 'bg-[var(--status-danger-tint,transparent)]' : ''
                    }`}
                  >
                    <input type="checkbox" checked={ticked} onChange={() => toggle(gi, f.path)} />
                    <span className="min-w-0 flex-1">
                      <span className="block text-xs font-mono text-[var(--text-primary)] truncate">{f.path}</span>
                      <span className="text-[11px] text-[var(--text-muted)]">
                        Modified {formatRelativeDays(f.modifiedDaysAgo)} · {ticked ? 'will be removed' : 'kept'}
                      </span>
                    </span>
                    <button
                      type="button"
                      title="Show in File Explorer"
                      onClick={(e) => {
                        e.preventDefault();
                        revealInExplorerTauri(f.path).catch(() => onNotify('Could not open File Explorer.'));
                      }}
                      className="p-1.5 rounded-full text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-surface-hover)]"
                    >
                      <FolderOpen className="w-3.5 h-3.5" />
                    </button>
                  </label>
                );
              })}
            </div>
          </div>
        ))}
        {result && groups.length === 0 && (
          <div className="py-10 text-center text-xs text-[var(--text-muted)]">No duplicate files found. Nice and tidy.</div>
        )}
        {!result && !scanning && (
          <div className="py-10 text-center text-xs text-[var(--text-muted)]">
            Only files of 1 MB or more are checked. System folders and AppData are skipped.
          </div>
        )}
      </div>

      {selected.size > 0 && (
        <div className="sticky bottom-0 px-5 py-3.5 border-t border-[var(--border-subtle)] bg-[var(--bg-surface)] flex flex-wrap items-center justify-between gap-3">
          <div className="text-xs text-[var(--text-secondary)] tabular-nums">
            {selected.size} file{selected.size === 1 ? '' : 's'} selected · frees {formatBytes(selectedBytes)}
          </div>
          <div className="flex items-center gap-4">
            <label className="inline-flex items-center gap-2 text-xs text-[var(--text-secondary)] cursor-pointer">
              <input type="checkbox" checked={permanent} onChange={(e) => setPermanent(e.target.checked)} />
              Delete permanently
            </label>
            <button
              onClick={() => setConfirming(true)}
              disabled={deleting}
              className="inline-flex items-center gap-1.5 px-5 py-2 text-xs font-semibold rounded-full bg-[var(--pill-active-bg)] text-[var(--pill-active-text)] disabled:opacity-60"
            >
              <Trash2 className="w-3.5 h-3.5" />
              {permanent ? 'Delete selected' : 'Move to Recycle Bin'}
            </button>
          </div>
        </div>
      )}

      {confirming && (
        <div className="fixed inset-0 z-[75] flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-md rounded-2xl glass-panel border border-[var(--border-subtle)] p-6 space-y-4">
            <h3 className="text-base font-semibold text-[var(--text-primary)]">
              {permanent ? 'Permanently delete' : 'Move to Recycle Bin'} {selected.size} file{selected.size === 1 ? '' : 's'}?
            </h3>
            <p className="text-xs text-[var(--text-secondary)]">
              {permanent
                ? 'These copies are removed for good and cannot be restored. One copy of each file is always kept, and Burrow checks again that every file is still identical before deleting.'
                : 'You can restore them from the Recycle Bin. One copy of each file is always kept, and Burrow checks again that every file is still identical before removing it.'}
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setConfirming(false)}
                disabled={deleting}
                className="px-4 py-2 text-xs font-medium rounded-full glass-panel glass-panel-hover text-[var(--text-primary)]"
              >
                Cancel
              </button>
              <button
                onClick={doDelete}
                disabled={deleting}
                className="inline-flex items-center gap-2 px-5 py-2 text-xs font-semibold rounded-full bg-[var(--pill-active-bg)] text-[var(--pill-active-text)] disabled:opacity-60"
              >
                {deleting && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                {deleting ? 'Removing…' : permanent ? 'Delete' : 'Move to Recycle Bin'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
