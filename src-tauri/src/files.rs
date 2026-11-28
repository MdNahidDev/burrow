//! File actions for the Analyzer and Apps screens: delete to the Recycle Bin, show in
//! Explorer, find and remove real duplicates (verified by file content), app icons and
//! emptying the Recycle Bin. Nothing here ever shows a console window.

use crate::native::{parallel_map, run_powershell};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::env;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime};

// ---------------------------------------------------------------------------
// Safety guard for anything the person chooses to delete
// ---------------------------------------------------------------------------

fn norm(p: &str) -> String {
    p.trim().replace('/', "\\").trim_end_matches('\\').to_lowercase()
}

/// Refuses system folders, drive roots and the main personal folders themselves. The check is
/// made on the path as given AND on where it really lives, so a folder link inside your own
/// files cannot be used to reach Windows or Program Files.
pub fn check_user_deletable(path: &Path) -> Result<(), String> {
    check_lexical(path)?;
    if let Ok(real) = fs::canonicalize(path) {
        let shown = real.to_string_lossy().to_string();
        let plain = shown
            .strip_prefix("\\\\?\\UNC\\")
            .map(|r| format!("\\\\{}", r))
            .or_else(|| shown.strip_prefix("\\\\?\\").map(|r| r.to_string()))
            .unwrap_or(shown);
        check_lexical(Path::new(&plain)).map_err(|_| "This item is really inside a protected folder (it is reached through a link).".to_string())?;
    }
    Ok(())
}

fn check_lexical(path: &Path) -> Result<(), String> {
    let raw = path.to_string_lossy().to_string();
    if raw.trim().is_empty() || !path.is_absolute() {
        return Err("Not a full file path.".to_string());
    }
    if path.components().any(|c| matches!(c, std::path::Component::ParentDir)) {
        return Err("Path contains '..'.".to_string());
    }
    let n = norm(&raw);
    let depth = n.split('\\').filter(|s| !s.is_empty()).count();
    if depth < 3 {
        return Err("Drive roots and top-level folders are protected.".to_string());
    }

    let mut blocked_prefixes: Vec<String> = vec!["c:\\windows".to_string(), "c:\\program files".to_string()];
    for var in ["WINDIR", "SystemRoot", "ProgramFiles", "ProgramFiles(x86)"] {
        if let Ok(v) = env::var(var) {
            blocked_prefixes.push(norm(&v));
        }
    }
    for pre in &blocked_prefixes {
        if !pre.is_empty() && (n == *pre || n.starts_with(&format!("{}\\", pre))) {
            return Err("Windows and Program Files are protected.".to_string());
        }
    }
    if n.contains("\\$recycle.bin") || n.contains("\\system volume information") {
        return Err("System folders are protected.".to_string());
    }

    if let Ok(profile) = env::var("USERPROFILE") {
        let p = norm(&profile);
        let mut exact: Vec<String> = vec![p.clone()];
        for sub in ["Documents", "Desktop", "Downloads", "Pictures", "Videos", "Music", "AppData", "OneDrive"] {
            exact.push(format!("{}\\{}", p, sub.to_lowercase()));
        }
        if exact.iter().any(|e| *e == n) {
            return Err("Your main personal folders are protected. Open them and pick items inside.".to_string());
        }
    }
    Ok(())
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TrashResult {
    pub path: String,
    pub ok: bool,
    pub message: String,
}

fn is_link(p: &Path) -> bool {
    fs::symlink_metadata(p).map(|m| m.file_type().is_symlink()).unwrap_or(false)
}

fn permanent_delete(p: &Path) -> Result<(), String> {
    if is_link(p) {
        return Err("This is a shortcut/link; not deleted.".to_string());
    }
    let res = if p.is_dir() { fs::remove_dir_all(p) } else { fs::remove_file(p) };
    res.map_err(|e| format!("Could not delete: {}", e))
}

/// Reads the `ok<TAB>path` / `fail<TAB>path<TAB>message` lines printed by the Recycle Bin script.
fn parse_recycle_output(text: &str) -> Vec<TrashResult> {
    let mut results = Vec::new();
    for line in text.lines() {
        let parts: Vec<&str> = line.trim_end_matches('\r').splitn(3, '\t').collect();
        match parts.as_slice() {
            ["ok", p] => results.push(TrashResult { path: (*p).to_string(), ok: true, message: "Moved to the Recycle Bin".into() }),
            ["fail", p, m] => results.push(TrashResult {
                path: (*p).to_string(),
                ok: false,
                message: if m.to_lowercase().contains("denied") {
                    "Needs administrator rights or is in use.".to_string()
                } else {
                    (*m).to_string()
                },
            }),
            _ => {}
        }
    }
    results
}

/// Send items to the Recycle Bin using Windows' own shell, so they can be restored.
fn recycle(paths: &[String]) -> Vec<TrashResult> {
    if paths.is_empty() {
        return Vec::new();
    }
    let list_file = env::temp_dir().join(format!("burrow-trash-{}.txt", std::process::id()));
    if fs::write(&list_file, paths.join("\n")).is_err() {
        return paths
            .iter()
            .map(|p| TrashResult { path: p.clone(), ok: false, message: "Could not prepare the list.".into() })
            .collect();
    }
    let script = r#"Add-Type -AssemblyName Microsoft.VisualBasic
foreach ($p in (Get-Content -LiteralPath $env:BURROW_LIST -Encoding UTF8)) {
  if (-not $p) { continue }
  try {
    if (Test-Path -LiteralPath $p -PathType Container) {
      [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($p, 'OnlyErrorDialogs', 'SendToRecycleBin')
    } else {
      [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p, 'OnlyErrorDialogs', 'SendToRecycleBin')
    }
    "ok`t$p"
  } catch {
    $m = ($_.Exception.Message -replace "[`r`n`t]", ' ')
    "fail`t$p`t$m"
  }
}"#;
    let out = run_powershell(script, &[("BURROW_LIST", &list_file.to_string_lossy())]);
    let _ = fs::remove_file(&list_file);

    let mut results: Vec<TrashResult> = Vec::new();
    match out {
        Ok(text) => results.extend(parse_recycle_output(&text)),
        Err(e) => {
            for p in paths {
                results.push(TrashResult { path: p.clone(), ok: false, message: e.clone() });
            }
        }
    }
    // Anything the script did not report is a failure, never a silent success.
    for p in paths {
        if !results.iter().any(|r| r.path == *p) {
            results.push(TrashResult { path: p.clone(), ok: false, message: "No result from Windows.".into() });
        }
    }
    results
}

pub fn trash_paths_sync(paths: Vec<String>, permanent: bool) -> Vec<TrashResult> {
    let mut results: Vec<TrashResult> = Vec::new();
    let mut to_recycle: Vec<String> = Vec::new();
    for raw in paths {
        let p = PathBuf::from(&raw);
        if let Err(msg) = check_user_deletable(&p) {
            results.push(TrashResult { path: raw, ok: false, message: msg });
            continue;
        }
        if !p.exists() {
            results.push(TrashResult { path: raw, ok: false, message: "Already gone.".into() });
            continue;
        }
        if permanent {
            match permanent_delete(&p) {
                Ok(_) => results.push(TrashResult { path: raw, ok: true, message: "Deleted permanently".into() }),
                Err(m) => results.push(TrashResult { path: raw, ok: false, message: m }),
            }
        } else {
            to_recycle.push(raw);
        }
    }
    results.extend(recycle(&to_recycle));
    results
}

/// Delete files or folders. `permanent = false` sends them to the Recycle Bin.
#[tauri::command]
pub async fn trash_paths(paths: Vec<String>, permanent: bool) -> Vec<TrashResult> {
    tauri::async_runtime::spawn_blocking(move || trash_paths_sync(paths, permanent))
        .await
        .unwrap_or_default()
}

/// Opens File Explorer with the item selected.
#[tauri::command]
pub async fn reveal_in_explorer(path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    if !p.exists() {
        return Err("That item no longer exists.".to_string());
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        std::process::Command::new("explorer.exe")
            .raw_arg(format!("/select,\"{}\"", path))
            .spawn()
            .map_err(|e| e.to_string())?;
        Ok(())
    }
    #[cfg(not(windows))]
    {
        Err("Opening File Explorer is only available on Windows.".to_string())
    }
}

// ---------------------------------------------------------------------------
// Duplicate finder (verified by file content, never by name)
// ---------------------------------------------------------------------------

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DupFile {
    pub path: String,
    pub name: String,
    pub modified_days_ago: u64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DupGroup {
    pub hash: String,
    pub size_bytes: u64,
    pub wasted_bytes: u64,
    pub files: Vec<DupFile>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DupResult {
    pub groups: Vec<DupGroup>,
    pub scanned_files: usize,
    pub truncated: bool,
}

const SKIP_DIRS: [&str; 11] = [
    "windows", "program files", "program files (x86)", "$recycle.bin", "system volume information",
    "appdata", ".git", "node_modules", "winsxs", "programdata", "$windows.~bt",
];

fn hash_file(path: &Path, limit: Option<usize>, deadline: Instant) -> Option<String> {
    let mut f = fs::File::open(path).ok()?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    let mut total = 0usize;
    loop {
        if Instant::now() > deadline {
            return None;
        }
        let want = match limit {
            Some(l) => buf.len().min(l.saturating_sub(total)),
            None => buf.len(),
        };
        if want == 0 {
            break;
        }
        let n = f.read(&mut buf[..want]).ok()?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        total += n;
    }
    Some(format!("{:x}", hasher.finalize()))
}

fn days_since(t: Option<SystemTime>) -> u64 {
    t.and_then(|t| SystemTime::now().duration_since(t).ok())
        .map(|d| d.as_secs() / 86_400)
        .unwrap_or(0)
}

/// Several names for the same file (hard links) are one file: deleting one frees nothing.
fn unique_by_identity(files: Vec<PathBuf>) -> Vec<PathBuf> {
    let mut seen: Vec<same_file::Handle> = Vec::new();
    let mut out: Vec<PathBuf> = Vec::new();
    for p in files {
        match same_file::Handle::from_path(&p) {
            Ok(h) => {
                if seen.iter().any(|s| *s == h) {
                    continue;
                }
                seen.push(h);
                out.push(p);
            }
            Err(_) => out.push(p),
        }
    }
    out
}

pub fn find_duplicates_sync(root: &Path, min_size: u64, budget: Duration) -> Result<DupResult, String> {
    if !root.is_dir() {
        return Err(format!("{} is not a folder.", root.display()));
    }
    let deadline = Instant::now() + budget;
    let mut truncated = false;
    let mut scanned = 0usize;

    // 1. Group by size.
    let mut by_size: HashMap<u64, Vec<PathBuf>> = HashMap::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        if Instant::now() > deadline {
            truncated = true;
            break;
        }
        let Ok(rd) = fs::read_dir(&dir) else { continue };
        for entry in rd.flatten() {
            let Ok(ft) = entry.file_type() else { continue };
            if ft.is_symlink() {
                continue;
            }
            if ft.is_dir() {
                let name = entry.file_name().to_string_lossy().to_lowercase();
                if !SKIP_DIRS.contains(&name.as_str()) {
                    stack.push(entry.path());
                }
            } else if let Ok(meta) = entry.metadata() {
                scanned += 1;
                if meta.len() >= min_size {
                    by_size.entry(meta.len()).or_default().push(entry.path());
                }
            }
        }
    }

    // 2. Cheap check: hash the first 64 KB of same-size files.
    let candidates: Vec<(u64, PathBuf)> = by_size
        .into_iter()
        .filter(|(_, v)| v.len() > 1)
        .flat_map(|(size, v)| v.into_iter().map(move |p| (size, p)))
        .collect();
    let heads = parallel_map(&candidates, |(size, p)| (*size, p.clone(), hash_file(p, Some(64 * 1024), deadline)));
    let mut by_head: HashMap<(u64, String), Vec<PathBuf>> = HashMap::new();
    for (size, p, h) in heads {
        match h {
            Some(h) => by_head.entry((size, h)).or_default().push(p),
            None => truncated = true,
        }
    }

    // 3. Full hash only for files that still look identical.
    let survivors: Vec<(u64, PathBuf)> = by_head
        .into_iter()
        .filter(|(_, v)| v.len() > 1)
        .flat_map(|((size, _), v)| v.into_iter().map(move |p| (size, p)))
        .collect();
    let fulls = parallel_map(&survivors, |(size, p)| (*size, p.clone(), hash_file(p, None, deadline)));
    let mut by_full: HashMap<(u64, String), Vec<PathBuf>> = HashMap::new();
    for (size, p, h) in fulls {
        match h {
            Some(h) => by_full.entry((size, h)).or_default().push(p),
            None => truncated = true,
        }
    }

    let mut groups: Vec<DupGroup> = by_full
        .into_iter()
        .map(|(k, v)| (k, unique_by_identity(v)))
        .filter(|(_, v)| v.len() > 1)
        .map(|((size, hash), mut files)| {
            files.sort_by_key(|p| fs::metadata(p).and_then(|m| m.modified()).ok());
            let n = files.len() as u64;
            DupGroup {
                hash,
                size_bytes: size,
                wasted_bytes: size * (n - 1),
                files: files
                    .into_iter()
                    .map(|p| DupFile {
                        name: p.file_name().and_then(|s| s.to_str()).unwrap_or("").to_string(),
                        modified_days_ago: days_since(fs::metadata(&p).and_then(|m| m.modified()).ok()),
                        path: p.to_string_lossy().to_string(),
                    })
                    .collect(),
            }
        })
        .collect();
    groups.sort_by(|a, b| b.wasted_bytes.cmp(&a.wasted_bytes));
    groups.truncate(300);
    Ok(DupResult { groups, scanned_files: scanned, truncated })
}

/// Find identical files inside a folder.
#[tauri::command]
pub async fn find_duplicates(path: String) -> Result<DupResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        find_duplicates_sync(Path::new(path.trim()), 1024 * 1024, Duration::from_secs(150))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DupDelete {
    pub keep: String,
    pub delete: Vec<String>,
}

/// Deletes the chosen copies, but only after re-checking that each one is still byte-for-byte
/// identical to the copy being kept.
pub fn delete_duplicates_sync(items: Vec<DupDelete>, permanent: bool) -> Vec<TrashResult> {
    let far = Instant::now() + Duration::from_secs(3600);
    let mut results: Vec<TrashResult> = Vec::new();
    let mut verified: Vec<String> = Vec::new();

    for item in items {
        let keep = PathBuf::from(&item.keep);
        let keep_hash = if keep.is_file() { hash_file(&keep, None, far) } else { None };
        for d in item.delete {
            let dp = PathBuf::from(&d);
            if d == item.keep {
                results.push(TrashResult { path: d, ok: false, message: "This is the copy being kept.".into() });
                continue;
            }
            let Some(kh) = &keep_hash else {
                results.push(TrashResult { path: d, ok: false, message: "The copy to keep is missing, so nothing was deleted.".into() });
                continue;
            };
            let same = dp.is_file() && hash_file(&dp, None, far).as_ref() == Some(kh);
            if same {
                verified.push(d);
            } else {
                results.push(TrashResult { path: d, ok: false, message: "File changed since the scan; not deleted.".into() });
            }
        }
    }
    results.extend(trash_paths_sync(verified, permanent));
    results
}

#[tauri::command]
pub async fn delete_duplicates(items: Vec<DupDelete>, permanent: bool) -> Vec<TrashResult> {
    tauri::async_runtime::spawn_blocking(move || delete_duplicates_sync(items, permanent))
        .await
        .unwrap_or_default()
}

// ---------------------------------------------------------------------------
// App icons
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct IconRequest {
    pub id: String,
    pub path: String,
}

fn expand_vars(s: &str) -> String {
    let mut out = s.to_string();
    for key in ["SystemRoot", "WINDIR", "ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA", "APPDATA", "ProgramData", "USERPROFILE"] {
        if let Ok(v) = env::var(key) {
            out = out.replace(&format!("%{}%", key), &v);
            out = out.replace(&format!("%{}%", key.to_uppercase()), &v);
        }
    }
    out
}

/// False for network (UNC) paths, which would make Windows contact another computer.
fn is_local_path(p: &str) -> bool {
    let t = p.trim();
    !(t.starts_with("\\\\") || t.starts_with("//"))
}

fn icon_ext_ok(p: &Path) -> bool {
    p.extension()
        .and_then(|e| e.to_str())
        .map(|e| matches!(e.to_lowercase().as_str(), "exe" | "ico" | "dll" | "lnk" | "msi"))
        .unwrap_or(false)
}

/// First existing program file from a Windows command line such as `"C:\x\a.exe" /flag`.
pub fn exe_from_command(cmd: &str) -> Option<PathBuf> {
    let t = cmd.trim();
    let candidate = if let Some(rest) = t.strip_prefix('"') {
        rest.split('"').next().unwrap_or("").to_string()
    } else {
        let lower = t.to_lowercase();
        match lower.find(".exe") {
            Some(i) => t[..i + 4].to_string(),
            None => t.split(' ').next().unwrap_or("").to_string(),
        }
    };
    let p = PathBuf::from(expand_vars(&candidate));
    if p.is_file() && icon_ext_ok(&p) {
        Some(p)
    } else {
        None
    }
}

/// Best file to take an icon from for an installed program.
pub fn pick_icon_path(display_icon: &str, location: &str, app_name: &str) -> Option<PathBuf> {
    let di = display_icon.trim();
    if !di.is_empty() {
        // "C:\path\app.exe",0  or  C:\path\app.exe,0
        let mut s = di.to_string();
        if let Some(i) = s.rfind(',') {
            if s[i + 1..].trim().trim_start_matches('-').chars().all(|c| c.is_ascii_digit()) {
                s.truncate(i);
            }
        }
        let s = s.trim().trim_matches('"').to_string();
        let p = PathBuf::from(expand_vars(&s));
        if p.is_file() && icon_ext_ok(&p) {
            return Some(p);
        }
    }

    let loc = PathBuf::from(expand_vars(location.trim().trim_matches('"')));
    if !loc.is_dir() {
        return None;
    }
    let key = |s: &str| s.chars().filter(|c| c.is_alphanumeric()).collect::<String>().to_lowercase();
    let app_key = key(app_name);
    let mut exes: Vec<PathBuf> = fs::read_dir(&loc)
        .ok()?
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().and_then(|e| e.to_str()).map(|e| e.eq_ignore_ascii_case("exe")).unwrap_or(false))
        .filter(|p| {
            let n = p.file_stem().and_then(|s| s.to_str()).unwrap_or("").to_lowercase();
            !["unins", "uninstall", "setup", "update", "crash", "helper", "report", "vc_redist"].iter().any(|bad| n.contains(bad))
        })
        .collect();
    exes.sort();
    let stem_key = |p: &PathBuf| key(p.file_stem().and_then(|s| s.to_str()).unwrap_or(""));
    exes.iter()
        .find(|p| {
            let k = stem_key(p);
            !k.is_empty() && (app_key.contains(&k) || k.contains(&app_key))
        })
        .cloned()
        .or_else(|| exes.into_iter().next())
}

/// Returns `id -> PNG (base64)` for every request whose icon could be read.
#[tauri::command]
pub async fn get_app_icons(items: Vec<IconRequest>) -> HashMap<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let good: Vec<&IconRequest> = items
            .iter()
            .filter(|i| !i.id.contains(['\t', '\n', '\r']) && !i.path.contains(['\t', '\n', '\r']))
            .filter(|i| is_local_path(&i.path))
            .filter(|i| Path::new(&i.path).is_file() && icon_ext_ok(Path::new(&i.path)))
            .collect();
        if good.is_empty() {
            return HashMap::new();
        }
        let list_file = env::temp_dir().join(format!("burrow-icons-{}.txt", std::process::id()));
        let body = good.iter().map(|i| format!("{}\t{}", i.id, i.path)).collect::<Vec<_>>().join("\n");
        if fs::write(&list_file, body).is_err() {
            return HashMap::new();
        }
        let script = r#"Add-Type -AssemblyName System.Drawing
foreach ($line in (Get-Content -LiteralPath $env:BURROW_LIST -Encoding UTF8)) {
  $parts = $line -split "`t", 2
  if ($parts.Count -lt 2) { continue }
  try {
    $icon = [System.Drawing.Icon]::ExtractAssociatedIcon($parts[1])
    if ($icon) {
      $bmp = $icon.ToBitmap()
      $ms = New-Object System.IO.MemoryStream
      $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
      $parts[0] + "`t" + [Convert]::ToBase64String($ms.ToArray())
      $bmp.Dispose(); $ms.Dispose(); $icon.Dispose()
    }
  } catch {}
}"#;
        let out = run_powershell(script, &[("BURROW_LIST", &list_file.to_string_lossy())]);
        let _ = fs::remove_file(&list_file);
        let mut map = HashMap::new();
        if let Ok(text) = out {
            for line in text.lines() {
                if let Some((id, b64)) = line.split_once('\t') {
                    if !b64.trim().is_empty() {
                        map.insert(id.to_string(), b64.trim().to_string());
                    }
                }
            }
        }
        map
    })
    .await
    .unwrap_or_default()
}

// ---------------------------------------------------------------------------
// Recycle Bin
// ---------------------------------------------------------------------------

/// (bytes, item count) currently in the Recycle Bin.
pub fn recycle_bin_stats() -> (u64, usize) {
    let script = r#"$shell = New-Object -ComObject Shell.Application
$items = @($shell.NameSpace(10).Items())
$sum = 0
foreach ($i in $items) { $sum += [int64]$i.ExtendedProperty('Size') }
"$sum|$($items.Count)""#;
    match run_powershell(script, &[]) {
        Ok(out) => {
            let mut it = out.trim().split('|');
            let bytes = it.next().and_then(|s| s.trim().parse::<u64>().ok()).unwrap_or(0);
            let count = it.next().and_then(|s| s.trim().parse::<usize>().ok()).unwrap_or(0);
            (bytes, count)
        }
        Err(_) => (0, 0),
    }
}

#[tauri::command]
pub async fn empty_recycle_bin() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(|| {
        run_powershell("Clear-RecycleBin -Force -ErrorAction Stop; 'emptied'", &[]).map_err(|e| {
            if e.to_lowercase().contains("empty") {
                "The Recycle Bin is already empty.".to_string()
            } else {
                e
            }
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let p = env::temp_dir().join(format!("burrow-files-{}-{}", tag, std::process::id()));
        let _ = fs::remove_dir_all(&p);
        fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn recycle_script_output_is_understood() {
        // Lines captured from the real script (CRLF line ends included).
        let out = "ok\tC:\\Users\\a\\big.iso\r\nfail\tC:\\Users\\a\\locked.zip\tAccess to the path is denied.\r\nfail\tC:\\gone.txt\tCould not find file 'C:\\gone.txt'.\r\n";
        let r = parse_recycle_output(out);
        assert_eq!(r.len(), 3);
        assert!(r[0].ok && r[0].path == "C:\\Users\\a\\big.iso");
        assert!(!r[1].ok && r[1].message.contains("administrator"));
        assert!(!r[2].ok && r[2].message.contains("Could not find"));
    }

    #[cfg(unix)]
    #[test]
    fn hard_links_are_not_reported_as_wasted_space() {
        let dir = temp_dir("hardlink");
        let data = vec![5u8; 2 * 1024 * 1024];
        fs::write(dir.join("original.bin"), &data).unwrap();
        fs::hard_link(dir.join("original.bin"), dir.join("linked-name.bin")).unwrap();
        // only two names for ONE file: nothing to free
        let res = find_duplicates_sync(&dir, 1024 * 1024, Duration::from_secs(30)).unwrap();
        assert!(res.groups.is_empty(), "hard links must not count as duplicates");
        // add a real copy: the group appears, and the linked pair counts once
        fs::write(dir.join("real-copy.bin"), &data).unwrap();
        let res = find_duplicates_sync(&dir, 1024 * 1024, Duration::from_secs(30)).unwrap();
        assert_eq!(res.groups.len(), 1);
        assert_eq!(res.groups[0].files.len(), 2);
        assert_eq!(res.groups[0].wasted_bytes, 2 * 1024 * 1024);
        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn a_link_into_a_protected_folder_is_refused() {
        let _g = crate::ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let base = temp_dir("linkguard");
        let protected = base.join("WindowsLike");
        let profile = base.join("profile");
        fs::create_dir_all(protected.join("System32")).unwrap();
        fs::create_dir_all(&profile).unwrap();
        fs::write(protected.join("System32/important.dll"), "x").unwrap();
        std::os::unix::fs::symlink(&protected, profile.join("shortcut")).unwrap();
        env::set_var("WINDIR", protected.to_string_lossy().to_string());
        env::set_var("USERPROFILE", profile.to_string_lossy().to_string());
        // lexically this path is inside the user's own folder, but it really lives in the protected one
        let sneaky = profile.join("shortcut/System32/important.dll");
        assert!(check_user_deletable(&sneaky).is_err());
        let res = trash_paths_sync(vec![sneaky.to_string_lossy().to_string()], true);
        assert!(!res[0].ok);
        assert!(protected.join("System32/important.dll").exists(), "the protected file must survive");
        env::remove_var("WINDIR");
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn network_paths_are_never_used_for_icons() {
        assert!(!is_local_path("\\\\attacker\\share\\a.exe"));
        assert!(!is_local_path("//attacker/share/a.exe"));
        assert!(is_local_path("C:\\Program Files\\App\\a.exe"));
    }

    #[test]
    fn protects_system_and_personal_roots() {
        let _g = crate::ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        env::set_var("USERPROFILE", "C:\\Users\\a");
        assert!(check_user_deletable(Path::new("C:\\Windows\\System32\\x.dll")).is_err());
        assert!(check_user_deletable(Path::new("C:\\Program Files\\App\\a.exe")).is_err());
        assert!(check_user_deletable(Path::new("C:\\")).is_err());
        assert!(check_user_deletable(Path::new("C:\\Users")).is_err());
        assert!(check_user_deletable(Path::new("relative\\path")).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn user_files_can_be_deleted_but_not_personal_roots() {
        let _g = crate::ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let dir = temp_dir("del");
        env::set_var("USERPROFILE", dir.to_string_lossy().to_string());
        fs::create_dir_all(dir.join("Documents")).unwrap();
        fs::write(dir.join("Documents/big.iso"), "x").unwrap();
        // the Documents folder itself is protected, a file inside it is not
        let res = trash_paths_sync(vec![dir.join("Documents").to_string_lossy().to_string()], true);
        assert!(!res[0].ok, "{}", res[0].message);
        assert!(dir.join("Documents").exists());
        let res = trash_paths_sync(vec![dir.join("Documents/big.iso").to_string_lossy().to_string()], true);
        assert!(res[0].ok, "{}", res[0].message);
        assert!(!dir.join("Documents/big.iso").exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn duplicates_are_found_by_content_not_name() {
        let dir = temp_dir("dup");
        fs::create_dir_all(dir.join("a")).unwrap();
        fs::create_dir_all(dir.join("b")).unwrap();
        let big = vec![7u8; 2 * 1024 * 1024];
        fs::write(dir.join("a/movie.mkv"), &big).unwrap();
        fs::write(dir.join("b/copy of movie.mkv"), &big).unwrap();
        fs::write(dir.join("b/renamed.bin"), &big).unwrap();
        // same size and same name, different content: must NOT be reported
        let mut other = big.clone();
        other[1_000_000] = 9;
        fs::write(dir.join("a/other.mkv"), &other).unwrap();
        fs::write(dir.join("b/other.mkv"), vec![8u8; 2 * 1024 * 1024]).unwrap();

        let res = find_duplicates_sync(&dir, 1024 * 1024, Duration::from_secs(30)).unwrap();
        assert_eq!(res.groups.len(), 1, "{:?}", res.groups.iter().map(|g| g.files.len()).collect::<Vec<_>>());
        assert_eq!(res.groups[0].files.len(), 3);
        assert_eq!(res.groups[0].wasted_bytes, 2 * 2 * 1024 * 1024);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn duplicate_delete_rechecks_content_and_keeps_one() {
        let _g = crate::ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let dir = temp_dir("dupdel");
        env::set_var("USERPROFILE", "/nonexistent-profile");
        let data = vec![3u8; 1500];
        let keep = dir.join("keep.bin");
        let same = dir.join("same.bin");
        let changed = dir.join("changed.bin");
        fs::write(&keep, &data).unwrap();
        fs::write(&same, &data).unwrap();
        fs::write(&changed, &data).unwrap();
        fs::write(&changed, b"edited after the scan").unwrap();

        let res = delete_duplicates_sync(
            vec![DupDelete {
                keep: keep.to_string_lossy().to_string(),
                delete: vec![
                    same.to_string_lossy().to_string(),
                    changed.to_string_lossy().to_string(),
                    keep.to_string_lossy().to_string(),
                ],
            }],
            true,
        );
        assert!(keep.exists(), "the kept copy must survive");
        assert!(!same.exists(), "the identical copy is removed");
        assert!(changed.exists(), "a file that changed must not be deleted");
        assert_eq!(res.iter().filter(|r| r.ok).count(), 1);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn icon_source_is_chosen_sensibly() {
        let _g = crate::ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let dir = temp_dir("icon");
        fs::write(dir.join("unins000.exe"), "x").unwrap();
        fs::write(dir.join("zoomish.exe"), "x").unwrap();
        fs::write(dir.join("helper.exe"), "x").unwrap();
        let picked = pick_icon_path("", &dir.to_string_lossy(), "Zoomish 5.1").unwrap();
        assert_eq!(picked.file_name().unwrap(), "zoomish.exe");

        // DisplayIcon with an index wins
        let via_display = pick_icon_path(&format!("\"{}\",0", dir.join("helper.exe").display()), "", "Zoomish").unwrap();
        assert_eq!(via_display.file_name().unwrap(), "helper.exe");
        assert!(pick_icon_path("", "/does/not/exist", "X").is_none());

        let cmd = format!("\"{}\" /background", dir.join("zoomish.exe").display());
        assert_eq!(exe_from_command(&cmd).unwrap().file_name().unwrap(), "zoomish.exe");
        let _ = fs::remove_dir_all(&dir);
    }
}
