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
