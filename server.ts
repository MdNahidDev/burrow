import { ZipArchive, type ArchiverError } from 'archiver';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { createServer as createViteServer } from 'vite';
import {
  executeSafeHostClean,
  getLiveHostTelemetry,
  scanLiveHostWorkspace,
} from './server/hostInspector.ts';
import { buildScriptBundle, type ScriptGenerationRequest } from './server/scriptGenerator.ts';
import {
  addWhitelistEntry,
  appendHistory,
  deleteProfile,
  deleteWhitelistEntry,
  readState,
  saveProfile,
} from './server/store.ts';
import type { CleanupRun, MaintenanceProfile, WhitelistEntry } from './src/types/burrow.ts';

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '2mb' }));

  // Live host telemetry
  app.get('/api/telemetry', async (_req, res) => {
    try {
      const snapshot = await getLiveHostTelemetry();
      res.json(snapshot);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Telemetry unavailable' });
    }
  });

  // Live host filesystem & project scan
  app.get('/api/host-scan', async (_req, res) => {
    try {
      const result = await scanLiveHostWorkspace();
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Host scan failed' });
    }
  });

  // Safe scoped host clean (strictly Vite cache / dist with dry-run support)
  app.post('/api/host-clean', async (req, res) => {
    try {
      const { targetIds, dryRun } = req.body as { targetIds?: string[]; dryRun?: boolean };
      if (!Array.isArray(targetIds)) {
        res.status(400).json({ error: 'targetIds array is required' });
        return;
      }
      const outcome = await executeSafeHostClean(targetIds, Boolean(dryRun));
      await appendHistory({
        id: `run-${Date.now()}`,
        os: 'host',
        mode: dryRun ? 'dry-run' : 'host-clean',
        summary: `${dryRun ? 'Dry-run verified' : 'Cleaned'} ${outcome.results.length} host workspace target(s)`,
        itemCount: outcome.results.length,
        reclaimedBytes: outcome.reclaimedBytes,
        timestamp: new Date().toISOString(),
        commandSnippet: dryRun ? 'burrow host-clean --dry-run' : 'burrow host-clean --execute',
      });
      res.json(outcome);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Host clean failed' });
    }
  });

  // Persisted profiles, whitelist, and audit history
  app.get('/api/state', async (_req, res) => {
    try {
      const state = await readState();
      res.json(state);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to load state' });
    }
  });

  app.post('/api/profiles', async (req, res) => {
    try {
      const body = req.body as Partial<MaintenanceProfile>;
      if (!body.name || !body.os) {
        res.status(400).json({ error: 'Profile name and os are required' });
        return;
      }
      const profile: MaintenanceProfile = {
        id: body.id || `prof-${Date.now()}`,
        name: body.name.trim(),
        os: body.os,
        description: body.description?.trim() || 'Custom maintenance preset',
        cleanTargetIds: Array.isArray(body.cleanTargetIds) ? body.cleanTargetIds : [],
        optimizeTaskIds: Array.isArray(body.optimizeTaskIds) ? body.optimizeTaskIds : [],
        minStaleDays: typeof body.minStaleDays === 'number' ? body.minStaleDays : 30,
        dryRunDefault: body.dryRunDefault ?? true,
        updatedAt: new Date().toISOString(),
      };
      const updated = await saveProfile(profile);
      res.json(updated);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to save profile' });
    }
  });

  app.delete('/api/profiles/:id', async (req, res) => {
    try {
      const updated = await deleteProfile(req.params.id);
      res.json(updated);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to delete profile' });
    }
  });

  app.post('/api/whitelist', async (req, res) => {
    try {
      const body = req.body as Partial<WhitelistEntry>;
      if (!body.pattern || !body.os) {
        res.status(400).json({ error: 'Whitelist pattern and os are required' });
        return;
      }
      const entry: WhitelistEntry = {
        id: body.id || `wl-${Date.now()}`,
        os: body.os,
        pattern: body.pattern.trim(),
        reason: body.reason?.trim() || 'User-protected path',
        createdAt: new Date().toISOString(),
      };
      const updated = await addWhitelistEntry(entry);
      res.json(updated);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to update whitelist' });
    }
  });

  app.delete('/api/whitelist/:id', async (req, res) => {
    try {
      const updated = await deleteWhitelistEntry(req.params.id);
      res.json(updated);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to remove whitelist entry' });
    }
  });

  app.post('/api/history', async (req, res) => {
    try {
      const body = req.body as Partial<CleanupRun>;
      if (!body.summary || !body.os) {
        res.status(400).json({ error: 'History summary and os are required' });
        return;
      }
      const updated = await appendHistory({
        id: `run-${Date.now()}`,
        os: body.os,
        mode: body.mode || 'dry-run',
        summary: body.summary,
        itemCount: Number(body.itemCount || 0),
        reclaimedBytes: Number(body.reclaimedBytes || 0),
        timestamp: new Date().toISOString(),
        commandSnippet: body.commandSnippet || '',
      });
      res.json(updated);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to record run' });
    }
  });

  app.post('/api/scripts/generate', (req, res) => {
    try {
      const payload = req.body as ScriptGenerationRequest;
      const bundle = buildScriptBundle(payload);
      res.json(bundle);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to generate script' });
    }
  });

  // Download turnkey Burrow for Windows bundle (.zip)
  app.get('/api/download/burrow-windows.zip', (_req, res) => {
    const rootDir = process.cwd();
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="Burrow-Windows.zip"');

    const archive = new ZipArchive({ zlib: { level: 9 } });
    archive.on('error', (err: ArchiverError) => {
      if (!res.headersSent) {
        res.status(500).json({ error: err.message });
      } else {
        res.end();
      }
    });
    archive.pipe(res);

    const singleFiles = [
      'index.html',
      'package.json',
      'tsconfig.json',
      'vite.config.ts',
      'metadata.json',
      'server.ts',
      '.env.example',
    ];
    for (const file of singleFiles) {
      const fullPath = path.join(rootDir, file);
      if (fs.existsSync(fullPath)) {
        archive.file(fullPath, { name: `Burrow-Windows/${file}` });
      }
    }

    for (const dir of ['src', 'server']) {
      const fullDir = path.join(rootDir, dir);
      if (fs.existsSync(fullDir)) {
        archive.directory(fullDir, `Burrow-Windows/${dir}`);
      }
    }

    for (const dir of ['public', 'dist']) {
      const fullDir = path.join(rootDir, dir);
      if (fs.existsSync(fullDir)) {
        archive.glob(
          '**/*',
          { cwd: fullDir, ignore: ['**/aistudio/**'], nodir: true },
          { prefix: `Burrow-Windows/${dir}` },
        );
      }
    }

    const tauriDir = path.join(rootDir, 'src-tauri');
    if (fs.existsSync(tauriDir)) {
      archive.glob('**/*', {
        cwd: tauriDir,
        ignore: ['target/**', 'gen/**'],
        dot: true,
        nodir: true,
      }, { prefix: 'Burrow-Windows/src-tauri' });
    }

    const startBat = [
      '@echo off',
      'setlocal',
      'cd /d "%~dp0"',
      'title Burrow for Windows',
      'where node >nul 2>&1',
      'if errorlevel 1 (',
      '  echo Node.js was not found. Installing Node.js LTS via Windows Package Manager...',
      '  winget install --id OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements',
      '  echo Please close this window and double-click Start Burrow Desktop.bat again.',
      '  pause',
      '  exit /b 1',
      ')',
      'if not exist "node_modules" (',
      '  echo Installing local Burrow dependencies (first launch only)...',
      '  call npm install',
      ')',
      'start "" /b cmd /c "call npm run dev"',
      'timeout /t 3 /nobreak >nul',
      'where msedge >nul 2>&1',
      'if not errorlevel 1 (',
      '  start "" msedge --app=http://127.0.0.1:3000',
      ') else (',
      '  start "" http://127.0.0.1:3000',
      ')',
    ].join('\r\n');

    const buildExeBat = [
      '@echo off',
      'setlocal',
      'cd /d "%~dp0"',
      'title Build Native Burrow Windows App (.exe)',
      'where node >nul 2>&1',
      'if errorlevel 1 (',
      '  echo Missing Node.js. Install with: winget install OpenJS.NodeJS.LTS',
      '  pause',
      '  exit /b 1',
      ')',
      'where cargo >nul 2>&1',
      'if errorlevel 1 (',
      '  echo Missing Rust compiler. Install with: winget install Rustlang.Rustup',
      '  pause',
      '  exit /b 1',
      ')',
      'if not exist "node_modules" call npm install',
      'call npm run build',
      'call npx --yes @tauri-apps/cli@2 build',
      'if exist "src-tauri\\target\\release\\bundle" (',
      '  echo.',
      '  echo Build complete! Opening installer folder...',
      '  start "" "src-tauri\\target\\release\\bundle"',
      ')',
      'pause',
    ].join('\r\n');

    const readmeTxt = [
      'BURROW FOR WINDOWS - OFFLINE DESKTOP APP',
      '=======================================',
      '',
      'OPTION 1: Build a Native Standalone Windows Installer (.exe / .msi)',
      '  Requirements: Node.js + Rust (MSVC Build Tools / WebView2)',
      '  1. Extract this ZIP anywhere on your Windows PC.',
      '  2. Double-click "Build Native Windows App (.exe).bat".',
      '  3. Run the generated setup .exe inside src-tauri\\target\\release\\bundle\\nsis\\',
      '     (or standalone burrow.exe in src-tauri\\target\\release\\burrow.exe).',
      '',
      'OPTION 2: Launch Offline Desktop Window Immediately (Node.js only)',
      '  1. Extract this ZIP anywhere on your Windows PC.',
      '  2. Double-click "Start Burrow Desktop.bat".',
      '',
    ].join('\r\n');

    archive.append(startBat, { name: 'Burrow-Windows/Start Burrow Desktop.bat' });
    archive.append(buildExeBat, { name: 'Burrow-Windows/Build Native Windows App (.exe).bat' });
    archive.append(readmeTxt, { name: 'Burrow-Windows/README-Windows.txt' });

    archive.finalize();
  });

  const isProd = process.env.NODE_ENV === 'production';
  const distDir = path.resolve(process.cwd(), 'dist');

  if (isProd && fs.existsSync(distDir)) {
    app.use(express.static(distDir));
    app.use((req, res, next) => {
      if (req.method !== 'GET' || req.path.startsWith('/api/')) {
        next();
        return;
      }
      res.sendFile(path.join(distDir, 'index.html'));
    });
  } else {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  const port = Number(process.env.PORT || 3000);
  // Bind to loopback only: this server exposes file-cleaning endpoints with no auth.
  // Set HOST=0.0.0.0 explicitly (e.g. in a container) if you really need remote access.
  const host = process.env.HOST || '127.0.0.1';
  app.listen(port, host, () => {
    console.log(`Burrow server listening on http://${host}:${port}`);
  });
}

startServer();
