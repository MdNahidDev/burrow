import type { DiskNode } from '../types/burrow';

export interface LocalScanResult {
  root: DiskNode;
  scannedFiles: number;
  scannedDirs: number;
  truncated: boolean;
}

const MAX_ITEMS = 4000;
const MAX_DEPTH = 6;

export function inferCategory(name: string, isDir: boolean): DiskNode['category'] {
  const lower = name.toLowerCase();
  if (
    lower === 'node_modules' ||
    lower === 'target' ||
    lower === 'dist' ||
    lower === '.next' ||
    lower === '.venv' ||
    lower === '__pycache__' ||
    lower === '.git'
  ) {
    return 'dev';
  }
  if (!isDir) {
    if (/\.(mp4|mov|mkv|avi|png|jpg|jpeg|webp|wav|flac|mp3)$/.test(lower)) return 'media';
    if (/\.(zip|tar|gz|dmg|pkg|iso|exe|msi|7z)$/.test(lower)) return 'archive';
    if (/\.(ts|tsx|js|jsx|py|rs|go|json|md|css|html)$/.test(lower)) return 'dev';
  }
  return isDir ? 'app' : 'other';
}

function pickDirectoryViaInput(): Promise<LocalScanResult | null> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.setAttribute('webkitdirectory', '');
    input.setAttribute('directory', '');
    input.style.display = 'none';
    document.body.appendChild(input);

    let settled = false;
    let focusTimer: number | undefined;

    const cleanup = () => {
      window.removeEventListener('focus', onWindowFocus);
      if (focusTimer !== undefined) window.clearTimeout(focusTimer);
      if (input.parentNode) input.parentNode.removeChild(input);
    };

    const finishNull = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(null);
    };

    // Fallback when OS file dialog closes without firing 'cancel' event on older WebViews
    const onWindowFocus = () => {
      if (focusTimer !== undefined) window.clearTimeout(focusTimer);
      focusTimer = window.setTimeout(() => {
        if (!settled && (!input.files || input.files.length === 0)) {
          finishNull();
        }
      }, 450);
    };

    window.addEventListener('focus', onWindowFocus);

    input.addEventListener('cancel', () => {
      finishNull();
    });

    input.addEventListener('change', () => {
      if (settled) return;
      settled = true;
      const fileList = input.files;
      cleanup();
      if (!fileList || fileList.length === 0) {
        reject(new Error('No files found in the selected folder.'));
        return;
      }

      const now = Date.now();
      const firstRel = fileList[0].webkitRelativePath || fileList[0].name;
      const rootName = firstRel.split('/')[0] || 'Selected Folder';

      const root: DiskNode = {
        id: rootName,
        name: rootName,
        path: rootName,
        sizeBytes: 0,
        kind: 'directory',
        category: inferCategory(rootName, true),
        modifiedDaysAgo: 0,
        children: [],
      };

      const dirMap = new Map<string, DiskNode>([[rootName, root]]);
      let scannedFiles = 0;
      let scannedDirs = 1;
      let truncated = false;

      const limit = Math.min(fileList.length, MAX_ITEMS);
      if (fileList.length > MAX_ITEMS) truncated = true;

      for (let i = 0; i < limit; i++) {
        const file = fileList[i];
        const rel = file.webkitRelativePath || `${rootName}/${file.name}`;
        const parts = rel.split('/').filter(Boolean);
        let parent = root;
        let currPath = rootName;

        const maxSubDirs = Math.min(parts.length - 1, MAX_DEPTH);
        for (let p = 1; p < maxSubDirs; p++) {
          const seg = parts[p];
          currPath = `${currPath}/${seg}`;
          let dirNode = dirMap.get(currPath);
          if (!dirNode) {
            dirNode = {
              id: currPath,
              name: seg,
              path: currPath,
              sizeBytes: 0,
              kind: 'directory',
              category: inferCategory(seg, true),
              modifiedDaysAgo: 0,
              children: [],
            };
            dirMap.set(currPath, dirNode);
            parent.children?.push(dirNode);
            scannedDirs++;
          }
          parent = dirNode;
        }

        const fileName = parts[parts.length - 1] || file.name;
        const daysAgo = Math.max(0, Math.floor((now - file.lastModified) / 86400000));
        const fileNode: DiskNode = {
          id: rel,
          name: fileName,
          path: rel,
          sizeBytes: file.size,
          kind: 'file',
          category: inferCategory(fileName, false),
          modifiedDaysAgo: daysAgo,
          hashGroup: file.size > 1024 * 512 ? `${file.size}:${fileName.toLowerCase()}` : undefined,
        };
        parent.children?.push(fileNode);
        scannedFiles++;

        // Propagate size up the tracked hierarchy
        let accPath = rootName;
        root.sizeBytes += file.size;
        root.modifiedDaysAgo = Math.max(root.modifiedDaysAgo, daysAgo);
        for (let p = 1; p < maxSubDirs; p++) {
          accPath = `${accPath}/${parts[p]}`;
          const node = dirMap.get(accPath);
          if (node) {
            node.sizeBytes += file.size;
            node.modifiedDaysAgo = Math.max(node.modifiedDaysAgo, daysAgo);
          }
        }
      }

      for (const dir of dirMap.values()) {
        dir.children?.sort((a, b) => b.sizeBytes - a.sizeBytes);
      }

      resolve({ root, scannedFiles, scannedDirs, truncated });
    });

    input.click();
  });
}

export async function scanLocalDirectoryPicker(): Promise<LocalScanResult | null> {
  const win = window as unknown as {
    showDirectoryPicker?: (options?: { mode?: 'read' | 'readwrite' }) => Promise<FileSystemDirectoryHandle>;
  };

  if (typeof win.showDirectoryPicker === 'function') {
    try {
      const rootHandle = await win.showDirectoryPicker({ mode: 'read' });
      let scannedFiles = 0;
      let scannedDirs = 0;
      let truncated = false;
      const now = Date.now();

      async function walk(
        dirHandle: FileSystemDirectoryHandle,
        relPath: string,
        depth: number,
      ): Promise<DiskNode> {
        scannedDirs++;
        const children: DiskNode[] = [];
        let totalSize = 0;
        let oldestOrNewestDays = 0;

        if (depth < MAX_DEPTH && scannedFiles + scannedDirs < MAX_ITEMS) {
          const iterable = dirHandle as unknown as AsyncIterable<[string, FileSystemHandle]>;
          for await (const [entryName, handle] of iterable) {
            if (scannedFiles + scannedDirs >= MAX_ITEMS) {
              truncated = true;
              break;
            }
            const entryPath = `${relPath}/${entryName}`;
            if (handle.kind === 'file') {
              try {
                const fileHandle = handle as FileSystemFileHandle;
                const file = await fileHandle.getFile();
                scannedFiles++;
                const daysAgo = Math.max(0, Math.floor((now - file.lastModified) / 86400000));
                oldestOrNewestDays = Math.max(oldestOrNewestDays, daysAgo);
                totalSize += file.size;
                children.push({
                  id: entryPath,
                  name: entryName,
                  path: entryPath,
                  sizeBytes: file.size,
                  kind: 'file',
                  category: inferCategory(entryName, false),
                  modifiedDaysAgo: daysAgo,
                  hashGroup:
                    file.size > 1024 * 512 ? `${file.size}:${entryName.toLowerCase()}` : undefined,
                });
              } catch {
                // Skip unreadable file
              }
            } else if (handle.kind === 'directory') {
              try {
                const subNode = await walk(handle as FileSystemDirectoryHandle, entryPath, depth + 1);
                totalSize += subNode.sizeBytes;
                children.push(subNode);
              } catch {
                // Skip unreadable directory
              }
            }
          }
        }

        children.sort((a, b) => b.sizeBytes - a.sizeBytes);

        return {
          id: relPath,
          name: dirHandle.name,
          path: relPath,
          sizeBytes: totalSize,
          kind: 'directory',
          category: inferCategory(dirHandle.name, true),
          modifiedDaysAgo: oldestOrNewestDays,
          children,
        };
      }

      const root = await walk(rootHandle, rootHandle.name, 0);
      return { root, scannedFiles, scannedDirs, truncated };
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        return null;
      }
      // Fall through to input[webkitdirectory] in embedded iframes / SecurityError
    }
  }

  return pickDirectoryViaInput();
}
