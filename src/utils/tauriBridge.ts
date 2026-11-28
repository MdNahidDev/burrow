import { getTelemetryProfile } from '../data/osProfiles';
import type { TelemetrySnapshot } from '../types/burrow';

type TauriInvokeFn = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

export interface CleanTargetInput {
  id: string;
  path: string;
}

export interface CleanScanResult {
  id: string;
  path: string;
  sizeBytes: number;
  itemCount: number;
}

export interface CleanActionReport {
  id: string;
  path: string;
  bytes: number;
  status: string;
}

export function isTauriRuntime(): boolean {
  if (typeof window === 'undefined') return false;
  const w = window as unknown as {
    __TAURI_INTERNALS__?: { invoke?: TauriInvokeFn };
    __TAURI__?: { core?: { invoke?: TauriInvokeFn } };
  };
  return Boolean(w.__TAURI_INTERNALS__?.invoke || w.__TAURI__?.core?.invoke);
}

export async function invokeTauri<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const w = window as unknown as {
    __TAURI_INTERNALS__?: { invoke?: TauriInvokeFn };
    __TAURI__?: { core?: { invoke?: TauriInvokeFn } };
  };
  const fn = w.__TAURI__?.core?.invoke ?? w.__TAURI_INTERNALS__?.invoke;
  if (!fn) {
    throw new Error('Tauri native runtime is not attached in this browser preview.');
  }
  return fn<T>(cmd, args);
}

export async function fetchWindowsTelemetry(): Promise<TelemetrySnapshot> {
  if (isTauriRuntime()) {
    // Real PC data only: if this fails the caller keeps the previous reading.
    return invokeTauri<TelemetrySnapshot>('get_system_telemetry');
  }
  return getTelemetryProfile('windows');
}

export async function scanWindowsTargetsTauri(targets: CleanTargetInput[]): Promise<CleanScanResult[]> {
  return invokeTauri<CleanScanResult[]>('scan_windows_targets', { targets });
}

export async function cleanWindowsTargetsTauri(
  targets: CleanTargetInput[],
  dryRun: boolean,
  protectedPatterns: string[] = [],
): Promise<CleanActionReport[]> {
  return invokeTauri<CleanActionReport[]>('clean_windows_targets', {
    targets,
    dryRun,
    protectedPatterns,
  });
}

export async function runWindowsOptimizeTauri(taskId: string, dryRun: boolean): Promise<string> {
  return invokeTauri<string>('run_windows_optimize', { taskId, dryRun });
}

export async function runWingetUpgradeTauri(packageId: string, dryRun: boolean): Promise<string> {
  return invokeTauri<string>('run_winget_upgrade', { packageId, dryRun });
}

// ---- Native PC features (installed apps, updates, startup, scans) ----

export interface NativeLeftover {
  id: string;
  path: string;
  kind: string;
  sizeBytes: number;
  requiresAdmin: boolean;
}

export interface NativeApp {
  id: string;
  name: string;
  version: string;
  publisher: string;
  installLocation: string;
  binarySizeBytes: number;
  installedDaysAgo: number;
  leftovers: NativeLeftover[];
}

export interface NativeUpdate {
  id: string;
  name: string;
  version: string;
  available: string;
}

export interface NativeStartup {
  scope: string;
  name: string;
  command: string;
  publisher: string;
  enabled: boolean;
}

export interface NativeDownload {
  path: string;
  name: string;
  sizeBytes: number;
  modifiedDaysAgo: number;
}

export interface NativePurge {
  projectName: string;
  artifactType: string;
  framework: string;
  path: string;
  sizeBytes: number;
  staleDays: number;
  fileCount: number;
}

export interface NativeDiskNode {
  id: string;
  name: string;
  path: string;
  sizeBytes: number;
  kind: 'directory' | 'file';
  modifiedDaysAgo: number;
  hashGroup?: string;
  children?: NativeDiskNode[];
}

export interface NativeAnalyzeResult {
  root: NativeDiskNode;
  scannedFiles: number;
  scannedDirs: number;
  truncated: boolean;
}

export const listInstalledAppsTauri = () => invokeTauri<NativeApp[]>('list_installed_apps');
export const uninstallAppTauri = (appId: string) => invokeTauri<string>('uninstall_app', { appId });
export const listAppUpdatesTauri = () => invokeTauri<NativeUpdate[]>('list_app_updates');
export const listStartupItemsTauri = () => invokeTauri<NativeStartup[]>('list_startup_items');
export const setStartupEnabledTauri = (scope: string, name: string, enabled: boolean) =>
  invokeTauri<string>('set_startup_enabled', { scope, name, enabled });
export const scanDownloadsTauri = () => invokeTauri<NativeDownload[]>('scan_downloads');
export const scanPurgeProjectsTauri = () => invokeTauri<NativePurge[]>('scan_purge_projects');
export const analyzePathTauri = (path: string) =>
  invokeTauri<NativeAnalyzeResult>('analyze_path', { path });
export const pickFolderTauri = () => invokeTauri<string | null>('pick_folder');

// ---- Deep leftover removal (files, folders, registry keys) ----

export interface LeftoverQuery {
  appId: string;
  name: string;
  publisher: string;
  installLocation: string;
  force: boolean;
}

export interface LeftoverItem {
  kind: 'folder' | 'file' | 'registry';
  path: string;
  sizeBytes: number;
  risk: 'safe' | 'review';
}

export interface LeftoverResult {
  path: string;
  ok: boolean;
  message: string;
}

export const findAppLeftoversTauri = (query: LeftoverQuery) =>
  invokeTauri<LeftoverItem[]>('find_app_leftovers', { query });
export const deleteAppLeftoversTauri = (query: LeftoverQuery, items: LeftoverItem[]) =>
  invokeTauri<LeftoverResult[]>('delete_app_leftovers', { query, items });

export const isElevatedTauri = () => invokeTauri<boolean>('is_elevated');
export const restartAsAdminTauri = () => invokeTauri<void>('restart_as_admin');
