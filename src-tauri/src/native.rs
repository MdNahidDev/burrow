//! Native Windows features for Burrow: installed apps, updates, startup items,
//! Downloads scan, developer-folder scan and the disk analyzer.
//!
//! Everything here runs silently (no console windows) and is exposed to the UI
//! through Tauri commands. All slow work runs on a blocking thread so the window
//! never freezes.

use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Start a child process without flashing a console window.
pub fn hidden(program: &str) -> Command {
    #[allow(unused_mut)]
    let mut cmd = Command::new(program);
    #[cfg(windows)]
    {
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    cmd
}

/// Run a PowerShell snippet silently and return its trimmed stdout.
pub fn run_powershell(script: &str, envs: &[(&str, &str)]) -> Result<String, String> {
    let full = format!(
        "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; $ProgressPreference='SilentlyContinue'; $ErrorActionPreference='Continue'; {}",
        script
    );
    let mut cmd = hidden("powershell");
    cmd.args([
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        &full,
    ]);
    for (k, v) in envs {
        cmd.env(k, v);
    }
    let out = cmd
        .output()
        .map_err(|e| format!("Could not start Windows PowerShell: {}", e))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        Err(if err.is_empty() {
            format!("Windows task failed (code {:?})", out.status.code())
        } else {
            err
        })
    }
}

/// Run `f` over `items` on a small thread pool, keeping the input order.
fn parallel_map<T: Sync, R: Send>(items: &[T], f: impl Fn(&T) -> R + Sync) -> Vec<R> {
    let next = AtomicUsize::new(0);
    let results: Mutex<Vec<Option<R>>> = Mutex::new((0..items.len()).map(|_| None).collect());
    let workers = 8.min(items.len().max(1));
    std::thread::scope(|scope| {
        for _ in 0..workers {
            scope.spawn(|| loop {
                let i = next.fetch_add(1, Ordering::SeqCst);
                if i >= items.len() {
                    break;
                }
                let r = f(&items[i]);
                results.lock().unwrap_or_else(|e| e.into_inner())[i] = Some(r);
            });
        }
    });
    results
        .into_inner()
        .unwrap_or_else(|e| e.into_inner())
        .into_iter()
        .flatten()
        .collect()
}

/// Total size and file count of a folder (no depth limit, does not follow links).
pub fn dir_size(path: &Path) -> (u64, usize) {
    if path.is_file() {
        return (path.metadata().map(|m| m.len()).unwrap_or(0), 1);
    }
    let mut bytes = 0u64;
    let mut files = 0usize;
    let mut stack = vec![path.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(rd) = fs::read_dir(&dir) else { continue };
        for entry in rd.flatten() {
            let Ok(ft) = entry.file_type() else { continue };
            if ft.is_symlink() {
                continue;
            }
            if ft.is_dir() {
                stack.push(entry.path());
            } else if let Ok(meta) = entry.metadata() {
                files += 1;
                bytes = bytes.saturating_add(meta.len());
            }
        }
    }
    (bytes, files)
}

fn days_since(time: Option<SystemTime>) -> u64 {
    time.and_then(|t| SystemTime::now().duration_since(t).ok())
        .map(|d| d.as_secs() / 86_400)
        .unwrap_or(0)
}

/// Days from civil date (proleptic Gregorian), used to age an `InstallDate`.
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// "20240312" -> number of days ago, or -1 when unknown.
fn install_age_days(raw: &str) -> i64 {
    let digits: String = raw.chars().filter(|c| c.is_ascii_digit()).collect();
    if digits.len() != 8 {
        return -1;
    }
    let (Ok(y), Ok(m), Ok(d)) = (
        digits[0..4].parse::<i64>(),
        digits[4..6].parse::<i64>(),
        digits[6..8].parse::<i64>(),
    ) else {
        return -1;
    };
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) || y < 1990 {
        return -1;
    }
    let now = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64 / 86_400)
        .unwrap_or(0);
    (now - days_from_civil(y, m, d)).max(0)
}

fn user_profile() -> Option<PathBuf> {
    env::var("USERPROFILE").ok().map(PathBuf::from)
}

// ---------------------------------------------------------------------------
// Installed apps
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppLeftoverInfo {
    pub id: String,
    pub path: String,
    pub kind: String,
    pub size_bytes: u64,
    pub requires_admin: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledAppInfo {
    pub id: String,
    pub name: String,
    pub version: String,
    pub publisher: String,
    pub install_location: String,
    pub binary_size_bytes: u64,
    pub installed_days_ago: i64,
    pub leftovers: Vec<AppLeftoverInfo>,
}

#[derive(Deserialize, Default)]
struct RawApp {
    #[serde(default)]
    id: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    version: Option<String>,
    #[serde(default)]
    publisher: Option<String>,
    #[serde(default)]
    location: Option<String>,
    #[serde(default, rename = "sizeKb")]
    size_kb: Option<f64>,
    #[serde(default)]
    date: Option<String>,
}

const UNINSTALL_KEYS_PS: &str = r#"
$bases = @(
  'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall',
  'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall',
  'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall'
)
"#;

/// Generic folder names that must never be treated as an app's own leftovers.
const GENERIC_FOLDERS: [&str; 18] = [
    "microsoft", "windows", "google", "programs", "common files", "packages", "temp", "local",
    "roaming", "apple", "adobe", "intel", "nvidia", "amd", "mozilla", "oracle", "python", "java",
];

fn clean_app_label(name: &str) -> String {
    name.trim().to_string()
}

fn find_leftovers(app_id: &str, name: &str, location: &str) -> Vec<(String, PathBuf)> {
    let mut found: Vec<(String, PathBuf)> = Vec::new();
    let mut wanted: Vec<String> = vec![clean_app_label(name)];
    if let Some(dir_name) = Path::new(location).file_name().and_then(|s| s.to_str()) {
        wanted.push(dir_name.to_string());
    }
    wanted.retain(|w| {
        let lw = w.to_lowercase();
        w.len() >= 3 && !GENERIC_FOLDERS.contains(&lw.as_str())
    });
    wanted.sort();
    wanted.dedup();

    for (var, kind) in [("LOCALAPPDATA", "Caches"), ("APPDATA", "Support")] {
        let Ok(base) = env::var(var) else { continue };
        let Ok(rd) = fs::read_dir(&base) else { continue };
        for entry in rd.flatten() {
            let Ok(ft) = entry.file_type() else { continue };
            if !ft.is_dir() || ft.is_symlink() {
                continue;
            }
            let folder = entry.file_name().to_string_lossy().to_lowercase();
            if wanted.iter().any(|w| w.to_lowercase() == folder) {
                found.push((kind.to_string(), entry.path()));
            }
        }
    }
    let _ = app_id;
    found
}

fn list_installed_apps_sync() -> Result<Vec<InstalledAppInfo>, String> {
    let script = format!(
        r#"{}
$items = foreach ($b in $bases) {{
  Get-ItemProperty -Path "$b\*" -ErrorAction SilentlyContinue |
    Where-Object {{ $_.DisplayName -and -not $_.SystemComponent -and -not $_.ParentKeyName -and ($_.UninstallString -or $_.QuietUninstallString) }} |
    ForEach-Object {{
      [pscustomobject]@{{
        id = [string]$_.PSChildName
        name = [string]$_.DisplayName
        version = [string]$_.DisplayVersion
        publisher = [string]$_.Publisher
        location = [string]$_.InstallLocation
        sizeKb = [double]($_.EstimatedSize)
        date = [string]$_.InstallDate
      }}
    }}
}}
if (-not $items) {{ '[]' }} else {{ ConvertTo-Json -InputObject @($items) -Compress -Depth 3 }}
"#,
        UNINSTALL_KEYS_PS
    );
    let json = run_powershell(&script, &[])?;
    let raw: Vec<RawApp> =
        serde_json::from_str(&json).map_err(|e| format!("Unexpected app list format: {}", e))?;

    // Same program is often registered twice (32/64-bit); keep one entry.
    let mut seen: HashSet<String> = HashSet::new();
    let raw: Vec<RawApp> = raw
        .into_iter()
        .filter(|a| !a.id.is_empty() && !a.name.trim().is_empty())
        .filter(|a| {
            seen.insert(format!(
                "{}|{}",
                a.name.trim().to_lowercase(),
                a.version.clone().unwrap_or_default()
            ))
        })
        .collect();

    let mut apps: Vec<InstalledAppInfo> = parallel_map(&raw, |a| {
        let location = a.location.clone().unwrap_or_default().trim_matches('"').to_string();
        let mut binary = (a.size_kb.unwrap_or(0.0).max(0.0) * 1024.0) as u64;
        if binary == 0 && !location.is_empty() && Path::new(&location).is_dir() {
            binary = dir_size(Path::new(&location)).0;
        }

        let leftovers_raw = find_leftovers(&a.id, &a.name, &location);
        let mut leftovers: Vec<AppLeftoverInfo> = Vec::new();
        if binary > 0 {
            leftovers.push(AppLeftoverInfo {
                id: format!("{}-bin", a.id),
                path: if location.is_empty() {
                    a.name.clone()
                } else {
                    location.clone()
                },
                kind: "Binary".to_string(),
                size_bytes: binary,
                requires_admin: true,
            });
        }
        for (i, (kind, path)) in leftovers_raw.into_iter().enumerate() {
            let size = dir_size(&path).0;
            leftovers.push(AppLeftoverInfo {
                id: format!("{}-l{}", a.id, i),
                path: path.to_string_lossy().to_string(),
                kind,
                size_bytes: size,
                requires_admin: false,
            });
        }

        InstalledAppInfo {
            id: a.id.clone(),
            name: a.name.trim().to_string(),
            version: a.version.clone().unwrap_or_default().trim().to_string(),
            publisher: a.publisher.clone().unwrap_or_default().trim().to_string(),
            install_location: location,
            binary_size_bytes: binary,
            installed_days_ago: install_age_days(a.date.as_deref().unwrap_or("")),
            leftovers,
        }
    });
    apps.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(apps)
}

#[tauri::command]
pub async fn list_installed_apps() -> Result<Vec<InstalledAppInfo>, String> {
    tauri::async_runtime::spawn_blocking(list_installed_apps_sync)
        .await
        .map_err(|e| e.to_string())?
}

fn is_valid_registry_key_name(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 200
        && !id.contains(['\\', '/', '"', '\'', '`', '$', '|', ';', '*', '?', '<', '>'])
}

/// Opens the program's own uninstaller (its normal window) and waits until it closes.
/// The command is read from the registry here, never taken from the UI.
#[tauri::command]
pub async fn uninstall_app(app_id: String) -> Result<String, String> {
    if !is_valid_registry_key_name(&app_id) {
        return Err("Invalid app identifier.".to_string());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let script = format!(
            r#"{}
$id = $env:BURROW_APP_ID
foreach ($b in $bases) {{
  $k = "$b\$id"
  if (Test-Path -LiteralPath $k) {{
    $p = Get-ItemProperty -LiteralPath $k
    $cmd = $p.UninstallString
    if (-not $cmd) {{ $cmd = $p.QuietUninstallString }}
    if ($cmd) {{
      Start-Process -FilePath cmd.exe -ArgumentList ('/c start "" /wait ' + $cmd) -Wait -WindowStyle Hidden
      'done'; exit 0
    }}
  }}
}}
[Console]::Error.WriteLine('This program has no uninstaller registered.'); exit 3
"#,
            UNINSTALL_KEYS_PS
        );
        run_powershell(&script, &[("BURROW_APP_ID", &app_id)])
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---------------------------------------------------------------------------
// App updates (Windows Package Manager, used silently in the background)
// ---------------------------------------------------------------------------

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AppUpdateInfo {
    pub id: String,
    pub name: String,
    pub version: String,
    pub available: String,
}

fn char_slice(chars: &[char], from: usize, to: usize) -> String {
    let end = to.min(chars.len());
    if from >= end {
        return String::new();
    }
    chars[from..end].iter().collect::<String>().trim().to_string()
}

fn find_col(header: &[char], word: &str) -> Option<usize> {
    let w: Vec<char> = word.chars().collect();
    (0..header.len().saturating_sub(w.len().saturating_sub(1))).find(|&i| {
        header[i..i + w.len()] == w[..]
            && (i == 0 || header[i - 1] == ' ')
            && header.get(i + w.len()).map_or(true, |c| *c == ' ')
    })
}

/// Parse the table printed by `winget upgrade`.
pub fn parse_winget_upgrade(text: &str) -> Vec<AppUpdateInfo> {
    // Progress spinners use carriage returns; keep only the final visible text of each line.
    let lines: Vec<String> = text
        .split('\n')
        .map(|l| l.trim_end_matches('\r').rsplit('\r').next().unwrap_or("").trim_end().to_string())
        .collect();

    let Some(h) = lines.iter().position(|l| {
        let t = l.trim_start();
        t.starts_with("Name") && t.contains("Id") && t.contains("Version") && t.contains("Available")
    }) else {
        return Vec::new();
    };

    let header: Vec<char> = lines[h].trim_start_matches('\u{feff}').chars().collect();
    let (Some(id_c), Some(ver_c), Some(avail_c)) = (
        find_col(&header, "Id"),
        find_col(&header, "Version"),
        find_col(&header, "Available"),
    ) else {
        return Vec::new();
    };
    let src_c = find_col(&header, "Source").unwrap_or(usize::MAX);

    let mut out = Vec::new();
    for line in lines.iter().skip(h + 1) {
        let t = line.trim();
        if t.is_empty() || t.chars().all(|c| c == '-') {
            if t.is_empty() && !out.is_empty() {
                break;
            }
            continue;
        }
        let lower = t.to_lowercase();
        if lower.contains("upgrades available") || lower.contains("upgrade available") {
            break;
        }
        let chars: Vec<char> = line.chars().collect();
        let name = char_slice(&chars, 0, id_c);
        let id = char_slice(&chars, id_c, ver_c);
        let version = char_slice(&chars, ver_c, avail_c);
        let available = char_slice(&chars, avail_c, src_c);
        if id.is_empty() || id.contains(' ') || available.is_empty() {
            continue;
        }
        out.push(AppUpdateInfo { id, name, version, available });
    }
    out
}

#[tauri::command]
pub async fn list_app_updates() -> Result<Vec<AppUpdateInfo>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let out = hidden("winget")
            .args(["upgrade", "--accept-source-agreements", "--disable-interactivity"])
            .output()
            .map_err(|_| {
                "Update checks need the Windows Package Manager (winget), which was not found."
                    .to_string()
            })?;
        let text = String::from_utf8_lossy(&out.stdout).to_string();
        Ok(parse_winget_upgrade(&text))
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---------------------------------------------------------------------------
// Startup programs
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartupEntry {
    pub scope: String,
    pub name: String,
    #[serde(default)]
    pub command: String,
    #[serde(default)]
    pub publisher: String,
    pub enabled: bool,
}

#[tauri::command]
pub async fn list_startup_items() -> Result<Vec<StartupEntry>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let script = r#"
$defs = @(
 @{ s='HKCU'; k='HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'; a='HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run' },
 @{ s='HKLM'; k='HKLM:\Software\Microsoft\Windows\CurrentVersion\Run'; a='HKLM:\Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run' },
 @{ s='HKLM32'; k='HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Run'; a='HKLM:\Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run32' }
)
$items = @()
foreach ($d in $defs) {
  $props = Get-ItemProperty -LiteralPath $d.k -ErrorAction SilentlyContinue
  if (-not $props) { continue }
  $ap = Get-ItemProperty -LiteralPath $d.a -ErrorAction SilentlyContinue
  foreach ($p in $props.PSObject.Properties) {
    if ($p.Name -like 'PS*') { continue }
    $enabled = $true
    if ($ap) {
      $prop = $ap.PSObject.Properties[$p.Name]
      if ($prop -and $prop.Value -is [byte[]] -and $prop.Value.Length -gt 0 -and (($prop.Value[0] -band 1) -eq 1)) { $enabled = $false }
    }
    $cmd = [string]$p.Value
    $exe = if ($cmd -match '^\s*"([^"]+)"') { $matches[1] } else { ($cmd -split ' ')[0] }
    $pub = ''
    try { $pub = [string](Get-Item -LiteralPath $exe -ErrorAction Stop).VersionInfo.CompanyName } catch {}
    $items += [pscustomobject]@{ scope = $d.s; name = $p.Name; command = $cmd; publisher = $pub; enabled = $enabled }
  }
}
if (-not $items) { '[]' } else { ConvertTo-Json -InputObject @($items) -Compress }
"#;
        let json = run_powershell(script, &[])?;
        serde_json::from_str::<Vec<StartupEntry>>(&json)
            .map_err(|e| format!("Unexpected startup list format: {}", e))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn set_startup_enabled(scope: String, name: String, enabled: bool) -> Result<String, String> {
    let approved = match scope.as_str() {
        "HKCU" => r"HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run",
        "HKLM" => r"HKLM:\Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run",
        "HKLM32" => r"HKLM:\Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run32",
        _ => return Err("Unknown startup location.".to_string()),
    };
    if name.is_empty() || name.len() > 260 {
        return Err("Invalid startup entry name.".to_string());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let script = r#"
$key = $env:BURROW_ST_KEY
$name = $env:BURROW_ST_NAME
if (-not (Test-Path -LiteralPath $key)) { New-Item -Path $key -Force | Out-Null }
if ($env:BURROW_ST_ON -eq '1') { $bytes = [byte[]](2,0,0,0,0,0,0,0,0,0,0,0) } else { $bytes = [byte[]](3,0,0,0,0,0,0,0,0,0,0,0) }
Set-ItemProperty -LiteralPath $key -Name $name -Value $bytes -Type Binary -ErrorAction Stop
'ok'
"#;
        run_powershell(
            script,
            &[
                ("BURROW_ST_KEY", approved),
                ("BURROW_ST_NAME", &name),
                ("BURROW_ST_ON", if enabled { "1" } else { "0" }),
            ],
        )
        .map_err(|e| {
            if e.to_lowercase().contains("denied") || e.to_lowercase().contains("not allowed") {
                "Windows needs administrator rights to change this item. Close Burrow, right-click it and choose Run as administrator.".to_string()
            } else {
                e
            }
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---------------------------------------------------------------------------
// Downloads scan (big installers and archives)
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadFile {
    pub path: String,
    pub name: String,
    pub size_bytes: u64,
    pub modified_days_ago: u64,
}

const DOWNLOAD_EXTS: [&str; 10] = [
    "exe", "msi", "msix", "msixbundle", "iso", "img", "zip", "7z", "rar", "cab",
];

fn scan_downloads_in(dir: &Path) -> Vec<DownloadFile> {
    let mut out = Vec::new();
    let Ok(rd) = fs::read_dir(dir) else { return out };
    for entry in rd.flatten() {
        let Ok(ft) = entry.file_type() else { continue };
        if !ft.is_file() {
            continue;
        }
        let path = entry.path();
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_lowercase())
            .unwrap_or_default();
        if !DOWNLOAD_EXTS.contains(&ext.as_str()) {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        if meta.len() < 10 * 1024 * 1024 {
            continue;
        }
        out.push(DownloadFile {
            path: path.to_string_lossy().to_string(),
            name: entry.file_name().to_string_lossy().to_string(),
            size_bytes: meta.len(),
            modified_days_ago: days_since(meta.modified().ok()),
        });
    }
    out.sort_by(|a, b| b.size_bytes.cmp(&a.size_bytes));
    out.truncate(40);
    out
}

#[tauri::command]
pub async fn scan_downloads() -> Vec<DownloadFile> {
    tauri::async_runtime::spawn_blocking(|| {
        user_profile()
            .map(|p| scan_downloads_in(&p.join("Downloads")))
            .unwrap_or_default()
    })
    .await
    .unwrap_or_default()
}

// ---------------------------------------------------------------------------
// Developer build folders (node_modules, target, ...)
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PurgeProjectInfo {
    pub project_name: String,
    pub artifact_type: String,
    pub framework: String,
    pub path: String,
    pub size_bytes: u64,
    pub stale_days: u64,
    pub file_count: usize,
}

fn has_file_with_ext(dir: &Path, exts: &[&str]) -> bool {
    fs::read_dir(dir)
        .map(|rd| {
            rd.flatten().any(|e| {
                e.path()
                    .extension()
                    .and_then(|x| x.to_str())
                    .map(|x| exts.contains(&x.to_lowercase().as_str()))
                    .unwrap_or(false)
            })
        })
        .unwrap_or(false)
}

/// Returns (artifact label, framework) when `name` inside `parent` is a regenerable build folder.
pub fn classify_artifact(name: &str, parent: &Path) -> Option<(&'static str, &'static str)> {
    let has = |f: &str| parent.join(f).exists();
    match name {
        "node_modules" if has("package.json") => Some(("node_modules", "Node.js")),
        ".next" if has("package.json") => Some((".next", "Next.js")),
        "dist" if has("package.json") && (has("node_modules") || has("package-lock.json") || has("yarn.lock") || has("pnpm-lock.yaml")) => {
            Some(("dist", "Web build"))
        }
        "target" if has("Cargo.toml") => Some(("target", "Rust")),
        ".venv" if has("pyproject.toml") || has("requirements.txt") || has("setup.py") || has("Pipfile") => {
            Some((".venv", "Python"))
        }
        "bin" | "obj" if has_file_with_ext(parent, &["csproj", "fsproj", "vbproj", "sln"]) => {
            Some(("bin/obj", ".NET"))
        }
        _ => None,
    }
}

const NEVER_DESCEND: [&str; 16] = [
    "appdata", ".git", ".cargo", ".rustup", ".nuget", ".gradle", ".vscode", ".docker", "windows",
    "program files", "program files (x86)", "$recycle.bin", "system volume information",
    ".ssh", ".gnupg", ".aws",
];

fn last_activity_days(parent: &Path, artifact: &str) -> u64 {
    let mut newest: Option<SystemTime> = None;
    if let Ok(rd) = fs::read_dir(parent) {
        for entry in rd.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            let lower = name.to_lowercase();
            if lower == artifact.to_lowercase()
                || matches!(lower.as_str(), "node_modules" | "target" | "bin" | "obj" | ".git" | "dist" | ".next" | ".venv")
            {
                continue;
            }
            if let Ok(m) = entry.metadata().and_then(|m| m.modified()) {
                if newest.map_or(true, |n| m > n) {
                    newest = Some(m);
                }
            }
        }
    }
    days_since(newest)
}

fn scan_purge_roots(roots: Vec<PathBuf>) -> Vec<PurgeProjectInfo> {
    let deadline = Instant::now() + Duration::from_secs(45);
    let mut found: Vec<(PathBuf, &'static str, &'static str)> = Vec::new();
    let mut visited = 0usize;
    let mut stack: Vec<(PathBuf, usize)> = roots.into_iter().map(|r| (r, 0)).collect();

    while let Some((dir, depth)) = stack.pop() {
        visited += 1;
        if visited > 200_000 || Instant::now() > deadline {
            break;
        }
        let Ok(rd) = fs::read_dir(&dir) else { continue };
        for entry in rd.flatten() {
            let Ok(ft) = entry.file_type() else { continue };
            if !ft.is_dir() || ft.is_symlink() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            let lower = name.to_lowercase();
            let path = entry.path();
            if let Some((label, fw)) = classify_artifact(&lower, &dir) {
                found.push((path, label, fw));
                continue; // never look inside build output
            }
            if depth >= 6 || NEVER_DESCEND.contains(&lower.as_str()) || lower == "node_modules" {
                continue;
            }
            if lower.starts_with('.') && lower != ".venv" {
                continue;
            }
            stack.push((path, depth + 1));
        }
    }

    let mut projects: Vec<PurgeProjectInfo> = parallel_map(&found, |(path, label, fw)| {
        let parent = path.parent().unwrap_or(path);
        let artifact_name = path.file_name().and_then(|s| s.to_str()).unwrap_or("");
        let (bytes, files) = dir_size(path);
        PurgeProjectInfo {
            project_name: parent
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or("project")
                .to_string(),
            artifact_type: (*label).to_string(),
            framework: (*fw).to_string(),
            path: path.to_string_lossy().to_string(),
            size_bytes: bytes,
            stale_days: last_activity_days(parent, artifact_name),
            file_count: files,
        }
    });
    projects.retain(|p| p.size_bytes >= 1024 * 1024);
    projects.sort_by(|a, b| b.size_bytes.cmp(&a.size_bytes));
    projects.truncate(200);
    projects
}

#[tauri::command]
pub async fn scan_purge_projects() -> Vec<PurgeProjectInfo> {
    tauri::async_runtime::spawn_blocking(|| {
        let mut roots: Vec<PathBuf> = Vec::new();
        if let Some(p) = user_profile() {
            roots.push(p);
        }
        for drive in ["C", "D", "E"] {
            for dir in ["dev", "src", "code", "projects", "Projects", "repos", "work", "source"] {
                let p = PathBuf::from(format!("{}:\\{}", drive, dir));
                if p.is_dir() {
                    roots.push(p);
                }
            }
        }
        scan_purge_roots(roots)
    })
    .await
    .unwrap_or_default()
}

// ---------------------------------------------------------------------------
// Disk analyzer
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiskNodeOut {
    pub id: String,
    pub name: String,
    pub path: String,
    pub size_bytes: u64,
    pub kind: String,
    pub modified_days_ago: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hash_group: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub children: Option<Vec<DiskNodeOut>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalyzeResult {
    pub root: DiskNodeOut,
    pub scanned_files: usize,
    pub scanned_dirs: usize,
    pub truncated: bool,
}

struct AnalyzeState {
    deadline: Instant,
    files: usize,
    dirs: usize,
    truncated: bool,
}

const KEEP_DEPTH: usize = 5;
const KEEP_CHILDREN: usize = 48;

fn analyze_node(path: &Path, name: String, depth: usize, st: &mut AnalyzeState) -> DiskNodeOut {
    st.dirs += 1;
    let modified = fs::metadata(path).ok().and_then(|m| m.modified().ok());
    let mut total = 0u64;
    let mut kept: Vec<DiskNodeOut> = Vec::new();

    if Instant::now() > st.deadline {
        st.truncated = true;
    } else if let Ok(rd) = fs::read_dir(path) {
        for entry in rd.flatten() {
            let Ok(ft) = entry.file_type() else { continue };
            if ft.is_symlink() {
                continue;
            }
            let child_path = entry.path();
            let child_name = entry.file_name().to_string_lossy().to_string();
            if ft.is_dir() {
                if depth + 1 >= KEEP_DEPTH {
                    st.dirs += 1;
                    let size = if Instant::now() > st.deadline {
                        st.truncated = true;
                        0
                    } else {
                        dir_size(&child_path).0
                    };
                    total += size;
                    kept.push(DiskNodeOut {
                        id: child_path.to_string_lossy().to_string(),
                        name: child_name,
                        path: child_path.to_string_lossy().to_string(),
                        size_bytes: size,
                        kind: "directory".to_string(),
                        modified_days_ago: days_since(entry.metadata().ok().and_then(|m| m.modified().ok())),
                        hash_group: None,
                        children: Some(Vec::new()),
                    });
                } else {
                    let node = analyze_node(&child_path, child_name, depth + 1, st);
                    total += node.size_bytes;
                    kept.push(node);
                }
            } else if let Ok(meta) = entry.metadata() {
                st.files += 1;
                total += meta.len();
                kept.push(DiskNodeOut {
                    id: child_path.to_string_lossy().to_string(),
                    hash_group: if meta.len() > 512 * 1024 {
                        Some(format!("{}:{}", meta.len(), child_name.to_lowercase()))
                    } else {
                        None
                    },
                    name: child_name,
                    path: child_path.to_string_lossy().to_string(),
                    size_bytes: meta.len(),
                    kind: "file".to_string(),
                    modified_days_ago: days_since(meta.modified().ok()),
                    children: None,
                });
            }
        }
    }

    kept.sort_by(|a, b| b.size_bytes.cmp(&a.size_bytes));
    if kept.len() > KEEP_CHILDREN {
        let rest: Vec<DiskNodeOut> = kept.split_off(KEEP_CHILDREN);
        let rest_size: u64 = rest.iter().map(|n| n.size_bytes).sum();
        kept.push(DiskNodeOut {
            id: format!("{}\\(more)", path.to_string_lossy()),
            name: format!("{} smaller items", rest.len()),
            path: path.to_string_lossy().to_string(),
            size_bytes: rest_size,
            kind: "directory".to_string(),
            modified_days_ago: 0,
            hash_group: None,
            children: Some(Vec::new()),
        });
    }

    DiskNodeOut {
        id: path.to_string_lossy().to_string(),
        name,
        path: path.to_string_lossy().to_string(),
        size_bytes: total,
        kind: "directory".to_string(),
        modified_days_ago: days_since(modified),
        hash_group: None,
        children: Some(kept),
    }
}

pub fn analyze_path_sync(raw: &str, budget_secs: u64) -> Result<AnalyzeResult, String> {
    let path = if raw.trim().is_empty() {
        user_profile().ok_or_else(|| "Could not find your user folder.".to_string())?
    } else {
        PathBuf::from(raw.trim())
    };
    if !path.is_dir() {
        return Err(format!("{} is not a folder.", path.display()));
    }
    let name = path
        .file_name()
        .and_then(|s| s.to_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| path.to_string_lossy().trim_end_matches('\\').to_string());
    let mut st = AnalyzeState {
        deadline: Instant::now() + Duration::from_secs(budget_secs),
        files: 0,
        dirs: 0,
        truncated: false,
    };
    let root = analyze_node(&path, name, 0, &mut st);
    Ok(AnalyzeResult {
        root,
        scanned_files: st.files,
        scanned_dirs: st.dirs,
        truncated: st.truncated,
    })
}

/// Map a folder (an empty path means your user folder).
#[tauri::command]
pub async fn analyze_path(path: String) -> Result<AnalyzeResult, String> {
    tauri::async_runtime::spawn_blocking(move || analyze_path_sync(&path, 90))
        .await
        .map_err(|e| e.to_string())?
}

/// Native "choose a folder" window.
#[tauri::command]
pub async fn pick_folder() -> Option<String> {
    tauri::async_runtime::spawn_blocking(|| {
        rfd::FileDialog::new()
            .pick_folder()
            .map(|p| p.to_string_lossy().to_string())
    })
    .await
    .ok()
    .flatten()
}


// ---------------------------------------------------------------------------
// Deep leftover removal (Revo-style): files, folders and registry keys left
// behind after a program was uninstalled.
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LeftoverItem {
    /// "folder", "file" or "registry"
    pub kind: String,
    pub path: String,
    #[serde(default)]
    pub size_bytes: u64,
    /// "safe" items are pre-selected in the review window, "review" items are not.
    #[serde(default)]
    pub risk: String,
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LeftoverQuery {
    pub app_id: String,
    pub name: String,
    #[serde(default)]
    pub publisher: String,
    #[serde(default)]
    pub install_location: String,
    /// Allow cleaning even though the program still has an uninstall entry
    /// (broken or missing uninstaller).
    #[serde(default)]
    pub force: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LeftoverResult {
    pub path: String,
    pub ok: bool,
    pub message: String,
}

fn strip_version_tokens(name: &str) -> String {
    let mut tokens: Vec<&str> = name.split_whitespace().collect();
    while let Some(last) = tokens.last() {
        let l = last.trim_start_matches(['v', 'V']);
        let looks_version = l.chars().next().map_or(false, |c| c.is_ascii_digit())
            && l.chars().all(|c| c.is_ascii_digit() || c == '.' || c == '-' || c == '_');
        if last.starts_with('(') || last.ends_with(')') || looks_version || tokens.len() > 1 && matches!(last.to_lowercase().as_str(), "x64" | "x86" | "64-bit" | "32-bit") {
            tokens.pop();
        } else {
            break;
        }
    }
    tokens.join(" ")
}

fn usable_folder_name(n: &str) -> bool {
    let t = n.trim();
    t.len() >= 3
        && !GENERIC_FOLDERS.contains(&t.to_lowercase().as_str())
        && !t.contains(['\\', '/', ':', '*', '?', '"', '<', '>', '|', '[', ']'])
        && !t.chars().any(|c| c.is_control())
}

fn leftover_names(q: &LeftoverQuery) -> Vec<String> {
    let mut names = vec![q.name.trim().to_string(), strip_version_tokens(&q.name)];
    if let Some(d) = Path::new(&q.install_location).file_name().and_then(|s| s.to_str()) {
        names.push(d.to_string());
    }
    names.retain(|n| usable_folder_name(n));
    names.sort_by_key(|n| n.to_lowercase());
    names.dedup_by_key(|n| n.to_lowercase());
    names
}

/// Install folders must be real application folders, never system or personal ones.
fn safe_install_location(p: &Path) -> bool {
    let norm = p.to_string_lossy().replace('/', "\\").to_ascii_lowercase();
    let norm = norm.trim_end_matches('\\').to_string();
    let depth = norm.split('\\').filter(|s| !s.is_empty()).count();
    if depth < 3 && !norm.contains("program files") {
        return false;
    }
    let mut blocked: Vec<String> = Vec::new();
    for v in ["ProgramFiles", "ProgramFiles(x86)", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "ProgramData", "WINDIR", "SystemRoot"] {
        if let Ok(x) = env::var(v) {
            blocked.push(x.replace('/', "\\").trim_end_matches('\\').to_ascii_lowercase());
        }
    }
    if blocked.iter().any(|b| *b == norm) {
        return false;
    }
    if let Ok(win) = env::var("WINDIR") {
        if norm.starts_with(&format!("{}\\", win.trim_end_matches('\\').to_ascii_lowercase())) {
            return false;
        }
    }
    const DENY: [&str; 9] = ["documents", "desktop", "pictures", "videos", "downloads", "onedrive", ".ssh", "music", "system32"];
    !norm.split('\\').any(|seg| DENY.contains(&seg))
}

/// Candidate folders/files an uninstalled program may have left behind.
pub fn candidate_files(q: &LeftoverQuery) -> Vec<LeftoverItem> {
    let names = leftover_names(q);
    let mut out: Vec<LeftoverItem> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let mut add = |kind: &str, path: PathBuf, out: &mut Vec<LeftoverItem>| {
        let key = path.to_string_lossy().to_lowercase();
        if path.exists() && seen.insert(key) {
            out.push(LeftoverItem {
                kind: kind.to_string(),
                path: path.to_string_lossy().to_string(),
                size_bytes: 0,
                risk: "safe".to_string(),
            });
        }
    };

    if !q.install_location.trim().is_empty() {
        let loc = PathBuf::from(q.install_location.trim().trim_matches('"'));
        if safe_install_location(&loc) {
            add("folder", loc, &mut out);
        }
    }

    let mut roots: Vec<PathBuf> = Vec::new();
    for var in ["LOCALAPPDATA", "APPDATA", "ProgramData", "ProgramFiles", "ProgramFiles(x86)"] {
        if let Ok(v) = env::var(var) {
            roots.push(PathBuf::from(v));
        }
    }
    if let Ok(v) = env::var("LOCALAPPDATA") {
        roots.push(Path::new(&v).join("Programs"));
    }
    for (var, tail) in [
        ("APPDATA", "Microsoft\\Windows\\Start Menu\\Programs"),
        ("ProgramData", "Microsoft\\Windows\\Start Menu\\Programs"),
    ] {
        if let Ok(v) = env::var(var) {
            roots.push(Path::new(&v).join(tail));
        }
    }

    let publisher_ok = usable_folder_name(&q.publisher);
    for root in &roots {
        for n in &names {
            add("folder", root.join(n), &mut out);
            add("file", root.join(format!("{}.lnk", n)), &mut out);
            if publisher_ok {
                add("folder", root.join(q.publisher.trim()).join(n), &mut out);
            }
        }
    }

    // Folders are removed whole, so drop anything nested inside an already listed folder.
    let folders: Vec<String> = out
        .iter()
        .filter(|i| i.kind == "folder")
        .map(|i| i.path.to_lowercase())
        .collect();
    out.retain(|i| {
        let p = i.path.to_lowercase();
        !folders.iter().any(|f| *f != p && p.starts_with(&format!("{}\\", f)))
    });
    out
}

/// Registry keys that commonly remain after an uninstall (checked for existence later).
pub fn candidate_registry_keys(q: &LeftoverQuery) -> Vec<String> {
    let names = leftover_names(q);
    let mut keys: Vec<String> = Vec::new();
    let roots = [
        r"HKCU:\Software",
        r"HKLM:\SOFTWARE",
        r"HKLM:\SOFTWARE\WOW6432Node",
    ];
    let publisher_ok = usable_folder_name(&q.publisher);
    for r in roots {
        for n in &names {
            keys.push(format!(r"{}\{}", r, n));
            if publisher_ok {
                keys.push(format!(r"{}\{}\{}", r, q.publisher.trim(), n));
            }
        }
    }
    if is_valid_registry_key_name(&q.app_id) {
        for base in [
            r"HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall",
            r"HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall",
            r"HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall",
        ] {
            keys.push(format!(r"{}\{}", base, q.app_id));
        }
    }
    keys.sort_by_key(|k| k.to_lowercase());
    keys.dedup_by_key(|k| k.to_lowercase());
    keys
}

fn is_uninstall_key(k: &str) -> bool {
    k.to_lowercase().contains(r"\currentversion\uninstall\")
}

fn existing_registry_keys(keys: &[String]) -> Result<Vec<String>, String> {
    if keys.is_empty() {
        return Ok(Vec::new());
    }
    let joined = keys.join("\n");
    let out = run_powershell(
        r#"$list = $env:BURROW_KEYS -split "`n" | Where-Object { $_ }
$hits = @(); foreach ($k in $list) { if (Test-Path -LiteralPath $k) { $hits += $k } }
if ($hits.Count -eq 0) { '[]' } else { ConvertTo-Json -InputObject @($hits) -Compress }"#,
        &[("BURROW_KEYS", &joined)],
    )?;
    serde_json::from_str::<Vec<String>>(&out).map_err(|e| e.to_string())
}

fn app_still_installed(app_id: &str) -> Result<bool, String> {
    if !is_valid_registry_key_name(app_id) {
        return Ok(false);
    }
    let keys: Vec<String> = candidate_registry_keys(&LeftoverQuery {
        app_id: app_id.to_string(),
        name: String::new(),
        publisher: String::new(),
        install_location: String::new(),
        force: false,
    })
    .into_iter()
    .filter(|k| is_uninstall_key(k))
    .collect();
    Ok(!existing_registry_keys(&keys)?.is_empty())
}

fn find_leftovers_sync(q: LeftoverQuery) -> Result<Vec<LeftoverItem>, String> {
    if !q.force && app_still_installed(&q.app_id)? {
        return Err("This program is still installed. Finish its uninstall first.".to_string());
    }
    let mut items = candidate_files(&q);
    for it in items.iter_mut() {
        it.size_bytes = dir_size(Path::new(&it.path)).0;
    }
    let keys = candidate_registry_keys(&q);
    for k in existing_registry_keys(&keys)? {
        let hklm = k.to_uppercase().starts_with("HKLM");
        let uninstall = is_uninstall_key(&k);
        items.push(LeftoverItem {
            kind: "registry".to_string(),
            path: k,
            size_bytes: 0,
            risk: if hklm && !uninstall { "review" } else { "safe" }.to_string(),
        });
    }
    Ok(items)
}

#[tauri::command]
pub async fn find_app_leftovers(query: LeftoverQuery) -> Result<Vec<LeftoverItem>, String> {
    tauri::async_runtime::spawn_blocking(move || find_leftovers_sync(query))
        .await
        .map_err(|e| e.to_string())?
}

fn delete_leftovers_sync(q: LeftoverQuery, items: Vec<LeftoverItem>) -> Result<Vec<LeftoverResult>, String> {
    if !q.force && app_still_installed(&q.app_id)? {
        return Err("This program is still installed. Finish its uninstall first.".to_string());
    }
    // Only items that this program's own scan would produce may be deleted.
    let allowed_files: HashSet<String> = candidate_files(&q)
        .into_iter()
        .map(|i| i.path.to_lowercase())
        .collect();
    let allowed_keys: HashSet<String> = candidate_registry_keys(&q)
        .into_iter()
        .map(|k| k.to_lowercase())
        .collect();

    let mut results: Vec<LeftoverResult> = Vec::new();
    let mut registry: Vec<String> = Vec::new();

    for it in items {
        match it.kind.as_str() {
            "folder" | "file" => {
                let p = PathBuf::from(&it.path);
                if !allowed_files.contains(&it.path.to_lowercase()) {
                    results.push(LeftoverResult { path: it.path, ok: false, message: "Not a recognised leftover; skipped.".into() });
                    continue;
                }
                let res = if p.is_dir() { fs::remove_dir_all(&p) } else { fs::remove_file(&p) };
                match res {
                    Ok(_) => results.push(LeftoverResult { path: it.path, ok: true, message: "Removed".into() }),
                    Err(e) => results.push(LeftoverResult { path: it.path, ok: false, message: format!("Could not remove: {}", e) }),
                }
            }
            "registry" => {
                if allowed_keys.contains(&it.path.to_lowercase()) {
                    registry.push(it.path);
                } else {
                    results.push(LeftoverResult { path: it.path, ok: false, message: "Not a recognised leftover; skipped.".into() });
                }
            }
            _ => results.push(LeftoverResult { path: it.path, ok: false, message: "Unknown item type; skipped.".into() }),
        }
    }

    if !registry.is_empty() {
        let joined = registry.join("\n");
        let out = run_powershell(
            r#"$dir = Join-Path $env:LOCALAPPDATA 'Burrow\RegistryBackups'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$i = 0
$res = @()
foreach ($k in ($env:BURROW_KEYS -split "`n" | Where-Object { $_ })) {
  $i++
  try {
    if (-not (Test-Path -LiteralPath $k)) { $res += [pscustomobject]@{ path=$k; ok=$true; message='Already gone' }; continue }
    $native = $k -replace '^HKCU:\\','HKCU\' -replace '^HKLM:\\','HKLM\'
    $file = Join-Path $dir ("backup-$stamp-$i.reg")
    & reg.exe export $native $file /y | Out-Null
    Remove-Item -LiteralPath $k -Recurse -Force -ErrorAction Stop
    $res += [pscustomobject]@{ path=$k; ok=$true; message='Removed (backup saved)' }
  } catch {
    $m = $_.Exception.Message
    if ($m -match 'denied|not allowed') { $m = 'Needs administrator rights' }
    $res += [pscustomobject]@{ path=$k; ok=$false; message=$m }
  }
}
ConvertTo-Json -InputObject @($res) -Compress"#,
            &[("BURROW_KEYS", &joined)],
        )?;
        let parsed: Vec<LeftoverResult2> = serde_json::from_str(&out).map_err(|e| e.to_string())?;
        for r in parsed {
            results.push(LeftoverResult { path: r.path, ok: r.ok, message: r.message });
        }
    }
    Ok(results)
}

#[derive(Deserialize)]
struct LeftoverResult2 {
    path: String,
    ok: bool,
    message: String,
}

#[tauri::command]
pub async fn delete_app_leftovers(query: LeftoverQuery, items: Vec<LeftoverItem>) -> Result<Vec<LeftoverResult>, String> {
    tauri::async_runtime::spawn_blocking(move || delete_leftovers_sync(query, items))
        .await
        .map_err(|e| e.to_string())?
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_winget_table() {
        let sample = "\r-\r   \r\\\r   \rName                          Id                       Version      Available    Source\r\n\
-------------------------------------------------------------------------------------------\r\n\
Mozilla Firefox (x64 en-US)   Mozilla.Firefox          130.0        131.0.2      winget\r\n\
7-Zip 23.01 (x64)             7zip.7zip                23.01        24.08        winget\r\n\
2 upgrades available.\r\n";
        let got = parse_winget_upgrade(sample);
        assert_eq!(got.len(), 2);
        assert_eq!(got[0].id, "Mozilla.Firefox");
        assert_eq!(got[0].name, "Mozilla Firefox (x64 en-US)");
        assert_eq!(got[0].version, "130.0");
        assert_eq!(got[0].available, "131.0.2");
        assert_eq!(got[1].id, "7zip.7zip");
    }

    #[test]
    fn winget_nothing_to_upgrade() {
        assert!(parse_winget_upgrade("No installed package found matching input criteria.").is_empty());
    }

    #[test]
    fn install_dates() {
        assert_eq!(install_age_days("garbage"), -1);
        assert!(install_age_days("20200101") > 1000);
        assert_eq!(days_from_civil(1970, 1, 1), 0);
        assert_eq!(days_from_civil(2000, 3, 1), 11017);
    }

    #[test]
    fn registry_key_validation() {
        assert!(is_valid_registry_key_name("{AC76BA86-7AD7-1033-7B44-AC0F074E4100}"));
        assert!(is_valid_registry_key_name("Mozilla Firefox 130.0 (x64 en-US)"));
        assert!(!is_valid_registry_key_name("a\\b"));
        assert!(!is_valid_registry_key_name("x\"; calc; \""));
        assert!(!is_valid_registry_key_name(""));
    }

    fn temp_dir(tag: &str) -> PathBuf {
        let p = env::temp_dir().join(format!("burrow-test-{}-{}", tag, std::process::id()));
        let _ = fs::remove_dir_all(&p);
        fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn finds_build_folders_and_ignores_lookalikes() {
        let root = temp_dir("purge");
        let proj = root.join("webapp");
        fs::create_dir_all(proj.join("node_modules/pkg")).unwrap();
        fs::write(proj.join("package.json"), "{}").unwrap();
        fs::write(proj.join("node_modules/pkg/big.bin"), vec![0u8; 2 * 1024 * 1024]).unwrap();
        // Looks like a build folder but has no project file next to it.
        let stray = root.join("photos");
        fs::create_dir_all(stray.join("target")).unwrap();
        fs::write(stray.join("target/a.jpg"), vec![0u8; 2 * 1024 * 1024]).unwrap();

        let found = scan_purge_roots(vec![root.clone()]);
        assert_eq!(found.len(), 1, "only the real node_modules should be found");
        assert_eq!(found[0].artifact_type, "node_modules");
        assert_eq!(found[0].project_name, "webapp");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn downloads_scan_filters_small_and_other_files() {
        let dir = temp_dir("dl");
        fs::write(dir.join("setup.exe"), vec![0u8; 11 * 1024 * 1024]).unwrap();
        fs::write(dir.join("tiny.exe"), vec![0u8; 1024]).unwrap();
        fs::write(dir.join("holiday.mp4"), vec![0u8; 12 * 1024 * 1024]).unwrap();
        let got = scan_downloads_in(&dir);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].name, "setup.exe");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn analyzer_sums_sizes() {
        let root = temp_dir("an");
        fs::create_dir_all(root.join("a/b")).unwrap();
        fs::write(root.join("a/b/x.bin"), vec![0u8; 1000]).unwrap();
        fs::write(root.join("y.bin"), vec![0u8; 500]).unwrap();
        let res = analyze_path_sync(root.to_str().unwrap(), 30).unwrap();
        assert_eq!(res.root.size_bytes, 1500);
        assert_eq!(res.scanned_files, 2);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn version_tokens_are_stripped() {
        assert_eq!(strip_version_tokens("7-Zip 23.01 (x64)"), "7-Zip");
        assert_eq!(strip_version_tokens("Mozilla Firefox (x64 en-US)"), "Mozilla Firefox");
        assert_eq!(strip_version_tokens("Notepad++ v8.6.2"), "Notepad++");
        assert_eq!(strip_version_tokens("Docker Desktop"), "Docker Desktop");
    }

    #[test]
    fn install_location_guard() {
        std::env::set_var("ProgramFiles", "C:\\Program Files");
        std::env::set_var("USERPROFILE", "C:\\Users\\a");
        assert!(safe_install_location(Path::new("C:\\Program Files\\Zoom")));
        assert!(!safe_install_location(Path::new("C:\\Program Files")));
        assert!(!safe_install_location(Path::new("C:\\Users\\a")));
        assert!(!safe_install_location(Path::new("C:\\Windows\\System32\\x")));
        assert!(!safe_install_location(Path::new("C:\\Users\\a\\Documents\\Tool")));
        assert!(!safe_install_location(Path::new("C:\\")));
    }

    #[test]
    fn leftovers_found_and_registry_candidates_built() {
        let root = temp_dir("left");
        let local = root.join("Local");
        let roaming = root.join("Roaming");
        fs::create_dir_all(local.join("Zoomish/cache")).unwrap();
        fs::create_dir_all(roaming.join("Zoomish")).unwrap();
        fs::create_dir_all(local.join("Microsoft")).unwrap(); // generic, must never match
        std::env::set_var("LOCALAPPDATA", &local);
        std::env::set_var("APPDATA", &roaming);
        let q = LeftoverQuery {
            app_id: "Zoomish".into(),
            name: "Zoomish 5.1 (x64)".into(),
            publisher: "Zoomish Inc.".into(),
            install_location: String::new(),
            force: false,
        };
        let files = candidate_files(&q);
        assert_eq!(files.len(), 2, "{:?}", files.iter().map(|f| &f.path).collect::<Vec<_>>());
        assert!(files.iter().all(|f| f.path.to_lowercase().contains("zoomish")));
        let keys = candidate_registry_keys(&q);
        assert!(keys.iter().any(|k| k == "HKCU:\\Software\\Zoomish"));
        assert!(keys.iter().any(|k| k == "HKLM:\\SOFTWARE\\Zoomish Inc.\\Zoomish"));
        assert!(keys.iter().any(|k| k.ends_with("\\Uninstall\\Zoomish")));
        assert!(!keys.iter().any(|k| k.to_lowercase().ends_with("\\microsoft")));
        let _ = fs::remove_dir_all(&root);
    }
}
