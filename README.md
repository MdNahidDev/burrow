# Burrow — Windows PC cleaner & storage studio

React + TypeScript UI, optional local Express server, and a Tauri (Rust) desktop shell.

## Run in the browser (any OS, demo data)
```
npm install
npm run dev        # http://127.0.0.1:3000
```

## Build the Windows desktop app (.exe / installer)
Requires Node.js 20+, Rust (`winget install Rustlang.Rustup`) and the MSVC Build Tools + WebView2.
```
npm install
npm run tauri build
```
Installers appear in `src-tauri\target\release\bundle\`.
`npm run tauri dev` runs the native app with hot reload.

## Safety
The native cleaner only deletes inside an allowlist of cache/temp folders, never touches
virtual disks (.vhdx etc.), `.ssh`, Documents/Desktop/Pictures, and honours your protected
rules (`*` / `?` wildcards). Always use Dry-run first.

## What is real in the installed Windows app
- **Apps**: lists your real installed programs (from the Windows registry) and real update availability.
  Uninstall opens the program's own uninstaller, then Burrow searches for leftover files and
  registry keys and lets you review and delete them (registry keys are backed up first to
  `%LOCALAPPDATA%\Burrow\RegistryBackups`).
- **Deep Clean**: scans your real temp/cache folders, big installers in Downloads and developer
  build folders (node_modules, target, ...).
- **Analyzer**: maps a real folder on your PC (choose any folder with the picker).
- **Startup**: real startup programs; turning one off/on changes the same switch Task Manager uses.
- Some items (Windows Update cache, system startup items) need **Run as administrator**.

## New in this version
- **Clean** finds each app's caches on your PC: every Chrome, Edge and Brave profile, Firefox, Steam, Discord,
  Slack, VS Code, Cursor, package managers and Windows temp/crash/shader caches. It shows when an app
  (for example Chrome) is open, with a **Close it** button, keeps temp files from the last 3 days, and can
  empty the Recycle Bin. Only folders Burrow itself discovered can be deleted.
- **Analyze**: right-click any tile or row for *Copy path*, *Open in File Explorer*, *Move to Recycle Bin* or
  *Delete permanently* (both ask first). Rows show their share of the folder as a bar.
- **Duplicates**: files are compared by content (not name). Tick the copies you want to remove; one copy of
  each file is always kept, and every file is re-checked right before it is deleted.
- **Apps**: real program icons are shown for installed programs and startup items.
