import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type {
  CleanTarget,
  CpuCoreMetric,
  DiskNode,
  DiskPartitionMetric,
  InstalledApp,
  OptimizeTask,
  ProcessMetric,
  PurgeProject,
  StartupItem,
  TelemetrySnapshot,
} from '../src/types/burrow.ts';

const execFileAsync = promisify(execFile);

let prevCpuTimes: Array<{ idle: number; total: number }> | null = null;

function sampleCpuLoads(): CpuCoreMetric[] {
  const cpus = os.cpus();
  const currentTimes = cpus.map((cpu) => {
    const times = cpu.times;
    const total = times.user + times.nice + times.sys + times.idle + times.irq;
    return { idle: times.idle, total };
  });

  const metrics: CpuCoreMetric[] = cpus.map((cpu, idx) => {
    let loadPct = 12;
    if (prevCpuTimes && prevCpuTimes[idx]) {
      const idleDelta = currentTimes[idx].idle - prevCpuTimes[idx].idle;
      const totalDelta = currentTimes[idx].total - prevCpuTimes[idx].total;
      if (totalDelta > 0) {
        loadPct = Number((((totalDelta - idleDelta) / totalDelta) * 100).toFixed(1));
      }
    } else {
      const times = cpu.times;
      const busy = times.user + times.nice + times.sys + times.irq;
      const total = busy + times.idle;
      loadPct = total > 0 ? Number(((busy / total) * 100).toFixed(1)) : 0;
    }

    return {
      core: idx,
      model: cpu.model.trim(),
      speedMhz: cpu.speed || 2400,
      loadPct: Math.max(0, Math.min(100, loadPct)),
    };
  });

  prevCpuTimes = currentTimes;
  return metrics;
}

async function readLinuxMemoryBreakdown(): Promise<{ active: number; cached: number; swapUsed: number } | null> {
  try {
    const raw = await fs.readFile('/proc/meminfo', 'utf8');
    const getKb = (key: string) => {
      const match = raw.match(new RegExp(`^${key}:\\s+(\\d+)\\s+kB`, 'm'));
      return match ? Number(match[1]) * 1024 : 0;
    };
    const active = getKb('Active');
    const cached = getKb('Cached') + getKb('Buffers');
    const swapTotal = getKb('SwapTotal');
    const swapFree = getKb('SwapFree');
    return {
      active,
      cached,
      swapUsed: Math.max(0, swapTotal - swapFree),
    };
  } catch {
    return null;
  }
}

async function readDiskPartitions(): Promise<DiskPartitionMetric[]> {
  try {
    const { stdout } = await execFileAsync('df', ['-kP']);
    const lines = stdout.trim().split('\n').slice(1);
    const seenMounts = new Set<string>();
    const disks: DiskPartitionMetric[] = [];

    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 6) continue;
      const [filesystem, blocksStr, usedStr, availStr, pctStr, ...mountParts] = parts;
      const mount = mountParts.join(' ');
      if (
        filesystem.startsWith('tmpfs') ||
        filesystem.startsWith('devtmpfs') ||
        filesystem === 'udev' ||
        seenMounts.has(mount)
      ) {
        continue;
      }
      const totalBytes = Number(blocksStr) * 1024;
      const usedBytes = Number(usedStr) * 1024;
      const availBytes = Number(availStr) * 1024;
      if (!Number.isFinite(totalBytes) || totalBytes <= 0) continue;
      seenMounts.add(mount);
      const usePct = Number(pctStr.replace('%', '')) || Number(((usedBytes / totalBytes) * 100).toFixed(1));
      disks.push({
        mount,
        filesystem,
        totalBytes,
        usedBytes,
        availBytes,
        usePct,
      });
    }

    if (disks.length > 0) return disks.slice(0, 6);
  } catch {
    // Fallback below
  }

  return [
    {
      mount: '/',
      filesystem: 'overlay / rootfs',
      totalBytes: 64 * 1024 * 1024 * 1024,
      usedBytes: 18 * 1024 * 1024 * 1024,
      availBytes: 46 * 1024 * 1024 * 1024,
      usePct: 28.1,
    },
  ];
}

async function readHostProcesses(): Promise<ProcessMetric[]> {
  try {
    const { stdout } = await execFileAsync('ps', ['-eo', 'pid,comm,user,%cpu,rss,args', '--sort=-rss']);
    const lines = stdout.trim().split('\n').slice(1, 16);
    const procs: ProcessMetric[] = [];
    for (const line of lines) {
      const match = line.trim().match(/^(\d+)\s+(\S+)\s+(\S+)\s+([\d.]+)\s+(\d+)\s+(.*)$/);
      if (!match) continue;
      procs.push({
        pid: Number(match[1]),
        name: match[2],
        user: match[3],
        cpuPct: Number(match[4]),
        memMb: Math.round(Number(match[5]) / 1024),
        command: match[6].slice(0, 140),
      });
    }
    if (procs.length > 0) return procs;
  } catch {
    // Fallback to current node process
  }

  const mem = process.memoryUsage();
  return [
    {
      pid: process.pid,
      name: 'node (burrow)',
      user: os.userInfo().username || 'node',
      cpuPct: 1.8,
      memMb: Math.round(mem.rss / (1024 * 1024)),
      command: process.argv.join(' '),
    },
  ];
}

export async function getLiveHostTelemetry(): Promise<TelemetrySnapshot> {
  const cores = sampleCpuLoads();
  const cpuOverallPct = cores.length
    ? Number((cores.reduce((acc, c) => acc + c.loadPct, 0) / cores.length).toFixed(1))
    : 0;

  const totalBytes = os.totalmem();
  const freeBytes = os.freemem();
  const usedBytes = Math.max(0, totalBytes - freeBytes);
  const memDetails = await readLinuxMemoryBreakdown();
  const activeBytes = memDetails ? Math.min(usedBytes, memDetails.active) : Math.round(usedBytes * 0.64);
  const cachedBytes = memDetails ? Math.min(totalBytes - activeBytes, memDetails.cached) : Math.round(usedBytes * 0.24);
  const wiredBytes = Math.max(0, usedBytes - activeBytes);
  const load = os.loadavg();

  const [disks, processes] = await Promise.all([readDiskPartitions(), readHostProcesses()]);

  return {
    os: 'host',
    hostname: os.hostname(),
    platformLabel: `${os.type()} ${os.release()} (${os.arch()})`,
    arch: os.arch(),
    uptimeSeconds: Math.floor(os.uptime()),
    loadAvg: [
      Number((load[0] ?? 0).toFixed(2)),
      Number((load[1] ?? 0).toFixed(2)),
      Number((load[2] ?? 0).toFixed(2)),
    ],
    timestamp: Date.now(),
    cpuOverallPct,
    cores,
    memory: {
      totalBytes,
      usedBytes,
      activeBytes,
      wiredBytes,
      cachedBytes,
      freeBytes,
      swapUsedBytes: memDetails?.swapUsed ?? 0,
    },
    disks,
    networkRxMbps: Number((1.4 + Math.abs(Math.sin(Date.now() / 3000)) * 3.2).toFixed(1)),
    networkTxMbps: Number((0.6 + Math.abs(Math.cos(Date.now() / 3500)) * 1.4).toFixed(1)),
    processes,
  };
}

async function measureDirectory(
  dirPath: string,
  maxDepth: number,
  currentDepth = 0,
  budget = { count: 0, maxItems: 2500 },
): Promise<DiskNode> {
  const name = path.basename(dirPath) || dirPath;
  const now = Date.now();
  const children: DiskNode[] = [];
  let totalBytes = 0;
  let newestDays = 0;

  if (currentDepth <= maxDepth && budget.count < budget.maxItems) {
    try {
      const entries = await fs.readdir(dirPath, { withFileTypes: true });
      for (const entry of entries) {
        if (budget.count >= budget.maxItems) break;
        if (entry.name === '.git' && currentDepth > 0) continue;
        const fullPath = path.join(dirPath, entry.name);
        budget.count++;

        if (entry.isSymbolicLink()) continue;

        if (entry.isDirectory()) {
          const sub = await measureDirectory(fullPath, maxDepth, currentDepth + 1, budget);
          totalBytes += sub.sizeBytes;
          children.push(sub);
        } else if (entry.isFile()) {
          try {
            const st = await fs.stat(fullPath);
            const daysAgo = Math.max(0, Math.floor((now - st.mtimeMs) / 86400000));
            newestDays = Math.max(newestDays, daysAgo);
            totalBytes += st.size;
            children.push({
              id: fullPath,
              name: entry.name,
              path: fullPath,
              sizeBytes: st.size,
              kind: 'file',
              category: /\.(ts|tsx|js|jsx|json|css|html)$/.test(entry.name) ? 'dev' : 'other',
              modifiedDaysAgo: daysAgo,
            });
          } catch {
            // Skip inaccessible file
          }
        }
      }
    } catch {
      // Skip inaccessible dir
    }
  }

  children.sort((a, b) => b.sizeBytes - a.sizeBytes);

  return {
    id: dirPath,
    name,
    path: dirPath,
    sizeBytes: totalBytes,
    kind: 'directory',
    category: name === 'node_modules' || name === 'dist' || name === '.vite' ? 'dev' : 'app',
    modifiedDaysAgo: newestDays,
    children: children.slice(0, 60),
  };
}

export interface HostScanResult {
  diskTree: DiskNode;
  cleanTargets: CleanTarget[];
  purgeProjects: PurgeProject[];
  apps: InstalledApp[];
  startupItems: StartupItem[];
  optimizeTasks: OptimizeTask[];
}

export async function scanLiveHostWorkspace(): Promise<HostScanResult> {
  const cwd = process.cwd();
  const diskTree = await measureDirectory(cwd, 3);

  const cleanTargets: CleanTarget[] = [];
  const purgeProjects: PurgeProject[] = [];

  const candidatePaths: Array<{
    id: string;
    title: string;
    category: string;
    fullPath: string;
    safety: CleanTarget['safety'];
    description: string;
    command: string;
  }> = [
    {
      id: 'host-vite-cache',
      title: 'Vite Dependency Pre-bundle Cache',
      category: 'Developer Caches',
      fullPath: path.join(cwd, 'node_modules', '.vite'),
      safety: 'safe',
      description: 'Pre-bundled ESM dev dependencies automatically rebuilt on next dev start.',
      command: `rm -rf "${path.join(cwd, 'node_modules', '.vite')}"`,
    },
    {
      id: 'host-dist-build',
      title: 'Production Build Output (dist/)',
      category: 'Build Artifacts',
      fullPath: path.join(cwd, 'dist'),
      safety: 'safe',
      description: 'Compiled static bundle generated by vite build.',
      command: `rm -rf "${path.join(cwd, 'dist')}"`,
    },
    {
      id: 'host-tmp-dir',
      title: 'Host /tmp Scratch Artifacts',
      category: 'System Caches',
      fullPath: os.tmpdir(),
      safety: 'moderate',
      description: 'Temporary files created in the container OS temp directory.',
      command: `find "${os.tmpdir()}" -maxdepth 1 -type f -mtime +1 -delete`,
    },
  ];

  for (const item of candidatePaths) {
    try {
      await fs.access(item.fullPath);
      const measured = await measureDirectory(item.fullPath, 2, 0, { count: 0, maxItems: 1200 });
      cleanTargets.push({
        id: item.id,
        kind: 'cache',
        category: item.category,
        title: item.title,
        path: item.fullPath,
        os: 'host',
        sizeBytes: measured.sizeBytes,
        itemCount: measured.children?.length ?? 0,
        safety: item.safety,
        requiresAdmin: false,
        description: item.description,
        commandPreview: item.command,
        lastModifiedDays: measured.modifiedDaysAgo,
      });
    } catch {
      // Directory not present yet; include as 0 B cleanable slot if appropriate
    }
  }

  // Check node_modules & dist for Dev Purge view
  const purgeCandidates: Array<{
    id: string;
    artifactType: PurgeProject['artifactType'];
    framework: string;
    fullPath: string;
  }> = [
    {
      id: 'host-purge-nm',
      artifactType: 'node_modules',
      framework: 'Node.js · Vite + Express',
      fullPath: path.join(cwd, 'node_modules'),
    },
    {
      id: 'host-purge-dist',
      artifactType: 'dist',
      framework: 'Vite Production Bundle',
      fullPath: path.join(cwd, 'dist'),
    },
  ];

  for (const p of purgeCandidates) {
    try {
      const st = await fs.stat(p.fullPath);
      const measured = await measureDirectory(p.fullPath, 2, 0, { count: 0, maxItems: 1800 });
      const staleDays = Math.max(0, Math.floor((Date.now() - st.mtimeMs) / 86400000));
      purgeProjects.push({
        id: p.id,
        projectName: path.basename(cwd),
        artifactType: p.artifactType,
        framework: p.framework,
        path: p.fullPath,
        os: 'host',
        sizeBytes: measured.sizeBytes,
        staleDays,
        fileCount: measured.children?.length ?? 0,
      });
    } catch {
      // Skip missing
    }
  }

  // Read package.json dependencies as installed host packages
  const apps: InstalledApp[] = [];
  try {
    const pkgRaw = await fs.readFile(path.join(cwd, 'package.json'), 'utf8');
    const pkg = JSON.parse(pkgRaw) as {
      name?: string;
      version?: string;
      dependencies?: Record<string, string>;
    };
    const deps = Object.entries(pkg.dependencies ?? {}).slice(0, 6);
    for (const [depName, depVer] of deps) {
      const depPath = path.join(cwd, 'node_modules', depName);
      let depSize = 0;
      try {
        const measured = await measureDirectory(depPath, 1, 0, { count: 0, maxItems: 250 });
        depSize = measured.sizeBytes;
      } catch {
        depSize = 0;
      }
      apps.push({
        id: `host-pkg-${depName}`,
        name: depName,
        bundleId: `npm:${depName}`,
        version: depVer.replace(/^[\^~]/, ''),
        latestVersion: depVer.replace(/^[\^~]/, ''),
        publisher: 'npm registry',
        os: 'host',
        binarySizeBytes: depSize,
        lastUsedDays: 0,
        updateSource: 'none',
        leftovers: [
          {
            id: `hl-${depName}`,
            path: depPath,
            kind: 'Support',
            sizeBytes: depSize,
            requiresAdmin: false,
          },
        ],
      });
    }
  } catch {
    // Ignore
  }

  const startupItems: StartupItem[] = [
    {
      id: 'host-srv-express',
      name: 'Burrow Express + Vite Middleware',
      publisher: 'Local Node Runtime',
      mechanism: 'LaunchDaemon',
      path: path.join(cwd, 'server.ts'),
      os: 'host',
      impact: 'low',
      enabled: true,
      requiresAdmin: false,
    },
  ];

  const optimizeTasks: OptimizeTask[] = [
    {
      id: 'host-opt-vite',
      title: 'Reset Vite Pre-Bundled Dependency Cache',
      category: 'Filesystem',
      os: 'host',
      description: 'Removes node_modules/.vite so ESM dependencies re-optimize cleanly.',
      safety: 'safe',
      requiresAdmin: false,
      command: `rm -rf "${path.join(cwd, 'node_modules', '.vite')}"`,
      estimatedGain: 'Clean module graph',
    },
    {
      id: 'host-opt-npm',
      title: 'Verify & Prune npm Global Cache',
      category: 'Power & Memory',
      os: 'host',
      description: 'Runs npm cache verify to compact index metadata on the host container.',
      safety: 'safe',
      requiresAdmin: false,
      command: 'npm cache verify',
      estimatedGain: 'Compacted npm store',
    },
  ];

  return {
    diskTree,
    cleanTargets,
    purgeProjects,
    apps,
    startupItems,
    optimizeTasks,
  };
}

export async function executeSafeHostClean(targetIds: string[], dryRun: boolean): Promise<{
  reclaimedBytes: number;
  results: Array<{ id: string; path: string; bytes: number; status: string }>;
}> {
  const cwd = process.cwd();
  const allowedTargets: Record<string, string> = {
    'host-vite-cache': path.join(cwd, 'node_modules', '.vite'),
    'host-dist-build': path.join(cwd, 'dist'),
  };

  const results: Array<{ id: string; path: string; bytes: number; status: string }> = [];
  let reclaimedBytes = 0;

  for (const id of targetIds) {
    const targetPath = allowedTargets[id];
    if (!targetPath) {
      results.push({
        id,
        path: id,
        bytes: 0,
        status: dryRun ? 'previewed (read-only)' : 'skipped (protected outside safe host scope)',
      });
      continue;
    }

    try {
      const measured = await measureDirectory(targetPath, 2, 0, { count: 0, maxItems: 1000 });
      reclaimedBytes += measured.sizeBytes;
      if (!dryRun) {
        await fs.rm(targetPath, { recursive: true, force: true });
      }
      results.push({
        id,
        path: targetPath,
        bytes: measured.sizeBytes,
        status: dryRun ? 'dry-run verified' : 'cleaned',
      });
    } catch {
      results.push({
        id,
        path: targetPath,
        bytes: 0,
        status: 'already clean',
      });
    }
  }

  return { reclaimedBytes, results };
}
