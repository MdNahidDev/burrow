import type {
  CleanTarget,
  InstalledApp,
  OptimizeTask,
  OsTarget,
  PurgeProject,
  ScriptBundle,
  StartupItem,
  WhitelistEntry,
} from '../src/types/burrow.ts';

export interface ScriptGenerationRequest {
  os: OsTarget;
  format?: 'auto' | 'bash' | 'powershell' | 'rust';
  dryRun: boolean;
  cleanTargets: CleanTarget[];
  uninstallApps: InstalledApp[];
  upgradeApps: InstalledApp[];
  purgeProjects: PurgeProject[];
  optimizeTasks: OptimizeTask[];
  startupChanges: StartupItem[];
  whitelist: WhitelistEntry[];
}

function escapeRustStr(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function buildRustCrateBundle(
  req: ScriptGenerationRequest,
  totalBytes: number,
  itemCount: number,
  requiresAdmin: boolean,
): ScriptBundle {
  const whitelistPatterns = req.whitelist
    .filter((w) => w.os === req.os || w.os === 'all')
    .map((w) => `    "${escapeRustStr(w.pattern)}",`)
    .join('\n');

  const cleanEntries = req.cleanTargets
    .map(
      (c) =>
        `    CleanTarget {\n        title: "${escapeRustStr(c.title)}",\n        path: "${escapeRustStr(c.path)}",\n        command: "${escapeRustStr(c.commandPreview)}",\n        requires_admin: ${c.requiresAdmin},\n    },`,
    )
    .join('\n');

  const purgeEntries = req.purgeProjects
    .map(
      (p) =>
        `    PurgeTarget {\n        project: "${escapeRustStr(p.projectName)}",\n        artifact: "${escapeRustStr(p.artifactType)}",\n        path: "${escapeRustStr(p.path)}",\n        stale_days: ${p.staleDays},\n    },`,
    )
    .join('\n');

  const uninstallEntries = req.uninstallApps
    .flatMap((app) =>
      app.leftovers.map(
        (l) =>
          `    LeftoverTarget {\n        app: "${escapeRustStr(app.name)}",\n        kind: "${escapeRustStr(l.kind)}",\n        path: "${escapeRustStr(l.path)}",\n        requires_admin: ${l.requiresAdmin},\n    },`,
      ),
    )
    .join('\n');

  const optimizeEntries = req.optimizeTasks
    .map(
      (o) =>
        `    OptimizeCommand {\n        title: "${escapeRustStr(o.title)}",\n        command: "${escapeRustStr(o.command)}",\n        requires_admin: ${o.requiresAdmin},\n    },`,
    )
    .join('\n');

  const cargoToml = `[package]
name = "burrow-rs"
version = "0.1.0"
edition = "2021"
description = "Cross-platform macOS & Windows system cleaner, disk analyzer, and dev purge CLI in pure Rust"

[profile.release]
opt-level = "z"
lto = true
strip = true
`;

  const mainRs = `// burrow-rs: Pure Rust replacement for Mole (macOS + Windows)
// Zero third-party dependencies — builds anywhere with \`rustc --edition 2021 -O main.rs\` or \`cargo build --release\`
// Usage:
//   burrow-rs --dry-run      Preview all clean, purge, uninstall, and optimize steps
//   burrow-rs --execute      Apply selected operations safely (honors whitelist)
//   burrow-rs --analyze DIR  Walk DIR and print top largest entries in pure Rust

use std::env;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::process::Command;

struct CleanTarget {
    title: &'static str,
    path: &'static str,
    command: &'static str,
    requires_admin: bool,
}

struct PurgeTarget {
    project: &'static str,
    artifact: &'static str,
    path: &'static str,
    stale_days: u32,
}

struct LeftoverTarget {
    app: &'static str,
    kind: &'static str,
    path: &'static str,
    requires_admin: bool,
}

struct OptimizeCommand {
    title: &'static str,
    command: &'static str,
    requires_admin: bool,
}

const WHITELIST: &[&str] = &[
${whitelistPatterns}
];

const CLEAN_TARGETS: &[CleanTarget] = &[
${cleanEntries}
];

const PURGE_TARGETS: &[PurgeTarget] = &[
${purgeEntries}
];

const UNINSTALL_LEFTOVERS: &[LeftoverTarget] = &[
${uninstallEntries}
];

const OPTIMIZE_COMMANDS: &[OptimizeCommand] = &[
${optimizeEntries}
];

fn expand_path(raw: &str) -> PathBuf {
    let home = env::var("USERPROFILE")
        .or_else(|_| env::var("HOME"))
        .unwrap_or_else(|_| ".".to_string());
    let mut expanded = raw.replace("~", &home);
    if let Ok(local_app_data) = env::var("LOCALAPPDATA") {
        expanded = expanded.replace("%LOCALAPPDATA%", &local_app_data);
    }
    if let Ok(app_data) = env::var("APPDATA") {
        expanded = expanded.replace("%APPDATA%", &app_data);
    }
    if let Ok(user_profile) = env::var("USERPROFILE") {
        expanded = expanded.replace("%USERPROFILE%", &user_profile);
    }
    if let Ok(temp_dir) = env::var("TEMP") {
        expanded = expanded.replace("%TEMP%", &temp_dir);
    }
    if let Ok(windir) = env::var("WINDIR") {
        expanded = expanded.replace("%WINDIR%", &windir);
    }
    PathBuf::from(expanded)
}

fn is_whitelisted(target: &str) -> bool {
    let lower = target.to_lowercase();
    WHITELIST.iter().any(|pattern| {
        let needle = pattern.trim_matches('*').to_lowercase();
        !needle.is_empty() && lower.contains(&needle)
    })
}

fn format_bytes(bytes: u64) -> String {
    const UNITS: [&str; 5] = ["B", "KB", "MB", "GB", "TB"];
    let mut size = bytes as f64;
    let mut unit = 0;
    while size >= 1024.0 && unit < UNITS.len() - 1 {
        size /= 1024.0;
        unit += 1;
    }
    if unit == 0 {
        format!("{} B", bytes)
    } else {
        format!("{:.1} {}", size, UNITS[unit])
    }
}

fn dir_size(path: &Path) -> u64 {
    let Ok(meta) = fs::symlink_metadata(path) else {
        return 0;
    };
    if meta.file_type().is_symlink() {
        return 0;
    }
    if meta.is_file() {
        return meta.len();
    }
    let mut total = 0u64;
    if let Ok(entries) = fs::read_dir(path) {
        for entry in entries.flatten() {
            total = total.saturating_add(dir_size(&entry.path()));
        }
    }
    total
}

fn analyze_dir(target: &Path) -> io::Result<()> {
    println!("[ANALYZE] Scanning {}", target.display());
    let mut items: Vec<(String, u64)> = Vec::new();
    for entry in fs::read_dir(target)? {
        let entry = entry?;
        let path = entry.path();
        let size = dir_size(&path);
        items.push((entry.file_name().to_string_lossy().to_string(), size));
    }
    items.sort_by(|a, b| b.1.cmp(&a.1));
    for (name, size) in items.into_iter().take(20) {
        println!("  {:>10}  {}", format_bytes(size), name);
    }
    Ok(())
}

fn run_shell_command(cmd: &str) -> io::Result<()> {
    #[cfg(target_os = "windows")]
    let status = Command::new("powershell")
        .args(["-NoProfile", "-Command", cmd])
        .status()?;

    #[cfg(not(target_os = "windows"))]
    let status = Command::new("sh")
        .args(["-c", cmd])
        .status()?;

    if !status.success() {
        eprintln!("  [WARN] Command exited with status: {}", status);
    }
    Ok(())
}

fn main() {
    let args: Vec<String> = env::args().collect();
    if let Some(pos) = args.iter().position(|a| a == "--analyze") {
        let target = args.get(pos + 1).map(PathBuf::from).unwrap_or_else(|| PathBuf::from("."));
        if let Err(err) = analyze_dir(&target) {
            eprintln!("Analyze failed: {}", err);
            std::process::exit(1);
        }
        return;
    }

    let dry_run = if args.iter().any(|a| a == "--execute") {
        false
    } else if args.iter().any(|a| a == "--dry-run") {
        true
    } else {
        ${req.dryRun}
    };

    println!("burrow-rs (target=${req.os}, dry_run={})", dry_run);

    for target in CLEAN_TARGETS {
        if is_whitelisted(target.path) {
            println!("[SKIP-WHITELIST] {} ({})", target.title, target.path);
            continue;
        }
        let resolved = expand_path(target.path);
        if dry_run {
            println!(
                "[DRY-RUN] {} [admin={}] -> {} (resolved: {})",
                target.title,
                target.requires_admin,
                target.command,
                resolved.display()
            );
        } else {
            println!("[EXEC] {}", target.title);
            let _ = run_shell_command(target.command);
        }
    }

    for purge in PURGE_TARGETS {
        if is_whitelisted(purge.path) {
            println!("[SKIP-WHITELIST] {} ({})", purge.project, purge.path);
            continue;
        }
        let resolved = expand_path(purge.path);
        if dry_run {
            println!(
                "[DRY-RUN] Purge {} ({}, {}d stale) -> {}",
                purge.project,
                purge.artifact,
                purge.stale_days,
                resolved.display()
            );
        } else if resolved.exists() {
            println!("[EXEC] Removing {}", resolved.display());
            if let Err(err) = fs::remove_dir_all(&resolved) {
                eprintln!("  [WARN] {}", err);
            }
        }
    }

    for leftover in UNINSTALL_LEFTOVERS {
        if is_whitelisted(leftover.path) {
            println!("[SKIP-WHITELIST] {} ({})", leftover.app, leftover.path);
            continue;
        }
        let resolved = expand_path(leftover.path);
        if dry_run {
            println!(
                "[DRY-RUN] Uninstall {} [{} / admin={}] -> {}",
                leftover.app,
                leftover.kind,
                leftover.requires_admin,
                resolved.display()
            );
        } else if leftover.kind == "Registry" {
            println!("[EXEC] Deleting registry key {}", leftover.path);
            let _ = run_shell_command(&format!("reg delete \"{}\" /f", leftover.path));
        } else if leftover.kind == "ScheduledTask" {
            let task_name = leftover.path.split('\\\\').last().unwrap_or(leftover.path);
            println!("[EXEC] Disabling scheduled task {}", task_name);
            let _ = run_shell_command(&format!("Disable-ScheduledTask -TaskName \"{}\"", task_name));
        } else if resolved.exists() {
            println!("[EXEC] Removing leftover {}", resolved.display());
            let _ = if resolved.is_dir() {
                fs::remove_dir_all(&resolved)
            } else {
                fs::remove_file(&resolved)
            };
        }
    }

    for opt in OPTIMIZE_COMMANDS {
        if dry_run {
            println!(
                "[DRY-RUN] Optimize {} [admin={}] -> {}",
                opt.title, opt.requires_admin, opt.command
            );
        } else {
            println!("[EXEC] Optimize {}", opt.title);
            let _ = run_shell_command(opt.command);
        }
    }
}
`;

  return {
    filename: 'main.rs',
    language: 'rust',
    content: mainRs,
    cargoToml,
    itemCount,
    estimatedBytes: totalBytes,
    requiresAdmin,
  };
}

export function buildScriptBundle(req: ScriptGenerationRequest): ScriptBundle {
  const totalBytes =
    req.cleanTargets.reduce((s, i) => s + i.sizeBytes, 0) +
    req.purgeProjects.reduce((s, i) => s + i.sizeBytes, 0) +
    req.uninstallApps.reduce((s, a) => s + a.leftovers.reduce((ls, l) => ls + l.sizeBytes, 0), 0);

  const itemCount =
    req.cleanTargets.length +
    req.uninstallApps.length +
    req.upgradeApps.length +
    req.purgeProjects.length +
    req.optimizeTasks.length +
    req.startupChanges.length;

  const requiresAdmin =
    req.cleanTargets.some((c) => c.requiresAdmin) ||
    req.optimizeTasks.some((o) => o.requiresAdmin) ||
    req.startupChanges.some((s) => s.requiresAdmin) ||
    req.uninstallApps.some((a) => a.leftovers.some((l) => l.requiresAdmin));

  if (req.format === 'rust') {
    return buildRustCrateBundle(req, totalBytes, itemCount, requiresAdmin);
  }

  const effectiveWindows = req.format === 'powershell' || (req.format !== 'bash' && req.os === 'windows');

  if (effectiveWindows) {
    const lines: string[] = [
      '<#',
      '  Burrow — Windows Maintenance & Deep Clean Script',
      `  Generated: ${new Date().toISOString()}`,
      '  Usage: .\\burrow-maintenance.ps1 -DryRun   (Preview without deleting)',
      '         .\\burrow-maintenance.ps1           (Execute selected operations)',
      '#>',
      'param(',
      `  [switch]$DryRun = $${req.dryRun ? 'true' : 'false'}`,
      ')',
      '',
      '$ErrorActionPreference = "SilentlyContinue"',
      '',
      '$Whitelist = @(',
      ...req.whitelist
        .filter((w) => w.os === 'windows' || w.os === 'all')
        .map((w) => `  "${w.pattern.replace(/"/g, '`"')}"`),
      ')',
      '',
      'function Test-Whitelisted([string]$TargetPath) {',
      '  foreach ($pattern in $Whitelist) {',
      '    if ($TargetPath -like $pattern) { return $true }',
      '  }',
      '  return $false',
      '}',
      '',
      'function Invoke-BurrowStep([string]$Label, [string]$CommandText, [string]$PathCheck = "") {',
      '  if ($PathCheck -and (Test-Whitelisted $PathCheck)) {',
      '    Write-Host "[SKIP-WHITELIST] $Label ($PathCheck)" -ForegroundColor Yellow',
      '    return',
      '  }',
      '  if ($DryRun) {',
      '    Write-Host "[DRY-RUN] $Label -> $CommandText" -ForegroundColor Cyan',
      '  } else {',
      '    Write-Host "[EXEC] $Label" -ForegroundColor Green',
      '    Invoke-Expression $CommandText',
      '  }',
      '}',
      '',
    ];

    if (requiresAdmin) {
      lines.push(
        '$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)',
        'if (-not $isAdmin) {',
        '  Write-Warning "Some selected tasks require elevated Administrator privileges."',
        '}',
        '',
      );
    }

    if (req.cleanTargets.length > 0) {
      lines.push('# --- Deep Clean & Orphaned Installers ---');
      for (const c of req.cleanTargets) {
        const escapedCmd = c.commandPreview.replace(/"/g, '`"');
        const escapedPath = c.path.replace(/"/g, '`"');
        lines.push(`Invoke-BurrowStep "${c.title}" "${escapedCmd}" "${escapedPath}"`);
      }
      lines.push('');
    }

    if (req.purgeProjects.length > 0) {
      lines.push('# --- Developer Artifact Purge ---');
      for (const p of req.purgeProjects) {
        const cmd = `Remove-Item "${p.path}" -Recurse -Force -ErrorAction SilentlyContinue`;
        lines.push(`Invoke-BurrowStep "Purge ${p.projectName} (${p.artifactType})" "${cmd.replace(/"/g, '`"')}" "${p.path.replace(/"/g, '`"')}"`);
      }
      lines.push('');
    }

    if (req.uninstallApps.length > 0) {
      lines.push('# --- Smart App Uninstall & Residue Cleanup ---');
      for (const app of req.uninstallApps) {
        for (const leftover of app.leftovers) {
          const cmd =
            leftover.kind === 'Registry'
              ? `Remove-Item -Path "Registry::${leftover.path}" -Recurse -Force`
              : leftover.kind === 'ScheduledTask'
                ? `Disable-ScheduledTask -TaskName "${leftover.path.split('\\').pop()}"`
                : `Remove-Item "${leftover.path}" -Recurse -Force -ErrorAction SilentlyContinue`;
          lines.push(`Invoke-BurrowStep "${app.name} · ${leftover.kind}" "${cmd.replace(/"/g, '`"')}" "${leftover.path.replace(/"/g, '`"')}"`);
        }
      }
      lines.push('');
    }

    if (req.upgradeApps.length > 0) {
      lines.push('# --- Package Upgrades (winget) ---');
      for (const app of req.upgradeApps) {
        if (app.updateCommand) {
          lines.push(`Invoke-BurrowStep "Upgrade ${app.name}" "${app.updateCommand.replace(/"/g, '`"')}"`);
        }
      }
      lines.push('');
    }

    if (req.startupChanges.length > 0) {
      lines.push('# --- Startup Item Adjustments ---');
      for (const st of req.startupChanges) {
        const cmd =
          st.mechanism === 'ScheduledTask'
            ? `${st.enabled ? 'Enable' : 'Disable'}-ScheduledTask -TaskName "${st.name}"`
            : `Write-Output "Update startup state (${st.enabled ? 'enabled' : 'disabled'}): ${st.path}"`;
        lines.push(`Invoke-BurrowStep "${st.enabled ? 'Enable' : 'Disable'} ${st.name}" "${cmd.replace(/"/g, '`"')}"`);
      }
      lines.push('');
    }

    if (req.optimizeTasks.length > 0) {
      lines.push('# --- Windows Optimize Routines ---');
      for (const opt of req.optimizeTasks) {
        lines.push(`Invoke-BurrowStep "${opt.title}" "${opt.command.replace(/"/g, '`"')}"`);
      }
      lines.push('');
    }

    lines.push('Write-Host "Burrow maintenance sweep complete." -ForegroundColor Green');

    return {
      filename: 'burrow-windows-maintenance.ps1',
      language: 'powershell',
      content: lines.join('\n'),
      itemCount,
      estimatedBytes: totalBytes,
      requiresAdmin,
    };
  }

  // macOS / Linux Bash script
  const lines: string[] = [
    '#!/usr/bin/env bash',
    '# Burrow — Cross-Platform Maintenance & Deep Clean Script',
    `# Generated: ${new Date().toISOString()}`,
    '# Usage: ./burrow-maintenance.sh --dry-run   (Preview safely)',
    '#        ./burrow-maintenance.sh             (Execute selected tasks)',
    '',
    'set -euo pipefail',
    `DRY_RUN=${req.dryRun ? 'true' : 'false'}`,
    'if [[ "${1:-}" == "--dry-run" ]]; then DRY_RUN=true; fi',
    'if [[ "${1:-}" == "--execute" ]]; then DRY_RUN=false; fi',
    '',
    'WHITELIST=(',
    ...req.whitelist
      .filter((w) => w.os === req.os || w.os === 'all')
      .map((w) => `  "${w.pattern.replace(/"/g, '\\"')}"`),
    ')',
    '',
    'is_whitelisted() {',
    '  local target="$1"',
    '  for pattern in "${WHITELIST[@]}"; do',
    '    if [[ "$target" == *"$pattern"* ]]; then',
    '      return 0',
    '    fi',
    '  done',
    '  return 1',
    '}',
    '',
    'run_step() {',
    '  local label="$1"',
    '  local cmd="$2"',
    '  local path_check="${3:-}"',
    '  if [[ -n "$path_check" ]] && is_whitelisted "$path_check"; then',
    '    echo "[SKIP-WHITELIST] $label ($path_check)"',
    '    return 0',
    '  fi',
    '  if [[ "$DRY_RUN" == "true" ]]; then',
    '    echo "[DRY-RUN] $label -> $cmd"',
    '  else',
    '    echo "[EXEC] $label"',
    '    eval "$cmd"',
    '  fi',
    '}',
    '',
  ];

  if (req.cleanTargets.length > 0) {
    lines.push('# --- Deep Clean & Orphaned Installers ---');
    for (const c of req.cleanTargets) {
      lines.push(`run_step "${c.title.replace(/"/g, '\\"')}" "${c.commandPreview.replace(/"/g, '\\"')}" "${c.path.replace(/"/g, '\\"')}"`);
    }
    lines.push('');
  }

  if (req.purgeProjects.length > 0) {
    lines.push('# --- Developer Artifact Purge ---');
    for (const p of req.purgeProjects) {
      const cmd = `rm -rf ${p.path}`;
      lines.push(`run_step "Purge ${p.projectName} (${p.artifactType})" "${cmd.replace(/"/g, '\\"')}" "${p.path.replace(/"/g, '\\"')}"`);
    }
    lines.push('');
  }

  if (req.uninstallApps.length > 0) {
    lines.push('# --- Smart App Uninstall & Residue Cleanup ---');
    for (const app of req.uninstallApps) {
      for (const leftover of app.leftovers) {
        const prefix = leftover.requiresAdmin ? 'sudo ' : '';
        const cmd = `${prefix}rm -rf "${leftover.path}"`;
        lines.push(`run_step "${app.name} · ${leftover.kind}" "${cmd.replace(/"/g, '\\"')}" "${leftover.path.replace(/"/g, '\\"')}"`);
      }
    }
    lines.push('');
  }

  if (req.upgradeApps.length > 0) {
    lines.push('# --- Homebrew Package Upgrades ---');
    for (const app of req.upgradeApps) {
      if (app.updateCommand) {
        lines.push(`run_step "Upgrade ${app.name}" "${app.updateCommand.replace(/"/g, '\\"')}"`);
      }
    }
    lines.push('');
  }

  if (req.startupChanges.length > 0) {
    lines.push('# --- LaunchAgents & Login Items ---');
    for (const st of req.startupChanges) {
      const cmd = st.enabled
        ? `launchctl load -w "${st.path}"`
        : `launchctl unload -w "${st.path}"`;
      lines.push(`run_step "${st.enabled ? 'Enable' : 'Disable'} ${st.name}" "${cmd.replace(/"/g, '\\"')}"`);
    }
    lines.push('');
  }

  if (req.optimizeTasks.length > 0) {
    lines.push('# --- System Optimization Routines ---');
    for (const opt of req.optimizeTasks) {
      lines.push(`run_step "${opt.title.replace(/"/g, '\\"')}" "${opt.command.replace(/"/g, '\\"')}"`);
    }
    lines.push('');
  }

  lines.push('echo "Burrow maintenance sweep complete."');

  return {
    filename: req.os === 'macos' ? 'burrow-macos-maintenance.sh' : 'burrow-host-maintenance.sh',
    language: 'bash',
    content: lines.join('\n'),
    itemCount,
    estimatedBytes: totalBytes,
    requiresAdmin,
  };
}
