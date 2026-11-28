//! Finds the caches of the apps installed on this PC (browsers with every profile, Steam,
//! Discord, VS Code, ...) so they can be cleaned per app. The list built here is also what
//! the delete code trusts: a path that is not produced by `candidate_groups` is refused.

use crate::native::{dir_size, parallel_map};
use serde::Serialize;
use std::collections::HashSet;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};
use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System};

/// Joins a Windows-style relative path ("Google\\Chrome\\User Data") one folder at a time.
trait JoinWin {
    fn jw(&self, rel: &str) -> PathBuf;
}

impl JoinWin for Path {
    fn jw(&self, rel: &str) -> PathBuf {
        rel.split('\\').filter(|c| !c.is_empty()).fold(self.to_path_buf(), |acc, c| acc.join(c))
    }
}

impl JoinWin for PathBuf {
    fn jw(&self, rel: &str) -> PathBuf {
        self.as_path().jw(rel)
    }
}

pub struct Group {
    pub id: String,
    pub title: String,
    pub description: String,
    pub category: &'static str,
    pub safety: &'static str,
    pub requires_admin: bool,
    /// (process name, display name) of the program that keeps these files open
    pub holder: Option<(&'static str, &'static str)>,
    pub min_age_days: u64,
    pub paths: Vec<PathBuf>,
}

fn var(k: &str) -> Option<PathBuf> {
    env::var(k).ok().filter(|v| !v.trim().is_empty()).map(PathBuf::from)
}

fn dirs_in(base: &Path) -> Vec<PathBuf> {
    fs::read_dir(base)
        .map(|rd| {
            rd.flatten()
                .filter(|e| e.file_type().map(|t| t.is_dir() && !t.is_symlink()).unwrap_or(false))
                .map(|e| e.path())
                .collect()
        })
        .unwrap_or_default()
}

fn existing(paths: Vec<PathBuf>) -> Vec<PathBuf> {
    let mut seen = HashSet::new();
    paths
        .into_iter()
        .filter(|p| p.is_dir())
        .filter(|p| seen.insert(p.to_string_lossy().to_lowercase()))
        .collect()
}

const CHROMIUM_PROFILE_CACHES: [&str; 6] =
    ["Cache", "Code Cache", "GPUCache", "DawnGraphiteCache", "DawnWebGPUCache", "Service Worker\\CacheStorage"];
const CHROMIUM_ROOT_CACHES: [&str; 6] =
    ["ShaderCache", "GrShaderCache", "GraphiteDawnCache", "component_crx_cache", "extensions_crx_cache", "DawnGraphiteCache"];

fn chromium_paths(user_data: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for profile in dirs_in(user_data) {
        let name = profile.file_name().and_then(|s| s.to_str()).unwrap_or("").to_string();
        let is_profile = name == "Default" || name == "System Profile" || name == "Guest Profile" || name.starts_with("Profile ");
        if !is_profile {
            continue;
        }
        for c in CHROMIUM_PROFILE_CACHES {
            out.push(profile.jw(c));
        }
    }
    for c in CHROMIUM_ROOT_CACHES {
        out.push(user_data.jw(c));
    }
    existing(out)
}

fn electron_paths(root: &Path) -> Vec<PathBuf> {
    existing(
        ["Cache", "Code Cache", "GPUCache", "DawnGraphiteCache", "DawnWebGPUCache", "Service Worker\\CacheStorage", "logs"]
            .iter()
            .map(|c| root.jw(c))
            .collect(),
    )
}

/// Everything Burrow knows how to clean on this PC (no sizes yet, so this is quick).
pub fn candidate_groups() -> Vec<Group> {
    let mut groups: Vec<Group> = Vec::new();
    let local = var("LOCALAPPDATA");
    let roaming = var("APPDATA");
    let profile = var("USERPROFILE");
    let windir = var("WINDIR").or_else(|| var("SystemRoot"));
    let program_data = var("ProgramData");

    let mut add = |id: &str, title: &str, desc: &str, category: &'static str, safety: &'static str, admin: bool,
                   holder: Option<(&'static str, &'static str)>, min_age: u64, paths: Vec<PathBuf>| {
        let paths = existing(paths);
        if !paths.is_empty() {
            groups.push(Group {
                id: id.to_string(),
                title: title.to_string(),
                description: desc.to_string(),
                category,
                safety,
                requires_admin: admin,
                holder,
                min_age_days: min_age,
                paths,
            });
        }
    };

    // --- Browsers (every profile) ---
    if let Some(l) = &local {
        add("app-chrome", "Google Chrome caches", "Web cache, code cache and shader caches of every Chrome profile. Passwords, history, bookmarks and sign-ins are kept.",
            "Browser Caches", "safe", false, Some(("chrome.exe", "Chrome")), 0, chromium_paths(&l.jw("Google\\Chrome\\User Data")));
        add("app-edge", "Microsoft Edge caches", "Web cache, code cache and shader caches of every Edge profile. Passwords, history and sign-ins are kept.",
            "Browser Caches", "safe", false, Some(("msedge.exe", "Edge")), 0, chromium_paths(&l.jw("Microsoft\\Edge\\User Data")));
        add("app-brave", "Brave caches", "Web cache and shader caches of every Brave profile.",
            "Browser Caches", "safe", false, Some(("brave.exe", "Brave")), 0, chromium_paths(&l.jw("BraveSoftware\\Brave-Browser\\User Data")));
        let mut ff = Vec::new();
        for p in dirs_in(&l.jw("Mozilla\\Firefox\\Profiles")) {
            ff.push(p.jw("cache2"));
            ff.push(p.jw("startupCache"));
        }
        if let Some(r) = &roaming {
            for p in dirs_in(&r.jw("Mozilla\\Firefox\\Profiles")) {
                ff.push(p.jw("shader-cache"));
            }
        }
        add("app-firefox", "Firefox caches", "Web cache, startup cache and shader cache of every Firefox profile. Bookmarks, logins and history are kept.",
            "Browser Caches", "safe", false, Some(("firefox.exe", "Firefox")), 0, ff);
    }

    // --- Apps ---
    if let Some(l) = &local {
        add("app-steam", "Steam web cache", "Steam's built-in browser cache. Games and saves are not touched.",
            "App Caches", "safe", false, Some(("steam.exe", "Steam")), 0, vec![l.jw("Steam\\htmlcache")]);
    }
    if let Some(r) = &roaming {
        add("app-discord", "Discord cache", "Cached images and code. You stay signed in.",
            "App Caches", "safe", false, Some(("discord.exe", "Discord")), 0, electron_paths(&r.jw("discord")));
        add("app-slack", "Slack cache", "Cached files and code. You stay signed in.",
            "App Caches", "safe", false, Some(("slack.exe", "Slack")), 0, electron_paths(&r.jw("Slack")));
        add("app-teams", "Microsoft Teams cache", "Cached files of classic Microsoft Teams.",
            "App Caches", "safe", false, Some(("teams.exe", "Teams")), 0,
            existing(["Cache", "Code Cache", "GPUCache", "tmp"].iter().map(|c| r.jw("Microsoft\\Teams").jw(c)).collect()));
        add("dev-vscode", "VS Code caches", "Caches and logs of Visual Studio Code. Settings, extensions and workspaces are kept. The first start afterwards is a little slower.",
            "Developer Tools", "safe", false, Some(("code.exe", "VS Code")), 0,
            existing(["Cache", "CachedData", "Code Cache", "GPUCache", "logs"].iter().map(|c| r.jw("Code").jw(c)).collect()));
        add("dev-cursor", "Cursor caches", "Caches and logs of Cursor. Settings and extensions are kept.",
            "Developer Tools", "safe", false, Some(("cursor.exe", "Cursor")), 0,
            existing(["Cache", "CachedData", "Code Cache", "GPUCache", "logs"].iter().map(|c| r.jw("Cursor").jw(c)).collect()));
    }

    // --- Developer package caches ---
    if let Some(l) = &local {
        add("dev-pkg-caches", "Package manager caches", "npm, Yarn, pip and NuGet download caches. Everything is downloaded again when needed.",
            "Developer Tools", "safe", false, None, 0,
            vec![l.jw("npm-cache"), l.jw("Yarn\\Cache"), l.jw("pip\\Cache"), l.jw("NuGet\\v3-cache")]);
    }
    if let Some(p) = &profile {
        add("dev-nuget-packages", "NuGet package folder", "Downloaded .NET packages. Projects restore them again on the next build.",
            "Developer Tools", "moderate", false, None, 0, vec![p.jw(".nuget\\packages")]);
    }

    // --- Windows (current user) ---
    if let Some(l) = &local {
        let mut temp = vec![l.jw("Temp")];
        if let Some(t) = var("TEMP") {
            temp.push(t);
        }
        add("win-user-temp", "Windows temporary files", "Temporary files left by programs. Files from the last 3 days are kept so running programs are not disturbed.",
            "Windows Temp & Logs", "safe", false, None, 3, temp);
        add("win-crash-dumps", "Crash dumps & error reports", "Memory dumps and reports from crashed programs.",
            "Windows Temp & Logs", "safe", false, None, 0,
            vec![l.jw("CrashDumps"), l.jw("Microsoft\\Windows\\WER")]);
        add("win-gpu-caches", "Graphics shader caches", "Compiled graphics shaders (DirectX, NVIDIA, AMD). Rebuilt automatically the next time a game or app needs them.",
            "Windows Temp & Logs", "safe", false, None, 0,
            vec![l.jw("D3DSCache"), l.jw("NVIDIA\\DXCache"), l.jw("NVIDIA\\GLCache"), l.jw("AMD\\DxCache")]);
        add("win-inet-cache", "Windows web cache", "Cached web content used by Windows and older apps.",
            "Windows Temp & Logs", "safe", false, None, 0, vec![l.jw("Microsoft\\Windows\\INetCache")]);
    }

    // --- Windows (whole PC, needs administrator) ---
    if let Some(w) = &windir {
        add("sys-temp", "Windows system temp", "Temporary files used by Windows itself. Files from the last 3 days are kept.",
            "System (administrator)", "safe", true, None, 3, vec![w.jw("Temp")]);
        add("sys-update-cache", "Windows Update downloads", "Installer files for updates that are already installed. Windows downloads them again if needed.",
            "System (administrator)", "moderate", true, None, 0, vec![w.jw("SoftwareDistribution\\Download")]);
        add("sys-delivery-opt", "Delivery Optimization cache", "Update files cached for sharing with other PCs.",
            "System (administrator)", "safe", true, None, 0,
            vec![w.jw("ServiceProfiles\\NetworkService\\AppData\\Local\\Microsoft\\Windows\\DeliveryOptimization\\Cache")]);
        add("sys-minidump", "System crash dumps", "Blue-screen crash dumps.",
            "System (administrator)", "safe", true, None, 0, vec![w.jw("Minidump")]);
    }
    if let Some(pd) = &program_data {
        add("sys-wer", "System error reports", "Error reports collected for the whole PC.",
            "System (administrator)", "safe", true, None, 0,
            vec![pd.jw("Microsoft\\Windows\\WER\\ReportQueue"), pd.jw("Microsoft\\Windows\\WER\\ReportArchive"), pd.jw("Microsoft\\Windows\\WER\\Temp")]);
    }
    groups
}

fn norm(p: &str) -> String {
    p.trim().replace('/', "\\").trim_end_matches('\\').to_lowercase()
}

/// True when `normalized` is one of the folders `candidate_groups` produces.
pub fn is_candidate_path(normalized: &str) -> bool {
    candidate_groups()
        .iter()
        .flat_map(|g| g.paths.iter())
        .any(|p| norm(&p.to_string_lossy()) == normalized)
}

/// Bytes and entries inside `dir` that are older than `min_age_secs` (all of it when 0).
pub fn eligible_size(dir: &Path, min_age_secs: u64) -> (u64, usize) {
    if min_age_secs == 0 {
        let (b, f) = dir_size(dir);
        return (b, f);
    }
    let cutoff = SystemTime::now().checked_sub(Duration::from_secs(min_age_secs));
    let mut bytes = 0u64;
    let mut entries = 0usize;
    if let Ok(rd) = fs::read_dir(dir) {
        for e in rd.flatten() {
            let old_enough = match (e.metadata().and_then(|m| m.modified()).ok(), cutoff) {
                (Some(m), Some(c)) => m <= c,
                _ => true,
            };
            if !old_enough {
                continue;
            }
            entries += 1;
            let is_real_dir = e.file_type().map(|t| t.is_dir() && !t.is_symlink()).unwrap_or(false);
            bytes = bytes.saturating_add(if is_real_dir { dir_size(&e.path()).0 } else { e.metadata().map(|m| m.len()).unwrap_or(0) });
        }
    }
    (bytes, entries)
}

fn running_processes() -> HashSet<String> {
    let mut sys = System::new();
    sys.refresh_processes_specifics(ProcessesToUpdate::All, true, ProcessRefreshKind::nothing());
    sys.processes()
        .values()
        .map(|p| p.name().to_string_lossy().to_lowercase())
        .collect()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredTarget {
    pub id: String,
    pub title: String,
    pub description: String,
    pub category: String,
    pub path: String,
    pub display_path: String,
    pub size_bytes: u64,
    pub item_count: usize,
    pub safety: String,
    pub requires_admin: bool,
    pub holder: Option<String>,
    pub holder_process: Option<String>,
    pub in_use: bool,
    pub min_age_days: u64,
}

pub fn discover_sync() -> Vec<DiscoveredTarget> {
    let groups = candidate_groups();
    let running = running_processes();
    let sized: Vec<(u64, usize)> = parallel_map(&groups, |g| {
        let mut bytes = 0u64;
        let mut items = 0usize;
        for p in &g.paths {
            let (b, i) = eligible_size(p, g.min_age_days * 86_400);
            bytes = bytes.saturating_add(b);
            items += i;
        }
        (bytes, items)
    });

    let mut out: Vec<DiscoveredTarget> = groups
        .into_iter()
        .zip(sized)
        .filter(|(_, (bytes, _))| *bytes >= 1024)
        .map(|(g, (bytes, items))| {
            let path = g.paths.iter().map(|p| p.to_string_lossy().to_string()).collect::<Vec<_>>().join(" + ");
            let first = g.paths.first().map(|p| p.to_string_lossy().to_string()).unwrap_or_default();
            let display_path = if g.paths.len() > 1 { format!("{} (+{} more folders)", first, g.paths.len() - 1) } else { first };
            let in_use = g.holder.map(|(exe, _)| running.contains(exe)).unwrap_or(false);
            DiscoveredTarget {
                id: g.id,
                title: g.title,
                description: g.description,
                category: g.category.to_string(),
                path,
                display_path,
                size_bytes: bytes,
                item_count: items,
                safety: g.safety.to_string(),
                requires_admin: g.requires_admin,
                holder: g.holder.map(|(_, name)| name.to_string()),
                holder_process: g.holder.map(|(exe, _)| exe.to_string()),
                in_use,
                min_age_days: g.min_age_days,
            }
        })
        .collect();

    let (bin_bytes, bin_items) = crate::files::recycle_bin_stats();
    if bin_bytes > 0 {
        out.push(DiscoveredTarget {
            id: "recycle-bin".into(),
            title: "Recycle Bin".into(),
            description: "Everything in the Recycle Bin. It cannot be restored once emptied.".into(),
            category: "Recycle Bin".into(),
            path: "recycle-bin".into(),
            display_path: "Recycle Bin".into(),
            size_bytes: bin_bytes,
            item_count: bin_items,
            safety: "moderate".into(),
            requires_admin: false,
            holder: None,
            holder_process: None,
            in_use: false,
            min_age_days: 0,
        });
    }
    out.sort_by(|a, b| b.size_bytes.cmp(&a.size_bytes));
    out
}

#[tauri::command]
pub async fn discover_clean_targets() -> Vec<DiscoveredTarget> {
    tauri::async_runtime::spawn_blocking(discover_sync).await.unwrap_or_default()
}

const QUITTABLE: [&str; 9] = [
    "chrome.exe", "msedge.exe", "firefox.exe", "brave.exe", "steam.exe", "discord.exe", "slack.exe", "code.exe", "cursor.exe",
];

/// Asks a program to close politely (the same as clicking its X button), so nothing is lost.
#[tauri::command]
pub async fn quit_app(process: String) -> Result<String, String> {
    let name = process.to_lowercase();
    if !QUITTABLE.contains(&name.as_str()) && name != "teams.exe" {
        return Err("This program cannot be closed from Burrow.".to_string());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let out = crate::native::hidden("taskkill")
            .args(["/IM", &name])
            .output()
            .map_err(|e| e.to_string())?;
        if out.status.success() {
            Ok("Closed".to_string())
        } else {
            Err("The program did not close. Please close it yourself and scan again.".to_string())
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let p = env::temp_dir().join(format!("burrow-clean-{}-{}", tag, std::process::id()));
        let _ = fs::remove_dir_all(&p);
        fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn finds_every_browser_profile_but_never_user_data() {
        let _g = crate::ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let root = temp_dir("chrome");
        let ud = root.join("Google/Chrome/User Data");
        for p in ["Default", "Profile 1", "Profile 7", "System Profile"] {
            fs::create_dir_all(ud.join(p).join("Cache")).unwrap();
            fs::write(ud.join(p).join("Cache/f"), vec![0u8; 3000]).unwrap();
            fs::write(ud.join(p).join("Login Data"), "secret").unwrap();
        }
        fs::create_dir_all(ud.join("ShaderCache")).unwrap();
        fs::create_dir_all(ud.join("Crashpad")).unwrap(); // not a cache: must be ignored
        env::set_var("LOCALAPPDATA", &root);
        env::remove_var("APPDATA");
        let g = candidate_groups();
        let chrome = g.iter().find(|x| x.id == "app-chrome").expect("chrome group");
        assert_eq!(chrome.paths.len(), 5, "4 profile caches + ShaderCache: {:?}", chrome.paths);
        assert!(chrome.paths.iter().all(|p| !p.to_string_lossy().contains("Crashpad") && !p.to_string_lossy().contains("Login")));
        assert_eq!(chrome.holder.unwrap().0, "chrome.exe");
        // the delete code only trusts discovered folders
        let first = norm(&chrome.paths[0].to_string_lossy());
        assert!(is_candidate_path(&first));
        assert!(!is_candidate_path(&norm(&ud.join("Default").to_string_lossy())), "a whole profile is not a cache");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn recent_files_are_kept_by_age_rule() {
        let dir = temp_dir("age");
        fs::write(dir.join("old.tmp"), vec![0u8; 5000]).unwrap();
        fs::write(dir.join("new.tmp"), vec![0u8; 7000]).unwrap();
        let old = SystemTime::now() - Duration::from_secs(10 * 86_400);
        fs::File::options().write(true).open(dir.join("old.tmp")).unwrap().set_modified(old).unwrap();
        let (bytes, entries) = eligible_size(&dir, 3 * 86_400);
        assert_eq!((bytes, entries), (5000, 1));
        assert_eq!(eligible_size(&dir, 0).0, 12_000);
        let _ = fs::remove_dir_all(&dir);
    }
}
