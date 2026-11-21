export type OsTarget = 'macos' | 'windows' | 'host';

export type ActiveModule =
  | 'status'
  | 'clean'
  | 'analyzer'
  | 'apps'
  | 'purge'
  | 'optimize'
  | 'profiles';

export type SafetyTier = 'safe' | 'moderate' | 'caution';

export interface CpuCoreMetric {
  core: number;
  model: string;
  speedMhz: number;
  loadPct: number;
}

export interface MemoryMetric {
  totalBytes: number;
  usedBytes: number;
  activeBytes: number;
  wiredBytes: number;
  cachedBytes: number;
  freeBytes: number;
  swapUsedBytes: number;
}

export interface DiskPartitionMetric {
  mount: string;
  filesystem: string;
  totalBytes: number;
  usedBytes: number;
  availBytes: number;
  usePct: number;
}

export interface ProcessMetric {
  pid: number;
  name: string;
  user: string;
  cpuPct: number;
  memMb: number;
  command: string;
}

export interface TelemetrySnapshot {
  os: OsTarget;
  hostname: string;
  platformLabel: string;
  arch: string;
  uptimeSeconds: number;
  loadAvg: [number, number, number];
  timestamp: number;
  cpuOverallPct: number;
  cores: CpuCoreMetric[];
  memory: MemoryMetric;
  disks: DiskPartitionMetric[];
  networkRxMbps: number;
  networkTxMbps: number;
  processes: ProcessMetric[];
}

export interface CleanTarget {
  id: string;
  kind: 'cache' | 'installer';
  category: string;
  title: string;
  path: string;
  os: OsTarget;
  sizeBytes: number;
  itemCount: number;
  safety: SafetyTier;
  requiresAdmin: boolean;
  description: string;
  commandPreview: string;
  lastModifiedDays: number;
}

export interface AppLeftover {
  id: string;
  path: string;
  kind: 'Binary' | 'Support' | 'Caches' | 'Preferences' | 'LaunchAgent' | 'Registry' | 'ScheduledTask';
  sizeBytes: number;
  requiresAdmin: boolean;
}

export interface InstalledApp {
  id: string;
  name: string;
  bundleId: string;
  version: string;
  latestVersion: string;
  publisher: string;
  os: OsTarget;
  binarySizeBytes: number;
  lastUsedDays: number;
  updateSource: 'brew' | 'winget' | 'store' | 'none';
  updateCommand?: string;
  leftovers: AppLeftover[];
}

export interface DiskNode {
  id: string;
  name: string;
  path: string;
  sizeBytes: number;
  kind: 'directory' | 'file';
  category?: 'system' | 'app' | 'dev' | 'media' | 'archive' | 'other';
  modifiedDaysAgo: number;
  hashGroup?: string;
  children?: DiskNode[];
}

export interface PurgeProject {
  id: string;
  projectName: string;
  artifactType: 'node_modules' | 'target' | 'dist' | '.next' | 'Pods' | 'bin/obj' | '.venv' | '__pycache__';
  framework: string;
  path: string;
  os: OsTarget;
  sizeBytes: number;
  staleDays: number;
  fileCount: number;
}

export interface StartupItem {
  id: string;
  name: string;
  publisher: string;
  mechanism: 'LaunchAgent' | 'LaunchDaemon' | 'LoginItem' | 'RegistryRun' | 'ScheduledTask' | 'WindowsService';
  path: string;
  os: OsTarget;
  impact: 'high' | 'medium' | 'low';
  enabled: boolean;
  requiresAdmin: boolean;
  locked?: boolean;
}

export interface OptimizeTask {
  id: string;
  title: string;
  category: 'Network' | 'Filesystem' | 'Graphics & UI' | 'Index & Search' | 'Power & Memory';
  os: OsTarget;
  description: string;
  safety: SafetyTier;
  requiresAdmin: boolean;
  command: string;
  estimatedGain: string;
}

export interface WhitelistEntry {
  id: string;
  os: OsTarget | 'all';
  pattern: string;
  reason: string;
  createdAt: string;
}

export interface MaintenanceProfile {
  id: string;
  name: string;
  os: OsTarget;
  description: string;
  cleanTargetIds: string[];
  optimizeTaskIds: string[];
  minStaleDays: number;
  dryRunDefault: boolean;
  updatedAt: string;
}

export interface CleanupRun {
  id: string;
  os: OsTarget;
  mode: 'dry-run' | 'script-export' | 'host-clean';
  summary: string;
  itemCount: number;
  reclaimedBytes: number;
  timestamp: string;
  commandSnippet: string;
}

export interface PersistedState {
  profiles: MaintenanceProfile[];
  whitelist: WhitelistEntry[];
  history: CleanupRun[];
}

export interface ScriptBundle {
  filename: string;
  language: 'bash' | 'powershell' | 'rust';
  content: string;
  cargoToml?: string;
  itemCount: number;
  estimatedBytes: number;
  requiresAdmin: boolean;
}
