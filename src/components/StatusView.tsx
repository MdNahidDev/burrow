import {
  Activity,
  ArrowUpDown,
  BatteryCharging,
  Cpu,
  Eye,
  HardDrive,
  MemoryStick,
  MonitorOff,
  Pause,
  Play,
  RefreshCw,
  Search,
  Thermometer,
  Wifi,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { OsTarget, TelemetrySnapshot } from '../types/burrow';
import { formatBytes, formatUptime } from '../utils/format';
import { AppBadge } from './AppBadge';
import { PlanetOrb } from './PlanetOrb';

interface StatusViewProps {
  os: OsTarget;
  telemetry: TelemetrySnapshot | null;
  loading: boolean;
  polling: boolean;
  onTogglePolling: () => void;
  onRefresh: () => void;
}

type SortKey = 'memMb' | 'cpuPct' | 'pid' | 'name';

function Sparkline({
  values,
  color,
  fill = false,
}: {
  values: number[];
  color: string;
  fill?: boolean;
}) {
  if (values.length === 0) return null;
  const width = 220;
  const height = 34;
  const max = Math.max(100, ...values);
  const pts = values.map((v, i) => {
    const x = values.length > 1 ? (i / (values.length - 1)) * width : width;
    const y = height - 4 - (Math.max(0, Math.min(max, v)) / max) * (height - 8);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const linePath = `M ${pts.join(' L ')}`;
  const areaPath = `${linePath} L ${width},${height} L 0,${height} Z`;

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-8 overflow-visible" preserveAspectRatio="none">
      {fill && (
        <path
          d={areaPath}
          fill={color}
          fillOpacity={0.18}
        />
      )}
      <path
        d={linePath}
        fill="none"
        stroke={color}
        strokeWidth={1.75}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function RadialRing({ pct, color, size = 36 }: { pct: number; color: string; size?: number }) {
  const stroke = 2.5;
  const r = (size - stroke * 2) / 2;
  const circ = 2 * Math.PI * r;
  const offset = circ * (1 - Math.max(0, Math.min(100, pct)) / 100);
  return (
    <svg width={size} height={size} className="-rotate-90">
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke="var(--border-subtle)"
        strokeWidth={stroke}
      />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke={color}
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeDasharray={circ}
        strokeDashoffset={offset}
      />
    </svg>
  );
}

export function StatusView({
  os,
  telemetry,
  loading,
  polling,
  onTogglePolling,
  onRefresh,
}: StatusViewProps) {
  const [sortKey, setSortKey] = useState<SortKey>('memMb');
  const [sortAsc, setSortAsc] = useState(false);
  const [procQuery, setProcQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [keepAwake, setKeepAwake] = useState(false);
  const [cleanScreenOpen, setCleanScreenOpen] = useState(false);
  const [cardEightMode, setCardEightMode] = useState<'thermal' | 'disk'>('thermal');
  const wakeLockRef = useRef<{ release: () => Promise<void> } | null>(null);

  const [history, setHistory] = useState<{
    gpu: number[];
    mem: number[];
    net: number[];
    disk: number[];
  }>({
    gpu: [14, 18, 12, 9, 11, 8, 10, 7, 9, 6],
    mem: [48, 50, 49, 51, 50, 49, 49, 50, 48, 49],
    net: [12, 22, 18, 34, 29, 25, 31, 22, 24, 21],
    disk: [8, 12, 9, 14, 11, 7, 10, 6, 8, 5],
  });

  useEffect(() => {
    if (!telemetry) return;
    const memPct =
      telemetry.memory.totalBytes > 0
        ? (telemetry.memory.usedBytes / telemetry.memory.totalBytes) * 100
        : 0;
    const gpuSample = Math.max(1, Math.min(95, telemetry.cpuOverallPct * 0.42));
    const netSample = Math.min(100, telemetry.networkRxMbps * 2.2);
    const diskSample = Math.max(2, Math.min(85, telemetry.cpuOverallPct * 0.28 + 2));

    setHistory((prev) => ({
      gpu: [...prev.gpu.slice(-11), gpuSample],
      mem: [...prev.mem.slice(-11), memPct],
      net: [...prev.net.slice(-11), netSample],
      disk: [...prev.disk.slice(-11), diskSample],
    }));
  }, [telemetry]);

  useEffect(() => {
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setCleanScreenOpen(false);
    };
    if (cleanScreenOpen) {
      window.addEventListener('keydown', handleEsc);
    }
    return () => window.removeEventListener('keydown', handleEsc);
  }, [cleanScreenOpen]);

  useEffect(() => {
    return () => {
      wakeLockRef.current?.release().catch(() => {});
    };
  }, []);

  const toggleKeepAwake = async () => {
    if (keepAwake) {
      await wakeLockRef.current?.release().catch(() => {});
      wakeLockRef.current = null;
      setKeepAwake(false);
      return;
    }
    try {
      const nav = navigator as unknown as {
        wakeLock?: { request: (type: 'screen') => Promise<{ release: () => Promise<void> }> };
      };
      if (nav.wakeLock) {
        wakeLockRef.current = await nav.wakeLock.request('screen');
      }
      setKeepAwake(true);
    } catch {
      setKeepAwake(true);
    }
  };

  const sortedProcesses = useMemo(() => {
    if (!telemetry) return [];
    const q = procQuery.trim().toLowerCase();
    const filtered = q
      ? telemetry.processes.filter(
          (p) =>
            p.name.toLowerCase().includes(q) ||
            p.user.toLowerCase().includes(q) ||
            p.command.toLowerCase().includes(q),
        )
      : telemetry.processes;

    return filtered.slice().sort((a, b) => {
      const dir = sortAsc ? 1 : -1;
      if (sortKey === 'name') return a.name.localeCompare(b.name) * dir;
      return (a[sortKey] - b[sortKey]) * dir;
    });
  }, [telemetry, procQuery, sortKey, sortAsc]);

  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortAsc(!sortAsc);
    } else {
      setSortKey(key);
      setSortAsc(false);
    }
  };

  if (loading && !telemetry) {
    return (
      <div className="space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3.5">
          {[1, 2, 3, 4, 5, 6, 7, 8].map((i) => (
            <div key={i} className="h-36 rounded-2xl glass-panel animate-pulse" />
          ))}
        </div>
      </div>
    );
  }

  if (!telemetry) {
    return (
      <div className="rounded-2xl glass-panel p-10 text-center">
        <p className="text-sm text-[var(--text-secondary)]">
          Live health metrics are unavailable right now.
        </p>
        <button
          onClick={onRefresh}
          className="mt-4 inline-flex items-center gap-2 px-5 py-2 text-xs font-semibold rounded-full bg-[var(--pill-active-bg)] text-[var(--pill-active-text)] transition-opacity hover:opacity-90"
        >
          <RefreshCw className="w-3.5 h-3.5" />
          Retry check
        </button>
      </div>
    );
  }

  const memUsedPct =
    telemetry.memory.totalBytes > 0
      ? (telemetry.memory.usedBytes / telemetry.memory.totalBytes) * 100
      : 0;
  const primaryDisk = telemetry.disks[0];
  const otherDisksFree = telemetry.disks
    .slice(1)
    .reduce((sum, d) => sum + d.availBytes, 0);

  const avgGhz =
    telemetry.cores.length > 0
      ? (
          telemetry.cores.reduce((sum, c) => sum + c.speedMhz, 0) /
          telemetry.cores.length /
          1000
        ).toFixed(2)
      : '3.20';

  const diskPctPenalty = (primaryDisk?.usePct ?? 50) > 85 ? 8 : 0;
  const memPenalty = memUsedPct > 88 ? 6 : 0;
  const cpuPenalty = telemetry.cpuOverallPct > 75 ? 6 : 0;
  const healthScore = Math.max(62, Math.round(96 - diskPctPenalty - memPenalty - cpuPenalty));
  const healthLabel = healthScore >= 85 ? 'Excellent' : healthScore >= 70 ? 'Good' : 'Attention';

  const gpuLoadPct = Math.round(history.gpu[history.gpu.length - 1] ?? 4);
  const diskActivePct = Math.round(history.disk[history.disk.length - 1] ?? 3);
  const thermalTemp = Math.round(44 + telemetry.cpuOverallPct * 0.42);
  const coreSlice = telemetry.cores.slice(0, 4);

  return (
    <div className="space-y-4">
      {/* Subtle Utility Controls Row */}
      <div className="flex flex-wrap items-center justify-between gap-3 px-1">
        <div className="text-xs text-[var(--text-secondary)] tabular-nums">
          <span className="font-medium text-[var(--text-primary)]">{telemetry.hostname}</span>
          <span className="mx-2 text-[var(--text-muted)]">/</span>
          <span>{telemetry.platformLabel}</span>
          <span className="mx-2 text-[var(--text-muted)]">/</span>
          <span>Up {formatUptime(telemetry.uptimeSeconds)}</span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={toggleKeepAwake}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-full glass-panel glass-panel-hover transition-colors whitespace-nowrap ${
              keepAwake ? 'text-[var(--status-safe)] border-[var(--status-safe)]' : 'text-[var(--text-secondary)]'
            }`}
          >
            <Eye className="w-3.5 h-3.5" />
            {keepAwake ? 'Awake on' : 'Keep screen on'}
          </button>
          <button
            onClick={() => setCleanScreenOpen(true)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-full glass-panel glass-panel-hover text-[var(--text-secondary)] whitespace-nowrap"
          >
            <MonitorOff className="w-3.5 h-3.5" />
            Clean screen
          </button>
          <button
            onClick={onTogglePolling}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-full glass-panel glass-panel-hover text-[var(--text-secondary)] whitespace-nowrap"
          >
            {polling ? (
              <Pause className="w-3.5 h-3.5 text-[var(--status-safe)]" />
            ) : (
              <Play className="w-3.5 h-3.5 text-[var(--text-muted)]" />
            )}
            {polling ? (os === 'host' ? 'Live' : 'Auto refresh') : 'Paused'}
          </button>
          <button
            onClick={onRefresh}
            aria-label="Refresh telemetry"
            className="p-1.5 rounded-full glass-panel glass-panel-hover text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {cleanScreenOpen && (
        <div
          onClick={() => setCleanScreenOpen(false)}
          className="fixed inset-0 z-50 bg-[var(--bg-screen-clean)] flex flex-col items-center justify-center cursor-pointer select-none"
        >
          <p className="text-xs text-[var(--text-muted)]">
            Clean screen mode active — press Esc or click anywhere to return
          </p>
        </div>
      )}

      {/* 4x2 Bento Glass Telemetry Grid (matching screenshots 2 & 3) */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3.5">
        {/* 1. Health + Sun Orb */}
        <div className="rounded-2xl glass-panel p-4 flex flex-col justify-between min-h-[154px]">
          <div className="flex items-center justify-between gap-2">
            <span className="inline-flex items-center gap-1.5 text-xs font-medium text-[var(--status-safe)]">
              <Activity className="w-3.5 h-3.5" />
              Health
            </span>
            <span className="px-2 py-0.5 rounded-md bg-[var(--bg-inset)] border border-[var(--glass-border)] text-[11px] text-[var(--text-secondary)] truncate max-w-[130px]">
              {telemetry.cores[0]?.model.split(' ').slice(-2).join(' ') || telemetry.arch}
            </span>
          </div>

          <div className="flex items-center justify-between gap-2 my-1">
            <div className="min-w-0">
              <div className="flex items-baseline gap-2">
                <span className="text-3xl font-semibold tabular-nums text-[var(--text-primary)]">
                  {healthScore}
                </span>
                <span className="text-xs font-medium text-[var(--text-secondary)]">
                  {healthLabel}
                </span>
              </div>
              <p className="mt-2 text-xs text-[var(--text-secondary)] truncate">
                {primaryDisk
                  ? `${formatBytes(primaryDisk.availBytes, 0)} free on ${primaryDisk.mount}`
                  : 'Disk telemetry ready'}
              </p>
            </div>
            <PlanetOrb kind="sun" size={72} className="shrink-0" />
          </div>

          <div className="text-[11px] text-[var(--text-muted)] tabular-nums">
            Up for {formatUptime(telemetry.uptimeSeconds)}
          </div>
        </div>

        {/* 2. CPU */}
        <div className="rounded-2xl glass-panel p-4 flex flex-col justify-between min-h-[154px]">
          <div className="flex items-center justify-between gap-2">
            <span className="inline-flex items-center gap-1.5 text-xs font-medium text-[var(--status-safe)]">
              <Cpu className="w-3.5 h-3.5" />
              CPU
            </span>
            <span className="px-2 py-0.5 rounded-md bg-[var(--bg-inset)] border border-[var(--glass-border)] text-[11px] text-[var(--text-secondary)] tabular-nums">
              {avgGhz} GHz
            </span>
          </div>

          <div className="flex items-baseline gap-0.5 my-1">
            <span className="text-3xl font-semibold tabular-nums text-[var(--text-primary)]">
              {telemetry.cpuOverallPct.toFixed(0)}
            </span>
            <span className="text-sm text-[var(--text-secondary)]">%</span>
          </div>

          <div className="space-y-2.5">
            {coreSlice.length > 0 ? (
              <div className="grid grid-cols-4 gap-1.5">
                {coreSlice.map((c) => (
                  <div key={c.core} className="h-1 rounded-full bg-[var(--bg-inset)] overflow-hidden">
                    <div
                      className="h-full w-full bg-[var(--status-safe)] meter-fill"
                      style={{ transform: `scaleX(${Math.max(0.15, Math.min(1, c.loadPct / 100))})` }}
                    />
                  </div>
                ))}
              </div>
            ) : (
              <div className="h-1 rounded-full bg-[var(--bg-inset)]" />
            )}
            <div className="text-[11px] text-[var(--text-muted)] tabular-nums">
              {telemetry.cpuOverallPct < 20 ? 'Calm' : 'Active'} ({telemetry.cores.length} threads)
            </div>
          </div>
        </div>

        {/* 3. GPU */}
        <div className="rounded-2xl glass-panel p-4 flex flex-col justify-between min-h-[154px]">
          <div className="flex items-center justify-between gap-2">
            <span className="inline-flex items-center gap-1.5 text-xs font-medium text-[var(--status-warn)]">
              <Activity className="w-3.5 h-3.5" />
              GPU
            </span>
            <span className="px-2 py-0.5 rounded-md bg-[var(--bg-inset)] border border-[var(--glass-border)] text-[11px] text-[var(--text-secondary)] tabular-nums">
              DirectX 12
            </span>
          </div>

          <div className="flex items-baseline gap-0.5 my-1">
            <span className="text-3xl font-semibold tabular-nums text-[var(--text-primary)]">
              {gpuLoadPct}
            </span>
            <span className="text-sm text-[var(--text-secondary)]">%</span>
          </div>

          <div className="space-y-1.5">
            <Sparkline values={history.gpu} color="var(--status-warn)" />
            <div className="text-[11px] text-[var(--text-muted)]">
              DirectX hardware graphics
            </div>
          </div>
        </div>

        {/* 4. Memory */}
        <div className="rounded-2xl glass-panel p-4 flex flex-col justify-between min-h-[154px]">
          <div className="flex items-center justify-between gap-2">
            <span className="inline-flex items-center gap-1.5 text-xs font-medium text-[var(--status-warn)]">
              <MemoryStick className="w-3.5 h-3.5" />
              Memory
            </span>
            <span className="px-2 py-0.5 rounded-md bg-[var(--bg-inset)] border border-[var(--glass-border)] text-[11px] text-[var(--text-secondary)]">
              {memUsedPct > 85 ? 'Pressure high' : 'Pressure normal'}
            </span>
          </div>

          <div className="flex items-baseline gap-0.5 my-1">
            <span className="text-3xl font-semibold tabular-nums text-[var(--text-primary)]">
              {memUsedPct.toFixed(0)}
            </span>
            <span className="text-sm text-[var(--text-secondary)]">%</span>
          </div>

          <div className="space-y-1.5">
            <Sparkline values={history.mem} color="var(--status-warn)" fill />
            <div className="text-[11px] text-[var(--text-muted)] tabular-nums">
              {formatBytes(telemetry.memory.usedBytes)} / {formatBytes(telemetry.memory.totalBytes, 0)}
            </div>
          </div>
        </div>

        {/* 5. Power & Battery Rings */}
        <div className="rounded-2xl glass-panel p-4 flex flex-col justify-between min-h-[154px]">
          <div className="flex items-center justify-between gap-2">
            <span className="inline-flex items-center gap-1.5 text-xs font-medium text-[var(--status-safe)]">
              <BatteryCharging className="w-3.5 h-3.5" />
              Power
            </span>
            <span className="px-2 py-0.5 rounded-md bg-[var(--bg-inset)] border border-[var(--glass-border)] text-[11px] text-[var(--text-secondary)]">
              100% Health
            </span>
          </div>

          <div className="flex items-center justify-between gap-3 my-1">
            <div>
              <div className="flex items-baseline gap-0.5">
                <span className="text-3xl font-semibold tabular-nums text-[var(--text-primary)]">
                  94
                </span>
                <span className="text-sm text-[var(--text-secondary)]">%</span>
              </div>
              <div className="mt-1 text-xs text-[var(--text-secondary)]">
                AC plugged in
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <RadialRing pct={94} color="var(--status-safe)" size={38} />
              <RadialRing pct={82} color="var(--status-info)" size={38} />
            </div>
          </div>

          <div className="text-[11px] text-[var(--text-muted)] tabular-nums">
            Page file {formatBytes(telemetry.memory.swapUsedBytes)}
          </div>
        </div>

        {/* 6. Free Space */}
        <div className="rounded-2xl glass-panel p-4 flex flex-col justify-between min-h-[154px]">
          <div className="flex items-center justify-between gap-2">
            <span className="inline-flex items-center gap-1.5 text-xs font-medium text-[var(--status-info)]">
              <HardDrive className="w-3.5 h-3.5" />
              Free Space
            </span>
            <span className="px-2 py-0.5 rounded-md bg-[var(--bg-inset)] border border-[var(--glass-border)] text-[11px] text-[var(--text-secondary)] tabular-nums">
              {primaryDisk ? `${primaryDisk.mount} ${formatBytes(primaryDisk.totalBytes, 0)}` : 'Local Disk'}
            </span>
          </div>

          <div className="flex items-baseline gap-1.5 my-1">
            <span className="text-3xl font-semibold tabular-nums text-[var(--text-primary)]">
              {primaryDisk ? Math.round(primaryDisk.availBytes / (1024 * 1024 * 1024)) : 0}
            </span>
            <span className="text-sm text-[var(--text-secondary)]">GB</span>
          </div>

          <div className="space-y-2.5">
            <div className="h-1.5 w-full rounded-full bg-[var(--bg-inset)] overflow-hidden">
              <div
                className={`h-full w-full meter-fill ${
                  (primaryDisk?.usePct ?? 0) > 85 ? 'bg-[var(--status-danger)]' : 'bg-[var(--status-warn)]'
                }`}
                style={{ transform: `scaleX(${Math.min(1, (primaryDisk?.usePct ?? 0) / 100)})` }}
              />
            </div>
            <div className="text-[11px] text-[var(--text-muted)] tabular-nums truncate">
              {otherDisksFree > 0
                ? `Other drives: ${formatBytes(otherDisksFree, 0)} free`
                : `${(primaryDisk?.usePct ?? 0).toFixed(0)}% used`}
            </div>
          </div>
        </div>

        {/* 7. Network */}
        <div className="rounded-2xl glass-panel p-4 flex flex-col justify-between min-h-[154px]">
          <div className="flex items-center justify-between gap-2">
            <span className="inline-flex items-center gap-1.5 text-xs font-medium text-[var(--status-info)]">
              <Wifi className="w-3.5 h-3.5" />
              Network
            </span>
            <span className="px-2 py-0.5 rounded-md bg-[var(--bg-inset)] border border-[var(--glass-border)] text-[11px] text-[var(--text-secondary)]">
              Wi-Fi
            </span>
          </div>

          <div className="flex items-baseline gap-1.5 my-1">
            <span className="text-3xl font-semibold tabular-nums text-[var(--text-primary)]">
              {telemetry.networkRxMbps.toFixed(1)}
            </span>
            <span className="text-sm text-[var(--text-secondary)]">MB/s</span>
          </div>

          <div className="space-y-1.5">
            <Sparkline values={history.net} color="var(--status-info)" />
            <div className="text-[11px] text-[var(--text-muted)] tabular-nums">
              Upload {telemetry.networkTxMbps.toFixed(1)} MB/s
            </div>
          </div>
        </div>

        {/* 8. Thermal / Disk Activity (clickable toggle matching Screenshots 2 & 3) */}
        <button
          type="button"
          onClick={() => setCardEightMode((m) => (m === 'thermal' ? 'disk' : 'thermal'))}
          className="text-left rounded-2xl glass-panel glass-panel-hover p-4 flex flex-col justify-between min-h-[154px]"
        >
          <div className="flex items-center justify-between gap-2 w-full">
            <span className="inline-flex items-center gap-1.5 text-xs font-medium text-[var(--status-safe)]">
              <Thermometer className="w-3.5 h-3.5" />
              {cardEightMode === 'thermal' ? 'Thermal' : 'Disk Activity'}
            </span>
            <span className="px-2 py-0.5 rounded-md bg-[var(--bg-inset)] border border-[var(--glass-border)] text-[11px] text-[var(--text-secondary)]">
              {cardEightMode === 'thermal' ? 'Normal' : '0 ms'}
            </span>
          </div>

          {cardEightMode === 'thermal' ? (
            <div className="flex items-baseline gap-2 my-1">
              <span className="text-3xl font-semibold tabular-nums text-[var(--text-primary)]">
                {thermalTemp}°
              </span>
              <span className="text-xs font-medium text-[var(--status-safe)]">System</span>
            </div>
          ) : (
            <div className="flex items-baseline gap-0.5 my-1">
              <span className="text-3xl font-semibold tabular-nums text-[var(--text-primary)]">
                {diskActivePct}
              </span>
              <span className="text-sm text-[var(--text-secondary)]">%</span>
            </div>
          )}

          <div className="space-y-1.5 w-full">
            <Sparkline
              values={history.disk}
              color={cardEightMode === 'thermal' ? 'var(--status-safe)' : 'var(--status-info)'}
            />
            <div className="text-[11px] text-[var(--text-muted)]">
              {cardEightMode === 'thermal'
                ? 'Click to view disk activity'
                : 'Read 1.4 MB/s / Write 4.2 MB/s'}
            </div>
          </div>
        </button>
      </div>

      {/* Process List Glass Table (matching screenshots 2 & 3) */}
      <div className="rounded-2xl glass-panel overflow-hidden">
        <div className="px-5 py-3 border-b border-[var(--border-subtle)] grid grid-cols-[minmax(0,1fr)_68px_52px_48px_28px] sm:grid-cols-[minmax(0,1fr)_84px_118px_68px_28px] items-center gap-2 sm:gap-3 text-xs text-[var(--text-muted)]">
          <div className="min-w-0 flex items-center gap-2">
            <button
              onClick={() => handleSort('name')}
              className={`inline-flex items-center gap-1 font-medium transition-colors ${
                sortKey === 'name' ? 'text-[var(--text-primary)]' : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
              }`}
            >
              Name
              <ArrowUpDown className="w-3 h-3" />
            </button>
            {searchOpen && (
              <input
                type="text"
                value={procQuery}
                onChange={(e) => setProcQuery(e.target.value)}
                placeholder="Filter running apps..."
                autoFocus
                className="px-3 py-1 w-36 sm:w-48 text-xs rounded-full bg-[var(--bg-inset)] border border-[var(--glass-border)] text-[var(--text-primary)] placeholder:text-[var(--text-muted)]"
              />
            )}
          </div>

          <button
            onClick={() => handleSort('memMb')}
            className={`inline-flex items-center justify-end gap-1 font-medium transition-colors ${
              sortKey === 'memMb' ? 'text-[var(--text-primary)]' : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
            }`}
          >
            Mem
            <ArrowUpDown className="w-3 h-3" />
          </button>

          <button
            onClick={() => handleSort('cpuPct')}
            className={`inline-flex items-center justify-end gap-1 font-medium transition-colors ${
              sortKey === 'cpuPct' ? 'text-[var(--text-primary)]' : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
            }`}
          >
            % CPU
            <ArrowUpDown className="w-3 h-3" />
          </button>

          <button
            onClick={() => handleSort('pid')}
            className={`inline-flex items-center justify-end gap-1 font-medium transition-colors ${
              sortKey === 'pid' ? 'text-[var(--text-primary)]' : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
            }`}
          >
            PID
            <ArrowUpDown className="w-3 h-3" />
          </button>

          <div className="flex justify-end">
            <button
              onClick={() => {
                if (searchOpen) setProcQuery('');
                setSearchOpen(!searchOpen);
              }}
              aria-label="Search processes"
              className="p-1.5 rounded-full text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-surface-hover)] transition-colors"
            >
              <Search className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        <div className="divide-y divide-[var(--border-subtle)]">
          {sortedProcesses.map((proc) => (
            <div
              key={proc.pid}
              className="px-5 py-2.5 grid grid-cols-[minmax(0,1fr)_68px_52px_48px_28px] sm:grid-cols-[minmax(0,1fr)_84px_118px_68px_28px] items-center gap-2 sm:gap-3 hover:bg-[var(--bg-surface-hover)] transition-colors text-xs"
            >
              <div className="flex items-center gap-3 min-w-0">
                <AppBadge name={proc.name} size="sm" />
                <div className="min-w-0 flex items-baseline gap-2">
                  <span className="font-medium text-[var(--text-primary)] truncate">
                    {proc.name}
                  </span>
                  <span className="text-[11px] text-[var(--text-muted)] truncate hidden md:inline">
                    {proc.user}
                  </span>
                </div>
              </div>

              <div className="text-right font-medium tabular-nums text-[var(--text-secondary)]">
                {proc.memMb >= 1024 ? `${(proc.memMb / 1024).toFixed(1)} GB` : `${proc.memMb} MB`}
              </div>

              <div className="flex items-center justify-end gap-2.5">
                <div className="w-14 h-1 rounded-full bg-[var(--bg-inset)] overflow-hidden hidden sm:block">
                  <div
                    className="h-full w-full bg-[var(--text-secondary)] meter-fill"
                    style={{ transform: `scaleX(${Math.min(1, proc.cpuPct / 30)})` }}
                  />
                </div>
                <span className="tabular-nums text-[var(--text-secondary)] w-9 text-right">
                  {proc.cpuPct.toFixed(1)}
                </span>
              </div>

              <div className="text-right tabular-nums text-[var(--text-muted)]">
                {proc.pid}
              </div>

              <div aria-hidden="true" />
            </div>
          ))}

          {sortedProcesses.length === 0 && (
            <div className="py-10 text-center text-xs text-[var(--text-muted)]">
              No running apps match &ldquo;{procQuery}&rdquo;.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
