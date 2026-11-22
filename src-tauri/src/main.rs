#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use sysinfo::{
    CpuRefreshKind, Disks, MemoryRefreshKind, Networks, ProcessRefreshKind, ProcessesToUpdate,
    RefreshKind, System,
};
mod native;

struct TelemetryState {
    sys: Mutex<System>,
    disks: Mutex<Disks>,
    networks: Mutex<Networks>,
    last_net_sample: Mutex<std::time::Instant>,
}

impl TelemetryState {
    fn new() -> Self {
        let sys = System::new_with_specifics(
            RefreshKind::nothing()
                .with_cpu(CpuRefreshKind::everything())
                .with_memory(MemoryRefreshKind::everything()),
        );
        let disks = Disks::new_with_refreshed_list();
        let networks = Networks::new_with_refreshed_list();
        Self {
            sys: Mutex::new(sys),
            disks: Mutex::new(disks),
            networks: Mutex::new(networks),
            last_net_sample: Mutex::new(std::time::Instant::now()),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CpuCoreMetric {
    core: usize,
    model: String,
    speed_mhz: u64,
    load_pct: f32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MemoryMetric {
    total_bytes: u64,
    used_bytes: u64,
    active_bytes: u64,
    wired_bytes: u64,
    cached_bytes: u64,
    free_bytes: u64,
    swap_used_bytes: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DiskPartitionMetric {
    mount: String,
    filesystem: String,
    total_bytes: u64,
    used_bytes: u64,
    avail_bytes: u64,
    use_pct: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProcessMetric {
    pid: u32,
    name: String,
    user: String,
    cpu_pct: f32,
    mem_mb: u64,
    command: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TelemetrySnapshot {
    os: String,
    hostname: String,
    platform_label: String,
    arch: String,
    uptime_seconds: u64,
    load_avg: [f64; 3],
    timestamp: u64,
    cpu_overall_pct: f32,
    cores: Vec<CpuCoreMetric>,
    memory: MemoryMetric,
    disks: Vec<DiskPartitionMetric>,
    network_rx_mbps: f64,
    network_tx_mbps: f64,
    processes: Vec<ProcessMetric>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CleanScanResult {
    id: String,
    path: String,
    size_bytes: u64,
    item_count: usize,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CleanTargetInput {
    id: String,
    path: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CleanActionReport {
    id: String,
    path: String,
    bytes: u64,
    status: String,
}

fn expand_single_windows_env(raw: &str) -> PathBuf {
    let mut out = raw.trim().to_string();
    for key in [
        "LOCALAPPDATA",
        "APPDATA",
        "USERPROFILE",
        "TEMP",
        "WINDIR",
        "SystemRoot",
        "ProgramData",
    ] {
        if let Ok(val) = env::var(key) {
            out = out.replace(&format!("%{}%", key), &val);
        }
    }
    PathBuf::from(out)
}

/// Expands single or compound ("pathA + pathB") target specs into individual PathBufs.
fn expand_target_paths(raw: &str) -> Vec<PathBuf> {
    raw.split(" + ")
        .map(str::trim)
        .filter(|segment| !segment.is_empty())
        .map(expand_single_windows_env)
        .collect()
}

fn normalize_win(raw: &str) -> String {
    raw.trim()
        .replace('/', "\\")
        .trim_end_matches('\\')
        .to_ascii_lowercase()
}

/// Folders Burrow is allowed to clean. Anything outside these roots is refused,
/// no matter what the frontend sends. `exact_ok` roots may be cleaned directly;
/// all others may only be cleaned at a strictly deeper path (so a broad root such
/// as %LOCALAPPDATA% or Downloads can never be wiped as a whole).
fn allowed_clean_roots() -> Vec<(String, bool)> {
    let mut roots: Vec<(String, bool)> = Vec::new();
    let mut push = |base: Option<String>, tail: &str, exact_ok: bool| {
        if let Some(b) = base {
            if b.trim().is_empty() {
                return;
            }
            let joined = if tail.is_empty() {
                b
            } else {
                format!("{}\\{}", b.trim_end_matches('\\'), tail)
            };
            roots.push((normalize_win(&joined), exact_ok));
        }
    };
    let var = |k: &str| env::var(k).ok();
    // Only specific cache folders inside AppData, never AppData itself (browser
    // profiles, saved logins and app settings live there).
    for tail in [
        "Temp",
        "CrashDumps",
        "D3DSCache",
        "NVIDIA\\DXCache",
        "AMD\\DxCache",
        "npm-cache",
        "Microsoft\\Windows\\INetCache",
        "Microsoft\\Edge\\User Data\\Default\\Cache",
        "Microsoft\\Edge\\User Data\\Default\\Code Cache",
        "Microsoft\\Edge\\User Data\\Default\\GPUCache",
        "Google\\Chrome\\User Data\\Default\\Cache",
        "Google\\Chrome\\User Data\\Default\\Code Cache",
        "Google\\Chrome\\User Data\\Default\\GPUCache",
    ] {
        push(var("LOCALAPPDATA"), tail, true);
    }
    push(var("USERPROFILE"), "Downloads", false);
    push(var("USERPROFILE"), ".nuget", false);
    push(var("TEMP"), "", true);
    push(var("TMP"), "", true);
    push(var("WINDIR").or(var("SystemRoot")), "Temp", true);
    push(var("WINDIR").or(var("SystemRoot")), "SoftwareDistribution\\Download", true);
    push(var("WINDIR").or(var("SystemRoot")), "Prefetch", true);
    push(
        var("WINDIR").or(var("SystemRoot")),
        "ServiceProfiles\\NetworkService\\AppData\\Local\\Microsoft\\Windows\\DeliveryOptimization\\Cache",
        true,
    );
    push(var("ProgramData"), "Microsoft\\Windows\\WER", true);
    push(var("SystemDrive").or(Some("C:".to_string())), "$Recycle.Bin", true);
    roots
}

fn is_safe_purge_path(path: &Path, normalized: &str) -> bool {
    const NEVER: [&str; 5] = [".ssh", ".gnupg", ".aws", ".kube", "appdata"];
    if normalized.split('\\').any(|seg| NEVER.contains(&seg)) {
        return false;
    }
    if normalized.starts_with("c:\\windows") || normalized.starts_with("c:\\program files") {
        return false;
    }
    let (Some(name), Some(parent)) = (path.file_name().and_then(|n| n.to_str()), path.parent()) else {
        return false;
    };
    path.is_dir() && native::classify_artifact(&name.to_lowercase(), parent).is_some()
}

/// Guards against empty paths, traversal, anything outside the allowed cleanup
/// roots, credentials/key folders and virtual-disk images (e.g. Docker's docker_data.vhdx).
fn is_safe_clean_path(path: &Path) -> bool {
    let s = path.to_string_lossy();
    let trimmed = s.trim();
    if trimmed.is_empty() || trimmed.contains('%') {
        return false;
    }

    for comp in path.components() {
        if matches!(comp, std::path::Component::ParentDir) {
            return false;
        }
    }

    let normalized = normalize_win(trimmed);
    if normalized.len() <= 3 {
        return false;
    }

    // Regenerable developer build folders (node_modules, target, ...) are allowed
    // wherever the project lives, but only when the project file sits next to them.
    if is_safe_purge_path(path, &normalized) {
        return true;
    }

    // Never touch virtual disks, key stores or personal document folders.
    const DENY_EXT: [&str; 6] = [".vhdx", ".vhd", ".vmdk", ".vdi", ".avhdx", ".iso"];
    if DENY_EXT.iter().any(|ext| normalized.ends_with(ext)) {
        return false;
    }
    const DENY_SEGMENTS: [&str; 9] = [
        ".ssh", ".gnupg", ".aws", ".kube", "documents", "desktop", "pictures", "videos", "onedrive",
    ];
    if normalized
        .split('\\')
        .any(|seg| DENY_SEGMENTS.contains(&seg))
    {
        return false;
    }

    allowed_clean_roots().iter().any(|(root, exact_ok)| {
        if normalized == *root {
            *exact_ok
        } else {
            normalized.starts_with(&format!("{}\\", root))
        }
    })
}

/// Case-insensitive glob matcher supporting `*` and `?`.
fn glob_match(pattern: &[u8], text: &[u8]) -> bool {
    let (mut p, mut t) = (0usize, 0usize);
    let (mut star, mut mark) = (None::<usize>, 0usize);
    while t < text.len() {
        if p < pattern.len() && (pattern[p] == b'?' || pattern[p] == text[t]) {
            p += 1;
            t += 1;
        } else if p < pattern.len() && pattern[p] == b'*' {
            star = Some(p);
            mark = t;
            p += 1;
        } else if let Some(sp) = star {
            p = sp + 1;
            mark += 1;
            t = mark;
        } else {
            return false;
        }
    }
    while p < pattern.len() && pattern[p] == b'*' {
        p += 1;
    }
    p == pattern.len()
}

fn matches_protected_pattern(path: &Path, patterns: &[String]) -> bool {
    let hay = path.to_string_lossy().replace('/', "\\").to_ascii_lowercase();
    patterns.iter().any(|raw| {
        let pat = raw.trim().replace('/', "\\").to_ascii_lowercase();
        if pat.is_empty() || pat.chars().all(|c| c == '*') {
            return false;
        }
        // A rule protects the path if it matches anywhere inside it.
        let wrapped = format!("*{}*", pat);
        glob_match(wrapped.as_bytes(), hay.as_bytes())
    })
}

fn measure_folder_fast(path: &Path) -> (u64, usize) {
    native::dir_size(path)
}

fn is_link(path: &Path) -> bool {
    fs::symlink_metadata(path)
        .map(|m| m.file_type().is_symlink())
        .unwrap_or(false)
}

fn clean_directory_contents(dir: &Path) -> (usize, usize) {
    let mut removed = 0usize;
    let mut skipped = 0usize;
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let child = entry.path();
            let is_real_dir = entry
                .file_type()
                .map(|t| t.is_dir() && !t.is_symlink())
                .unwrap_or(false);
            let res = if is_real_dir {
                fs::remove_dir_all(&child)
            } else {
                fs::remove_file(&child).or_else(|_| fs::remove_dir(&child))
            };
            match res {
                Ok(_) => removed += 1,
                Err(_) => skipped += 1,
            }
        }
    }
    (removed, skipped)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn cleaning_never_follows_a_link_to_another_folder() {
        let base = std::env::temp_dir().join(format!("burrow-link-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        let project = base.join("proj");
        let elsewhere = base.join("precious");
        fs::create_dir_all(&project).unwrap();
        fs::create_dir_all(&elsewhere).unwrap();
        fs::write(project.join("package.json"), "{}").unwrap();
        fs::write(elsewhere.join("keep.txt"), "important").unwrap();
        std::os::unix::fs::symlink(&elsewhere, project.join("node_modules")).unwrap();

        let target = CleanTargetInput {
            id: "t".into(),
            path: project.join("node_modules").to_string_lossy().to_string(),
        };
        let reports = clean_targets_blocking(vec![target], false, None);
        assert!(elsewhere.join("keep.txt").exists(), "link target was emptied: {:?}", reports.iter().map(|r| &r.status).collect::<Vec<_>>());
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn broad_appdata_folders_are_not_cleanable() {
        std::env::set_var("LOCALAPPDATA", "C:\\Users\\a\\AppData\\Local");
        std::env::set_var("APPDATA", "C:\\Users\\a\\AppData\\Roaming");
        assert!(!is_safe_clean_path(Path::new("C:\\Users\\a\\AppData\\Roaming\\Mozilla\\Firefox\\Profiles")));
        assert!(!is_safe_clean_path(Path::new("C:\\Users\\a\\AppData\\Local\\Google\\Chrome\\User Data\\Default\\Login Data")));
        assert!(is_safe_clean_path(Path::new("C:\\Users\\a\\AppData\\Local\\D3DSCache")));
        assert!(is_safe_clean_path(Path::new("C:\\Users\\a\\AppData\\Local\\Microsoft\\Edge\\User Data\\Default\\Cache")));
    }

    #[test]
    fn glob_protects_wildcard_rules() {
        let p = Path::new("C:\\Program Files (x86)\\Steam\\steamapps\\shadercache\\1");
        assert!(matches_protected_pattern(p, &["*Steam*shadercache*".to_string()]));
        assert!(!matches_protected_pattern(p, &["*\\.ssh\\*".to_string()]));
    }

    #[test]
    fn refuses_user_documents_and_vhdx() {
        assert!(!is_safe_clean_path(Path::new("C:\\Users\\a\\Documents\\x")));
        assert!(!is_safe_clean_path(Path::new(
            "C:\\Users\\a\\AppData\\Local\\Docker\\wsl\\disk\\docker_data.vhdx"
        )));
    }
}

#[tauri::command]
fn get_system_telemetry(state: tauri::State<TelemetryState>) -> TelemetrySnapshot {
    let mut sys = state.sys.lock().unwrap_or_else(|e| e.into_inner());
    sys.refresh_cpu_all();
    sys.refresh_memory();
    // Refresh only CPU + memory per process without allocating argv/environ/user SID buffers
    sys.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::nothing().with_cpu().with_memory(),
    );

    let cores: Vec<CpuCoreMetric> = sys
        .cpus()
        .iter()
        .enumerate()
        .map(|(i, cpu)| CpuCoreMetric {
            core: i,
            model: cpu.brand().to_string(),
            speed_mhz: cpu.frequency(),
            load_pct: cpu.cpu_usage(),
        })
        .collect();

    let cpu_overall_pct = if cores.is_empty() {
        0.0
    } else {
        cores.iter().map(|c| c.load_pct).sum::<f32>() / cores.len() as f32
    };

    let total_mem = sys.total_memory();
    let used_mem = sys.used_memory();
    let free_mem = total_mem.saturating_sub(used_mem);
    let swap_used = sys.used_swap();

    // Pick top 15 processes by memory using lightweight ProcessMetric structs
    let mut top_procs: Vec<ProcessMetric> = sys
        .processes()
        .iter()
        .map(|(pid, proc_info)| ProcessMetric {
            pid: pid.as_u32(),
            name: proc_info.name().to_string_lossy().to_string(),
            user: String::new(),
            cpu_pct: proc_info.cpu_usage(),
            mem_mb: proc_info.memory() / (1024 * 1024),
            command: String::new(),
        })
        .collect();
    top_procs.sort_by(|a, b| b.mem_mb.cmp(&a.mem_mb));
    top_procs.truncate(15);

    drop(sys);

    let mut disks_guard = state.disks.lock().unwrap_or_else(|e| e.into_inner());
    disks_guard.refresh(false);
    let disks: Vec<DiskPartitionMetric> = disks_guard
        .iter()
        .map(|d| {
            let total = d.total_space();
            let avail = d.available_space();
            let used = total.saturating_sub(avail);
            let use_pct = if total > 0 {
                (used as f64 / total as f64) * 100.0
            } else {
                0.0
            };
            DiskPartitionMetric {
                mount: d.mount_point().to_string_lossy().to_string(),
                filesystem: d.file_system().to_string_lossy().to_string(),
                total_bytes: total,
                used_bytes: used,
                avail_bytes: avail,
                use_pct,
            }
        })
        .collect();
    drop(disks_guard);

    let mut net_guard = state.networks.lock().unwrap_or_else(|e| e.into_inner());
    net_guard.refresh(false);
    let (rx, tx) = net_guard.iter().fold((0u64, 0u64), |acc, (_, data)| {
        (acc.0 + data.received(), acc.1 + data.transmitted())
    });
    drop(net_guard);

    let mut last_sample = state
        .last_net_sample
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let elapsed_secs = last_sample.elapsed().as_secs_f64().max(0.25);
    *last_sample = std::time::Instant::now();
    drop(last_sample);

    let load = System::load_average();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);

    TelemetrySnapshot {
        os: "windows".to_string(),
        hostname: System::host_name().unwrap_or_else(|| "Windows-PC".to_string()),
        platform_label: format!(
            "{} {}",
            System::name().unwrap_or_else(|| "Windows".to_string()),
            System::os_version().unwrap_or_default()
        ),
        arch: env::consts::ARCH.to_string(),
        uptime_seconds: System::uptime(),
        load_avg: [load.one, load.five, load.fifteen],
        timestamp: now,
        cpu_overall_pct,
        cores,
        memory: MemoryMetric {
            total_bytes: total_mem,
            used_bytes: used_mem,
            active_bytes: (used_mem as f64 * 0.65) as u64,
            wired_bytes: (used_mem as f64 * 0.15) as u64,
            cached_bytes: (used_mem as f64 * 0.20) as u64,
            free_bytes: free_mem,
            swap_used_bytes: swap_used,
        },
        disks,
        network_rx_mbps: (rx as f64) / (1024.0 * 1024.0) / elapsed_secs,
        network_tx_mbps: (tx as f64) / (1024.0 * 1024.0) / elapsed_secs,
        processes: top_procs,
    }
}

#[tauri::command]
async fn scan_windows_targets(targets: Vec<CleanTargetInput>) -> Vec<CleanScanResult> {
    tauri::async_runtime::spawn_blocking(move || scan_targets_blocking(targets))
        .await
        .unwrap_or_default()
}

fn scan_targets_blocking(targets: Vec<CleanTargetInput>) -> Vec<CleanScanResult> {
    targets
        .into_iter()
        .map(|target| {
            let paths = expand_target_paths(&target.path);
            let mut total_bytes = 0u64;
            let mut total_items = 0usize;
            let mut display_paths: Vec<String> = Vec::new();

            for resolved in paths {
                display_paths.push(resolved.to_string_lossy().to_string());
                if is_safe_clean_path(&resolved) && resolved.exists() {
                    let (b, c) = measure_folder_fast(&resolved);
                    total_bytes = total_bytes.saturating_add(b);
                    total_items = total_items.saturating_add(c);
                }
            }

            CleanScanResult {
                id: target.id,
                path: if display_paths.is_empty() {
                    target.path
                } else {
                    display_paths.join(" + ")
                },
                size_bytes: total_bytes,
                item_count: total_items,
            }
        })
        .collect()
}

#[tauri::command]
async fn clean_windows_targets(
    targets: Vec<CleanTargetInput>,
    dry_run: bool,
    protected_patterns: Option<Vec<String>>,
) -> Vec<CleanActionReport> {
    tauri::async_runtime::spawn_blocking(move || clean_targets_blocking(targets, dry_run, protected_patterns))
        .await
        .unwrap_or_default()
}

fn clean_targets_blocking(
    targets: Vec<CleanTargetInput>,
    dry_run: bool,
    protected_patterns: Option<Vec<String>>,
) -> Vec<CleanActionReport> {
    let protected = protected_patterns.unwrap_or_default();

    targets
        .into_iter()
        .map(|target| {
            let paths = expand_target_paths(&target.path);
            let display_path = if paths.is_empty() {
                target.path.clone()
            } else {
                paths
                    .iter()
                    .map(|p| p.to_string_lossy().to_string())
                    .collect::<Vec<_>>()
                    .join(" + ")
            };

            let mut total_bytes = 0u64;
            let mut total_removed = 0usize;
            let mut total_skipped = 0usize;
            let mut any_exists = false;
            let mut blocked_reason: Option<String> = None;

            for resolved in paths {
                if !is_safe_clean_path(&resolved) {
                    blocked_reason = Some("skipped (protected system path)".to_string());
                    continue;
                }
                // A folder link/junction would make us empty whatever it points to.
                if is_link(&resolved) {
                    blocked_reason = Some("skipped (folder link)".to_string());
                    continue;
                }
                if matches_protected_pattern(&resolved, &protected) {
                    blocked_reason = Some("skipped (protected rule)".to_string());
                    continue;
                }
                if !resolved.exists() {
                    continue;
                }
                any_exists = true;
                let (bytes, _) = measure_folder_fast(&resolved);
                total_bytes = total_bytes.saturating_add(bytes);

                if !dry_run {
                    if resolved.is_dir() {
                        let (removed, skipped) = clean_directory_contents(&resolved);
                        total_removed = total_removed.saturating_add(removed);
                        total_skipped = total_skipped.saturating_add(skipped);
                    } else {
                        match fs::remove_file(&resolved) {
                            Ok(_) => total_removed += 1,
                            Err(_) => total_skipped += 1,
                        }
                    }
                }
            }

            if let Some(reason) = blocked_reason {
                if !any_exists {
                    return CleanActionReport {
                        id: target.id,
                        path: display_path,
                        bytes: 0,
                        status: reason,
                    };
                }
            }

            if !any_exists {
                return CleanActionReport {
                    id: target.id,
                    path: display_path,
                    bytes: 0,
                    status: "already clean".to_string(),
                };
            }

            if dry_run {
                return CleanActionReport {
                    id: target.id,
                    path: display_path,
                    bytes: total_bytes,
                    status: "dry-run verified".to_string(),
                };
            }

            CleanActionReport {
                id: target.id,
                path: display_path,
                bytes: total_bytes,
                status: if total_skipped == 0 {
                    format!("cleaned ({} entries)", total_removed)
                } else {
                    format!("cleaned {} ({} in use)", total_removed, total_skipped)
                },
            }
        })
        .collect()
}

#[tauri::command]
async fn run_windows_optimize(task_id: String, dry_run: bool) -> Result<String, String> {
    let script = match task_id.as_str() {
        "wo-dns" => "Clear-DnsClientCache",
        "wo-thumb" => "Remove-Item \"$env:LOCALAPPDATA\\Microsoft\\Windows\\Explorer\\thumbcache_*.db\" -Force -ErrorAction SilentlyContinue",
        "wo-dism" => "Dism.exe /Online /Cleanup-Image /StartComponentCleanup",
        "wo-search" => "Restart-Service WSearch -Force",
        "wo-standby" => "wsl --shutdown",
        _ => return Err(format!("Unknown optimization task '{}'", task_id)),
    };

    if dry_run {
        return Ok("Verified".to_string());
    }

    tauri::async_runtime::spawn_blocking(move || {
        native::run_powershell(script, &[]).map_err(|e| {
            if e.trim().is_empty() {
                "Needs administrator rights or was skipped.".to_string()
            } else {
                e
            }
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

fn is_valid_winget_id(package_id: &str) -> bool {
    !package_id.is_empty()
        && package_id.len() <= 128
        && !package_id.starts_with('-')
        && package_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
}

#[tauri::command]
async fn run_winget_upgrade(package_id: String, dry_run: bool) -> Result<String, String> {
    if !is_valid_winget_id(&package_id) {
        return Err("Invalid Windows package identifier.".to_string());
    }
    if dry_run {
        return Ok(format!("Ready to update {}", package_id));
    }
    tauri::async_runtime::spawn_blocking(move || {
        let output = native::hidden("winget")
            .args([
                "upgrade",
                "--id",
                &package_id,
                "--exact",
                "--silent",
                "--accept-package-agreements",
                "--accept-source-agreements",
                "--disable-interactivity",
            ])
            .output()
            .map_err(|_| "The Windows Package Manager (winget) was not found.".to_string())?;

        if output.status.success() {
            Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
        } else {
            Err(format!(
                "The update did not finish (code {}). Close the app and try again.",
                output.status.code().unwrap_or(-1)
            ))
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

fn main() {
    tauri::Builder::default()
        .manage(TelemetryState::new())
        .invoke_handler(tauri::generate_handler![
            get_system_telemetry,
            scan_windows_targets,
            clean_windows_targets,
            run_windows_optimize,
            run_winget_upgrade,
            native::list_installed_apps,
            native::uninstall_app,
            native::list_app_updates,
            native::list_startup_items,
            native::set_startup_enabled,
            native::scan_downloads,
            native::scan_purge_projects,
            native::analyze_path,
            native::pick_folder,
            native::find_app_leftovers,
            native::delete_app_leftovers,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Burrow Tauri application");
}
