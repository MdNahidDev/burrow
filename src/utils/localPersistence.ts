import type { CleanupRun, MaintenanceProfile, PersistedState, WhitelistEntry } from '../types/burrow';

const STORAGE_KEY = 'burrow_windows_local_state_v1';

const DEFAULT_LOCAL_STATE: PersistedState = {
  profiles: [
    {
      id: 'prof-win-monthly',
      name: 'Windows Monthly Trim',
      os: 'windows',
      description: 'Clears Local Temp, DirectX Shader Cache, Edge/Chrome cache, and old setup files.',
      cleanTargetIds: ['win-user-temp', 'win-dx-shader', 'win-edge-chrome', 'win-nuget-npm', 'win-inst-cuda'],
      optimizeTaskIds: ['wo-dns', 'wo-thumb', 'wo-standby'],
      minStaleDays: 30,
      dryRunDefault: true,
      updatedAt: '2026-11-01T10:00:00.000Z',
    },
    {
      id: 'prof-win-deep',
      name: 'Deep System & WSL Clean',
      os: 'windows',
      description: 'Includes Windows Update cache, Delivery Optimization, and stale project clutter.',
      cleanTargetIds: ['win-user-temp', 'win-update-cache', 'win-delivery-opt', 'win-dx-shader', 'win-wsl-docker'],
      optimizeTaskIds: ['wo-dns', 'wo-thumb', 'wo-dism', 'wo-standby'],
      minStaleDays: 45,
      dryRunDefault: true,
      updatedAt: '2026-11-10T14:20:00.000Z',
    },
  ],
  whitelist: [
    {
      id: 'wl-win-steam',
      pattern: '*Steam*shadercache*',
      reason: 'Preserve compiled Vulkan/DirectX game shaders to avoid in-game stutter',
      os: 'windows',
      createdAt: '2026-11-01T10:05:00.000Z',
    },
    {
      id: 'wl-win-ssh',
      pattern: '*\\.ssh\\*',
      reason: 'Never touch local SSH keys or known_hosts',
      os: 'windows',
      createdAt: '2026-11-02T09:15:00.000Z',
    },
  ],
  history: [
    {
      id: 'run-win-init',
      timestamp: '2026-11-20T16:30:00.000Z',
      os: 'windows',
      mode: 'dry-run',
      summary: 'Verified Windows Monthly Trim',
      itemCount: 5,
      reclaimedBytes: 26.5 * 1024 * 1024 * 1024,
      commandSnippet: 'Safe dry-run check across 5 temp and cache locations',
    },
  ],
};

export function loadLocalState(): PersistedState {
  if (typeof window === 'undefined') return DEFAULT_LOCAL_STATE;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(DEFAULT_LOCAL_STATE));
      return DEFAULT_LOCAL_STATE;
    }
    const parsed = JSON.parse(raw) as Partial<PersistedState>;
    const profiles = Array.isArray(parsed.profiles)
      ? parsed.profiles.filter(
          (p): p is MaintenanceProfile =>
            Boolean(
              p &&
                typeof p.id === 'string' &&
                typeof p.name === 'string' &&
                Array.isArray(p.cleanTargetIds) &&
                Array.isArray(p.optimizeTaskIds) &&
                typeof p.minStaleDays === 'number',
            ),
        )
      : DEFAULT_LOCAL_STATE.profiles;
    const whitelist = Array.isArray(parsed.whitelist)
      ? parsed.whitelist.filter(
          (w): w is WhitelistEntry =>
            Boolean(w && typeof w.id === 'string' && typeof w.pattern === 'string'),
        )
      : DEFAULT_LOCAL_STATE.whitelist;
    const history = Array.isArray(parsed.history)
      ? parsed.history.filter(
          (h): h is CleanupRun =>
            Boolean(
              h &&
                typeof h.id === 'string' &&
                typeof h.summary === 'string' &&
                typeof h.reclaimedBytes === 'number',
            ),
        )
      : DEFAULT_LOCAL_STATE.history;
    return { profiles, whitelist, history };
  } catch {
    return DEFAULT_LOCAL_STATE;
  }
}

export function saveLocalState(next: PersistedState): PersistedState {
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Ignore storage quota errors
    }
  }
  return next;
}

export function addLocalProfile(
  state: PersistedState,
  input: Omit<MaintenanceProfile, 'id' | 'updatedAt'>,
): PersistedState {
  const created: MaintenanceProfile = {
    ...input,
    id: `prof-${Date.now()}`,
    updatedAt: new Date().toISOString(),
  };
  return saveLocalState({
    ...state,
    profiles: [created, ...state.profiles],
  });
}

export function deleteLocalProfile(state: PersistedState, id: string): PersistedState {
  return saveLocalState({
    ...state,
    profiles: state.profiles.filter((p) => p.id !== id),
  });
}

export function addLocalWhitelist(
  state: PersistedState,
  input: Omit<WhitelistEntry, 'id' | 'createdAt'>,
): PersistedState {
  const created: WhitelistEntry = {
    ...input,
    id: `wl-${Date.now()}`,
    createdAt: new Date().toISOString(),
  };
  return saveLocalState({
    ...state,
    whitelist: [created, ...state.whitelist],
  });
}

export function deleteLocalWhitelist(state: PersistedState, id: string): PersistedState {
  return saveLocalState({
    ...state,
    whitelist: state.whitelist.filter((w) => w.id !== id),
  });
}

export function addLocalHistory(
  state: PersistedState,
  input: Omit<CleanupRun, 'id' | 'timestamp'>,
): PersistedState {
  const created: CleanupRun = {
    ...input,
    id: `run-${Date.now()}`,
    timestamp: new Date().toISOString(),
  };
  return saveLocalState({
    ...state,
    history: [created, ...state.history].slice(0, 40),
  });
}
