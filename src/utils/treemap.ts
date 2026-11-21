import type { DiskNode } from '../types/burrow';

export interface TreemapRect {
  node: DiskNode;
  x: number;
  y: number;
  width: number;
  height: number;
  pct: number;
}

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

function worstAspectRatio(row: number[], shortSide: number): number {
  if (row.length === 0 || shortSide <= 0) return Infinity;
  const sum = row.reduce((acc, v) => acc + v, 0);
  const maxVal = Math.max(...row);
  const minVal = Math.min(...row);
  if (minVal <= 0) return Infinity;
  const s2 = shortSide * shortSide;
  const sum2 = sum * sum;
  return Math.max((s2 * maxVal) / sum2, sum2 / (s2 * minVal));
}

export function computeSquarifiedTreemap(
  children: DiskNode[],
  width: number,
  height: number,
): TreemapRect[] {
  const valid = children
    .filter((c) => c.sizeBytes > 0)
    .slice()
    .sort((a, b) => b.sizeBytes - a.sizeBytes);

  if (valid.length === 0 || width <= 0 || height <= 0) return [];

  const totalSize = valid.reduce((acc, item) => acc + item.sizeBytes, 0);
  if (totalSize <= 0) return [];

  const totalArea = width * height;
  const areas = valid.map((item) => (item.sizeBytes / totalSize) * totalArea);

  const rects: TreemapRect[] = [];
  const box: Box = { x: 0, y: 0, width, height };

  let index = 0;

  const layoutRow = (rowIndices: number[]) => {
    const rowArea = rowIndices.reduce((acc, idx) => acc + areas[idx], 0);
    if (rowArea <= 0) return;

    if (box.width >= box.height) {
      const rowWidth = rowArea / box.height;
      let currY = box.y;
      for (const idx of rowIndices) {
        const h = areas[idx] / rowWidth;
        const node = valid[idx];
        rects.push({
          node,
          x: box.x,
          y: currY,
          width: rowWidth,
          height: h,
          pct: (node.sizeBytes / totalSize) * 100,
        });
        currY += h;
      }
      box.x += rowWidth;
      box.width = Math.max(0, box.width - rowWidth);
    } else {
      const rowHeight = rowArea / box.width;
      let currX = box.x;
      for (const idx of rowIndices) {
        const w = areas[idx] / rowHeight;
        const node = valid[idx];
        rects.push({
          node,
          x: currX,
          y: box.y,
          width: w,
          height: rowHeight,
          pct: (node.sizeBytes / totalSize) * 100,
        });
        currX += w;
      }
      box.y += rowHeight;
      box.height = Math.max(0, box.height - rowHeight);
    }
  };

  let currentRow: number[] = [];

  while (index < valid.length) {
    const shortSide = Math.min(box.width, box.height);
    if (shortSide <= 0) break;

    const candidateRow = [...currentRow, index];
    if (currentRow.length === 0) {
      currentRow = candidateRow;
      index++;
      continue;
    }

    const currWorst = worstAspectRatio(
      currentRow.map((i) => areas[i]),
      shortSide,
    );
    const nextWorst = worstAspectRatio(
      candidateRow.map((i) => areas[i]),
      shortSide,
    );

    if (nextWorst <= currWorst) {
      currentRow = candidateRow;
      index++;
    } else {
      layoutRow(currentRow);
      currentRow = [];
    }
  }

  if (currentRow.length > 0) {
    layoutRow(currentRow);
  }

  return rects;
}
