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
    try {
      return await invokeTauri<TelemetrySnapshot>('get_system_telemetry');
    } catch {
      return getTelemetryProfile('windows');
    }
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
