import { Copy, FolderOpen, Trash2, XCircle } from 'lucide-react';
import { useEffect } from 'react';

export type NodeMenuAction = 'copy' | 'reveal' | 'recycle' | 'delete';

interface NodeContextMenuProps {
  x: number;
  y: number;
  /** The Recycle Bin and permanent delete are only offered for the installed app. */
  canDelete: boolean;
  onAction: (action: NodeMenuAction) => void;
  onClose: () => void;
}

export function NodeContextMenu({ x, y, canDelete, onAction, onClose }: NodeContextMenuProps) {
  useEffect(() => {
    const close = () => onClose();
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('click', close);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
      window.removeEventListener('keydown', key);
    };
  }, [onClose]);

  // Keep the menu inside the window.
  const left = Math.min(x, window.innerWidth - 240);
  const top = Math.min(y, window.innerHeight - 190);

  const item =
    'w-full flex items-center gap-3 px-4 py-2.5 text-sm text-left text-[var(--text-primary)] hover:bg-[var(--bg-surface-hover)] transition-colors';

  return (
    <div
      role="menu"
      style={{ left, top }}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
      className="fixed z-[80] w-56 py-1.5 rounded-xl glass-panel border border-[var(--border-subtle)] shadow-[var(--glass-shadow)]"
    >
      <button role="menuitem" className={item} onClick={() => onAction('copy')}>
        <Copy className="w-4 h-4 text-[var(--text-secondary)]" />
        Copy path
      </button>
      <button role="menuitem" className={item} onClick={() => onAction('reveal')}>
        <FolderOpen className="w-4 h-4 text-[var(--text-secondary)]" />
        Open in File Explorer
      </button>
      {canDelete && (
        <>
          <div className="my-1 border-t border-[var(--border-subtle)]" />
          <button role="menuitem" className={item} onClick={() => onAction('recycle')}>
            <Trash2 className="w-4 h-4 text-[var(--text-secondary)]" />
            Move to Recycle Bin
          </button>
          <button role="menuitem" className={`${item} text-[var(--status-danger)]`} onClick={() => onAction('delete')}>
            <XCircle className="w-4 h-4" />
            Delete permanently
          </button>
        </>
      )}
    </div>
  );
}
