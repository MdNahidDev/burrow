import type { DiskNode } from '../types/burrow';

/** Returns a copy of the tree without the given nodes (matched by id) and with sizes recalculated. */
export function removeNodesById(root: DiskNode, ids: Set<string>): DiskNode {
  const lower = new Set([...ids].map((i) => i.toLowerCase()));

  const walk = (node: DiskNode): { node: DiskNode; removed: number } => {
    if (!node.children || node.children.length === 0) return { node, removed: 0 };
    let removed = 0;
    const kept: DiskNode[] = [];
    for (const child of node.children) {
      if (lower.has(child.id.toLowerCase())) {
        removed += child.sizeBytes;
        continue;
      }
      const res = walk(child);
      removed += res.removed;
      kept.push(res.node);
    }
    if (removed === 0) return { node, removed: 0 };
    return { node: { ...node, children: kept, sizeBytes: Math.max(0, node.sizeBytes - removed) }, removed };
  };

  return walk(root).node;
}
