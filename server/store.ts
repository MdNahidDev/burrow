import fs from 'node:fs/promises';
import path from 'node:path';
import type { CleanupRun, MaintenanceProfile, PersistedState, WhitelistEntry } from '../src/types/burrow.ts';

const DATA_DIR = path.join(process.cwd(), '.burrow-data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');

const GB = 1024 * 1024 * 1024;

function getDefaultState(): PersistedState {
  const now = new Date().toISOString();
  return {
    profiles: [
      {
        id: 'prof-win-monthly',
        name: 'Windows Workstation Trim',
        os: 'windows',
        description: 'Reclaims Local Temp, DirectX Shader Cache, Delivery Optimization, and stale Visual Studio/CUDA installers.',
        cleanTargetIds: ['win-user-temp', 'win-dx-shader', 'win-edge-chrome', 'win-nuget-npm', 'win-inst-cuda'],
        optimizeTaskIds: ['wo-dns', 'wo-thumb', 'wo-standby'],
        minStaleDays: 45,
        dryRunDefault: true,
        updatedAt: now,
      },
      {
        id: 'prof-win-dev-deep',
        name: 'Windows Dev & WSL2 Deep Sweep',
        os: 'windows',
        description: 'Prunes WSL2 Docker VHDX, NuGet/Cargo/npm caches, WinSxS DISM components, and stale Rust/Node builds.',
        cleanTargetIds: ['win-user-temp', 'win-update-cache', 'win-nuget-npm', 'win-wsl-docker', 'win-recycle-bin'],
        optimizeTaskIds: ['wo-dns', 'wo-dism', 'wo-standby'],
        minStaleDays: 30,
        dryRunDefault: true,
        updatedAt: now,
      },
      {
        id: 'prof-mac-weekly',
        name: 'macOS Weekly Dev Sweep',
        os: 'macos',
        description: 'Clears Xcode DerivedData, Homebrew bottles, browser caches, and stale node_modules (>30d).',
        cleanTargetIds: ['mac-xcode-derived', 'mac-homebrew-cache', 'mac-chrome-cache', 'mac-pnpm-store', 'mac-inst-xcode'],
        optimizeTaskIds: ['mo-dns', 'mo-quicklook'],
        minStaleDays: 30,
        dryRunDefault: true,
        updatedAt: now,
      },
      {
        id: 'prof-host-safe',
        name: 'Host Container Cache Trim',
        os: 'host',
        description: 'Targets temporary build caches and /tmp artifacts on the live Linux runtime host.',
        cleanTargetIds: [],
        optimizeTaskIds: [],
        minStaleDays: 14,
        dryRunDefault: true,
        updatedAt: now,
      },
    ],
    whitelist: [
      {
        id: 'wl-mac-safari',
        os: 'macos',
        pattern: '~/Library/Caches/com.apple.Safari*',
        reason: 'Preserve active Safari session caches and offline reading list',
        createdAt: now,
      },
      {
        id: 'wl-mac-docker',
        os: 'macos',
        pattern: 'Docker.raw',
        reason: 'Protect active local container volumes from automated sweeps',
        createdAt: now,
      },
      {
        id: 'wl-win-steam',
        os: 'windows',
        pattern: '*Steam*shadercache*',
        reason: 'Avoid shader recompilation stutter in installed titles',
        createdAt: now,
      },
      {
        id: 'wl-all-env',
        os: 'all',
        pattern: '*.env*',
        reason: 'Never touch environment secrets or credential files',
        createdAt: now,
      },
    ],
    history: [
      {
        id: 'run-seed-1',
        os: 'macos',
        mode: 'dry-run',
        summary: 'Previewed macOS Weekly Dev Sweep (Xcode DerivedData + Homebrew + Chrome)',
        itemCount: 5,
        reclaimedBytes: 39.8 * GB,
        timestamp: new Date(Date.now() - 3 * 86400000).toISOString(),
        commandSnippet: 'burrow-clean-macos.sh --dry-run',
      },
      {
        id: 'run-seed-2',
        os: 'windows',
        mode: 'script-export',
        summary: 'Exported Windows PowerShell cleanup + winget batch upgrade bundle',
        itemCount: 7,
        reclaimedBytes: 26.5 * GB,
        timestamp: new Date(Date.now() - 86400000).toISOString(),
        commandSnippet: '.\\burrow-clean-windows.ps1 -DryRun',
      },
    ],
  };
}

async function ensureStateFile(): Promise<PersistedState> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    const raw = await fs.readFile(STATE_FILE, 'utf8');
    const parsed = JSON.parse(raw) as PersistedState;
    if (parsed && Array.isArray(parsed.profiles) && Array.isArray(parsed.whitelist) && Array.isArray(parsed.history)) {
      return parsed;
    }
  } catch {
    // Initialize default state
  }
  const initial = getDefaultState();
  await fs.writeFile(STATE_FILE, JSON.stringify(initial, null, 2), 'utf8');
  return initial;
}

async function writeState(state: PersistedState): Promise<PersistedState> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
  return state;
}

export async function readState(): Promise<PersistedState> {
  return ensureStateFile();
}

export async function saveProfile(profile: MaintenanceProfile): Promise<PersistedState> {
  const state = await ensureStateFile();
  const idx = state.profiles.findIndex((p) => p.id === profile.id);
  if (idx >= 0) {
    state.profiles[idx] = profile;
  } else {
    state.profiles.unshift(profile);
  }
  return writeState(state);
}

export async function deleteProfile(id: string): Promise<PersistedState> {
  const state = await ensureStateFile();
  state.profiles = state.profiles.filter((p) => p.id !== id);
  return writeState(state);
}

export async function addWhitelistEntry(entry: WhitelistEntry): Promise<PersistedState> {
  const state = await ensureStateFile();
  const exists = state.whitelist.some(
    (w) => w.pattern.toLowerCase() === entry.pattern.toLowerCase() && w.os === entry.os,
  );
  if (!exists) {
    state.whitelist.unshift(entry);
  }
  return writeState(state);
}

export async function deleteWhitelistEntry(id: string): Promise<PersistedState> {
  const state = await ensureStateFile();
  state.whitelist = state.whitelist.filter((w) => w.id !== id);
  return writeState(state);
}

export async function appendHistory(run: CleanupRun): Promise<PersistedState> {
  const state = await ensureStateFile();
  state.history.unshift(run);
  state.history = state.history.slice(0, 50);
  return writeState(state);
}
