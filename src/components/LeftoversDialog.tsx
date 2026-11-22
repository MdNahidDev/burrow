import { FileText, Folder, KeyRound, Loader2, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { formatBytes } from '../utils/format';
import type { LeftoverItem, LeftoverResult } from '../utils/tauriBridge';

interface LeftoversDialogProps {
  appName: string;
  forced: boolean;
  items: LeftoverItem[];
  busy: boolean;
  results: LeftoverResult[] | null;
  onDelete: (selected: LeftoverItem[]) => void;
  onClose: () => void;
}

export function LeftoversDialog({
  appName,
  forced,
  items,
  busy,
  results,
  onDelete,
  onClose,
}: LeftoversDialogProps) {
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(items.filter((i) => i.risk === 'safe').map((i) => i.path)),
  );

  const selectedItems = useMemo(() => items.filter((i) => selected.has(i.path)), [items, selected]);
  const selectedBytes = selectedItems.reduce((s, i) => s + i.sizeBytes, 0);

  const toggle = (path: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const iconFor = (kind: LeftoverItem['kind']) =>
    kind === 'registry' ? KeyRound : kind === 'folder' ? Folder : FileText;

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-2xl max-h-[85vh] flex flex-col rounded-2xl glass-panel border border-[var(--border-subtle)] shadow-[var(--glass-shadow)]">
        <div className="flex items-start justify-between gap-4 px-5 py-4 border-b border-[var(--border-subtle)]">
          <div>
            <h2 className="text-base font-semibold text-[var(--text-primary)]">
              {forced ? `Remove ${appName} manually` : `Leftovers from ${appName}`}
            </h2>
            <p className="mt-1 text-xs text-[var(--text-secondary)]">
              {results
                ? 'Done. Here is what happened to each item.'
                : items.length === 0
                  ? 'Nothing left behind. This program is fully removed.'
                  : 'These files and registry entries were left on your PC. Untick anything you want to keep. Registry keys are backed up before they are removed.'}
            </p>
          </div>
          <button
            onClick={onClose}
            disabled={busy}
            aria-label="Close"
            className="p-1.5 rounded-full hover:bg-[var(--glass-hover)] text-[var(--text-secondary)] disabled:opacity-40"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-3 py-2">
          {results
            ? results.map((r) => (
                <div key={r.path} className="px-2 py-2 text-xs border-b border-[var(--border-subtle)] last:border-0">
                  <div className="break-all text-[var(--text-primary)]">{r.path}</div>
                  <div className={r.ok ? 'text-[var(--status-safe)]' : 'text-[var(--status-caution)]'}>
                    {r.message}
                  </div>
                </div>
              ))
            : items.map((i) => {
                const Icon = iconFor(i.kind);
                return (
                  <label
                    key={i.path}
                    className="flex items-start gap-3 px-2 py-2.5 rounded-lg hover:bg-[var(--glass-hover)] cursor-pointer"
                  >
                    <input
                      type="checkbox"
                      checked={selected.has(i.path)}
                      onChange={() => toggle(i.path)}
                      className="mt-1"
                    />
                    <Icon className="w-4 h-4 mt-0.5 shrink-0 text-[var(--text-secondary)]" />
                    <div className="min-w-0 flex-1">
                      <div className="text-xs text-[var(--text-primary)] break-all">{i.path}</div>
                      <div className="text-[11px] text-[var(--text-muted)]">
                        {i.kind === 'registry' ? 'Registry key' : i.kind === 'folder' ? 'Folder' : 'Shortcut/file'}
                        {i.sizeBytes > 0 ? ` · ${formatBytes(i.sizeBytes)}` : ''}
                        {i.risk === 'review' ? ' · shared location, check before removing' : ''}
                      </div>
                    </div>
                  </label>
                );
              })}
        </div>

        <div className="flex items-center justify-between gap-3 px-5 py-3.5 border-t border-[var(--border-subtle)]">
          <span className="text-xs text-[var(--text-muted)] tabular-nums">
            {results ? '' : `${selectedItems.length} selected${selectedBytes > 0 ? ` · ${formatBytes(selectedBytes)}` : ''}`}
          </span>
          <div className="flex gap-2">
            {results || items.length === 0 ? (
              <button
                onClick={onClose}
                className="px-5 py-2 text-xs font-semibold rounded-full bg-[var(--pill-active-bg)] text-[var(--pill-active-text)]"
              >
                Close
              </button>
            ) : (
              <>
                <button
                  onClick={onClose}
                  disabled={busy}
                  className="px-4 py-2 text-xs font-medium rounded-full glass-panel glass-panel-hover text-[var(--text-primary)] disabled:opacity-40"
                >
                  Keep all
                </button>
                <button
                  onClick={() => onDelete(selectedItems)}
                  disabled={busy || selectedItems.length === 0}
                  className="inline-flex items-center gap-2 px-5 py-2 text-xs font-semibold rounded-full bg-[var(--pill-active-bg)] text-[var(--pill-active-text)] disabled:opacity-50"
                >
                  {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                  {busy ? 'Removing…' : 'Delete selected'}
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
