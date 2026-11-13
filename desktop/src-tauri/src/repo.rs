//! `repo_*` commands: link a folder on this computer to a canvas, then answer
//! the server's read requests inside it. The grant (`linkId` → absolute path)
//! lives in `repo-grants.json` in the app data dir — the path never leaves
//! the machine; only the id and the folder's basename reach the server.
//!
//! Every read is sandboxed to the picked root: relative paths may not contain
//! `..` or escape the canonicalized root (a symlink pointing outside resolves
//! away and is refused), names on the denylist — `.env*`, keys, credential
//! files — are never listed or read, and `.git`/`node_modules`-style dirs are
//! never descended. The caps below mirror `shared/localRepo.ts`; keep the two
//! in step.
//!
//! `repo_write_change` is the single write surface, for the "Ready for dev →
//! Stip" handoff: it creates a brand-new `.workflow/changes/<id>/` folder —
//! never an overwrite, never outside it — and only after the person confirms
//! a native dialog listing every file. Same sandbox as the reads, stricter:
//! no symlink anywhere on a write path is followed.

use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

const MAX_ENTRIES: usize = 2000;
const DEFAULT_DEPTH: usize = 4;
const MAX_DEPTH: usize = 8;
const MAX_READ_FILES: usize = 12;
const MAX_FILE_BYTES: u64 = 128 * 1024;
const MAX_READ_BYTES: usize = 200 * 1024;
const MAX_SEARCH_MATCHES: usize = 100;
const MAX_PATH_CHARS: usize = 500;
const MAX_QUERY_CHARS: usize = 200;
const MAX_LINE_CHARS: usize = 300;

/* `repo_write_change` — mirror shared/handoff.ts, keep in step. */
const WRITE_ROOT: &str = ".workflow/changes";
const MAX_WRITE_FILES: usize = 24;
const MAX_WRITE_FILE_BYTES: usize = 4 * 1024 * 1024;
const MAX_WRITE_BYTES: usize = 12 * 1024 * 1024;
const MAX_CHANGE_ID: usize = 100;

/// Dirs never listed, descended into, or read under — anywhere in the tree.
const SKIP_DIRS: &[&str] = &[".git", ".svn", ".hg", "node_modules"];
/// File names never listed or read; `*` is a wildcard (see `denied_name`).
const DENY_NAMES: &[&str] = &[
    ".env*",
    "*.pem",
    "*.key",
    "*.p12",
    "*.keystore",
    "*.asc",
    "id_rsa*",
    "*.kdbx",
    "*credential*",
    "*secret*",
    ".netrc",
    ".npmrc",
    ".pypirc",
    "*.tfvars",
];

/* ------------------------------------------------------------------ */
/* grants                                                              */
/* ------------------------------------------------------------------ */

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Grant {
    path: String,
    name: String,
    #[serde(default)]
    canvas_id: String,
    at: u64,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn grants_file(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("repo-grants.json"))
}

fn load_grants(app: &AppHandle) -> Result<BTreeMap<String, Grant>, String> {
    let file = grants_file(app)?;
    match fs::read_to_string(&file) {
        Ok(text) => serde_json::from_str(&text).map_err(|e| e.to_string()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(BTreeMap::new()),
        Err(e) => Err(e.to_string()),
    }
}

/// Write-then-rename so a crash mid-save can't leave a half-written file.
fn save_grants(app: &AppHandle, grants: &BTreeMap<String, Grant>) -> Result<(), String> {
    let file = grants_file(app)?;
    let tmp = file.with_extension("tmp");
    fs::write(&tmp, serde_json::to_string(grants).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    fs::rename(&tmp, &file).map_err(|e| e.to_string())
}

/// The grant row `link_id` names on this device.
fn grant_for(app: &AppHandle, link_id: &str) -> Result<Grant, String> {
    let grants = load_grants(app)?;
    grants
        .get(link_id)
        .cloned()
        .ok_or_else(|| "This device does not hold that project's grant".to_string())
}

/// The grant's folder, canonicalized: reads are checked against this root.
fn grant_root(app: &AppHandle, link_id: &str) -> Result<PathBuf, String> {
    let grant = grant_for(app, link_id)?;
    let root = PathBuf::from(&grant.path)
        .canonicalize()
        .map_err(|_| "The linked folder moved or was removed".to_string())?;
    if !root.is_dir() {
        return Err("The linked folder is not a directory".to_string());
    }
    Ok(root)
}

/* ------------------------------------------------------------------ */
/* sandbox                                                             */
/* ------------------------------------------------------------------ */

/// `*` matches any run of characters (slashes included); `?` one character.
/// Case-insensitive — the denylist is about names, not case games.
fn glob_match(pattern: &str, text: &str) -> bool {
    let p: Vec<char> = pattern.chars().flat_map(char::to_lowercase).collect();
    let t: Vec<char> = text.chars().flat_map(char::to_lowercase).collect();
    fn go(p: &[char], t: &[char]) -> bool {
        match p.split_first() {
            None => t.is_empty(),
            Some(('*', rest)) => (0..=t.len()).any(|n| go(rest, &t[n..])),
            Some(('?', rest)) => !t.is_empty() && go(rest, &t[1..]),
            Some((c, rest)) => t.first() == Some(c) && go(rest, &t[1..]),
        }
    }
    go(&p, &t)
}

fn denied_name(name: &str) -> bool {
    DENY_NAMES.iter().any(|pat| glob_match(pat, name))
}

/// Whether any path component is skipped or denied: `a/node_modules/x` or
/// `sub/.env` are refused even though their leaf name looks fine.
fn denied_rel(rel: &Path) -> bool {
    rel.components().any(|c| match c {
        Component::Normal(name) => {
            let name = name.to_string_lossy();
            denied_name(&name) || SKIP_DIRS.iter().any(|s| name.eq_ignore_ascii_case(s))
        }
        _ => false,
    })
}

/// `rel` joined under `root`, canonicalized and proven inside it — `..`,
/// absolute paths and symlinks that leave the root are refused. `.` parts
/// are tolerated (`./src` means `src`); anything else non-normal is denied.
fn resolve_under(root: &Path, rel: &str) -> Result<PathBuf, &'static str> {
    if rel.chars().count() > MAX_PATH_CHARS {
        return Err("denied");
    }
    let mut clean = PathBuf::new();
    for c in Path::new(rel).components() {
        match c {
            Component::Normal(name) => clean.push(name),
            Component::CurDir => {}
            _ => return Err("denied"),
        }
    }
    if clean.as_os_str().is_empty() {
        return Ok(root.to_path_buf());
    }
    if denied_rel(&clean) {
        return Err("denied");
    }
    let canonical = root
        .join(&clean)
        .canonicalize()
        .map_err(|_| "missing")?;
    if !canonical.starts_with(root) {
        return Err("denied");
    }
    Ok(canonical)
}

/// A symlink inside the tree may point back inside the root; only ones that
/// would escape are dropped. Returns the effective kind via canonical path.
fn entry_kind(root: &Path, path: &Path) -> Option<bool> {
    let meta = fs::symlink_metadata(path).ok()?;
    if !meta.file_type().is_symlink() {
        return Some(meta.is_dir());
    }
    let canonical = path.canonicalize().ok()?;
    if !canonical.starts_with(root) {
        return None;
    }
    fs::metadata(&canonical).ok().map(|m| m.is_dir())
}

/// Repo-relative `/`-joined path for `path`, which must sit under `root`.
fn rel_string(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .components()
        .filter_map(|c| match c {
            Component::Normal(name) => Some(name.to_string_lossy().into_owned()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("/")
}

/* ------------------------------------------------------------------ */
/* tree walking                                                        */
/* ------------------------------------------------------------------ */

struct Walk {
    root: PathBuf,
    depth_left: usize,
    visited: usize,
}

impl Walk {
    /// List `dir`'s children into `entries`, recursing while depth and the
    /// shared entry budget last.
    fn run(&mut self, dir: &Path, rel: &str, entries: &mut Vec<Value>) {
        if self.visited >= MAX_ENTRIES {
            return;
        }
        let mut children: Vec<PathBuf> = match fs::read_dir(dir) {
            Ok(rd) => rd.filter_map(|e| e.ok().map(|e| e.path())).collect(),
            Err(_) => return,
        };
        children.sort();
        for child in children {
            if self.visited >= MAX_ENTRIES {
                break;
            }
            let name = match child.file_name() {
                Some(n) => n.to_string_lossy().into_owned(),
                None => continue,
            };
            if denied_name(&name) || SKIP_DIRS.iter().any(|s| name.eq_ignore_ascii_case(s)) {
                continue;
            }
            let Some(is_dir) = entry_kind(&self.root, &child) else {
                continue;
            };
            let child_rel = if rel.is_empty() {
                name.clone()
            } else {
                format!("{}/{}", rel, name)
            };
            entries.push(if is_dir {
                json!({ "path": child_rel, "kind": "dir" })
            } else {
                let size = fs::metadata(&child).map(|m| m.len()).unwrap_or(0);
                json!({ "path": child_rel, "kind": "file", "size": size })
            });
            self.visited += 1;
            if is_dir && self.depth_left > 0 {
                self.depth_left -= 1;
                self.run(&child, &child_rel, entries);
                self.depth_left += 1;
            }
        }
    }
}

fn walk(root: &Path, rel: &str, depth: usize) -> (Vec<Value>, bool) {
    let mut entries = Vec::new();
    let mut w = Walk {
        root: root.to_path_buf(),
        depth_left: depth,
        visited: 0,
    };
    let dir = if rel.is_empty() {
        root.to_path_buf()
    } else {
        root.join(rel)
    };
    w.run(&dir, rel, &mut entries);
    (entries, w.visited >= MAX_ENTRIES)
}

/* ------------------------------------------------------------------ */
/* search                                                              */
/* ------------------------------------------------------------------ */

/// `glob` applies to the file name when it has no `/`, else the whole
/// repo-relative path — `*.tsx` finds `src/a.tsx` and `src/*` too.
fn glob_allows(glob: Option<&str>, name: &str, rel: &str) -> bool {
    match glob {
        None => true,
        Some(pat) => {
            if pat.contains('/') {
                glob_match(pat, rel)
            } else {
                glob_match(pat, name)
            }
        }
    }
}

fn search_file(
    rel: &str,
    path: &Path,
    matcher: &dyn Fn(&str) -> bool,
    limit: usize,
    matches: &mut Vec<Value>,
) {
    let meta = match fs::metadata(path) {
        Ok(m) => m,
        Err(_) => return,
    };
    if meta.len() > MAX_FILE_BYTES || !meta.is_file() {
        return;
    }
    let Ok(bytes) = fs::read(path) else { return };
    let Ok(text) = String::from_utf8(bytes) else { return };
    for (n, line) in text.lines().enumerate() {
        if matches.len() >= limit {
            return;
        }
        if matcher(line) {
            let mut line = line.trim().to_string();
            if line.chars().count() > MAX_LINE_CHARS {
                line = line.chars().take(MAX_LINE_CHARS).collect::<String>() + "…";
            }
            matches.push(json!({ "path": rel, "line": n + 1, "text": line }));
        }
    }
}

/* ------------------------------------------------------------------ */
/* commands                                                            */
/* ------------------------------------------------------------------ */

/// Pick a folder, confirm read-only access, remember `linkId → path`.
/// Answers `{ id, name }` or `{ id: null }` when cancelled.
#[tauri::command]
pub async fn repo_choose(app: AppHandle, canvas_id: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let Some(path) = rfd::FileDialog::new()
            .set_title("Link a project folder to this canvas")
            .pick_folder()
        else {
            return Ok(json!({ "id": null }));
        };
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| path.display().to_string());
        let title = format!("Link \"{}\" to this canvas?", name);
        let accepted = rfd::MessageDialog::new()
            .set_title(&title)
            .set_description(
                "Agents on this canvas will be able to read inside the folder while this \
                 app is open — read-only: nothing is written or run, and files that look \
                 like secrets (.env, keys, credentials) are skipped. The folder's path \
                 never leaves this computer.",
            )
            .set_buttons(rfd::MessageButtons::OkCancel)
            .show();
        if accepted != rfd::MessageDialogResult::Ok {
            return Ok(json!({ "id": null }));
        }
        let id = uuid::Uuid::new_v4().to_string();
        let mut grants = load_grants(&app)?;
        grants.insert(
            id.clone(),
            Grant {
                path: path.to_string_lossy().into_owned(),
                name: name.clone(),
                canvas_id,
                at: now_ms(),
            },
        );
        save_grants(&app, &grants)?;
        Ok(json!({ "id": id, "name": name }))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Drop a grant — the link id stops resolving on this device.
#[tauri::command]
pub async fn repo_forget(app: AppHandle, link_id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut grants = load_grants(&app)?;
        grants.remove(&link_id);
        save_grants(&app, &grants)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The grants this device holds, `[{ id, name }]` — the poll advertises the
/// ids so the server hands reads only to a device that can serve them.
#[tauri::command]
pub async fn repo_grants(app: AppHandle) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let grants = load_grants(&app)?;
        Ok(json!(grants
            .iter()
            .map(|(id, g)| json!({ "id": id, "name": g.name }))
            .collect::<Vec<_>>()))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// A bounded tree slice under `subdir` (default the root): entries sorted,
/// denied names and heavy dirs skipped, `truncated` when the cap stopped us.
#[tauri::command]
pub async fn repo_list(
    app: AppHandle,
    link_id: String,
    subdir: Option<String>,
    depth: Option<usize>,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = grant_root(&app, &link_id)?;
        let rel = subdir.unwrap_or_default();
        let start = resolve_under(&root, &rel).map_err(|e| e.to_string())?;
        if !start.is_dir() {
            return Err("'subdir' is not a directory".to_string());
        }
        // rel_string normalizes the slice the agent asked for ("./x" → "x")
        let rel = rel_string(&root, &start);
        let (entries, truncated) = walk(&root, &rel, depth.unwrap_or(DEFAULT_DEPTH).min(MAX_DEPTH));
        Ok(json!({ "entries": entries, "truncated": truncated }))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Bounded reads of up to MAX_READ_FILES repo-relative paths: each file
/// capped at MAX_FILE_BYTES, the whole call at MAX_READ_BYTES (`truncated`
/// says the budget ended before every path was attempted).
#[tauri::command]
pub async fn repo_read(app: AppHandle, link_id: String, paths: Vec<String>) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if paths.is_empty() {
            return Err("'paths' must list at least one file".to_string());
        }
        if paths.len() > MAX_READ_FILES {
            return Err(format!("'paths' takes at most {} files", MAX_READ_FILES));
        }
        let root = grant_root(&app, &link_id)?;
        let mut files = Vec::new();
        let mut total = 0usize;
        let mut truncated = false;
        for rel in paths {
            if total >= MAX_READ_BYTES {
                truncated = true;
                break;
            }
            let canonical = match resolve_under(&root, &rel) {
                Ok(p) => p,
                Err(why) => {
                    files.push(json!({ "path": rel, "error": why }));
                    continue;
                }
            };
            let meta = match fs::metadata(&canonical) {
                Ok(m) if m.is_file() => m,
                Ok(_) => {
                    files.push(json!({ "path": rel, "error": "unreadable" }));
                    continue;
                }
                Err(_) => {
                    files.push(json!({ "path": rel, "error": "missing" }));
                    continue;
                }
            };
            if meta.len() > MAX_FILE_BYTES {
                files.push(json!({ "path": rel, "error": "too-large" }));
                continue;
            }
            match fs::read(&canonical) {
                Ok(bytes) => match String::from_utf8(bytes) {
                    Ok(text) => {
                        total += text.len();
                        files.push(json!({ "path": rel, "text": text }));
                    }
                    Err(_) => files.push(json!({ "path": rel, "error": "binary" })),
                },
                Err(_) => files.push(json!({ "path": rel, "error": "unreadable" })),
            }
        }
        Ok(json!({ "files": files, "truncated": truncated }))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Literal (default) or Rust-regex substring search under the whole linked
/// tree — bounded: skipped dirs and denied names, files past MAX_FILE_BYTES
/// ignored, at most `limit` (≤ MAX_SEARCH_MATCHES) matches.
#[tauri::command]
pub async fn repo_search(
    app: AppHandle,
    link_id: String,
    query: String,
    regex: Option<bool>,
    glob: Option<String>,
    limit: Option<usize>,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if query.is_empty() || query.chars().count() > MAX_QUERY_CHARS {
            return Err(format!("'query' takes 1-{} characters", MAX_QUERY_CHARS));
        }
        let root = grant_root(&app, &link_id)?;
        let limit = limit.unwrap_or(50).clamp(1, MAX_SEARCH_MATCHES);
        let matcher: Box<dyn Fn(&str) -> bool> = if regex.unwrap_or(false) {
            let re = Regex::new(&query).map_err(|e| format!("bad pattern: {}", e))?;
            Box::new(move |line: &str| re.is_match(line))
        } else {
            let needle = query.clone();
            Box::new(move |line: &str| line.contains(needle.as_str()))
        };
        let glob = glob.filter(|g| !g.is_empty());
        let mut matches = Vec::new();
        let mut stack = vec![(root.clone(), String::new(), MAX_DEPTH)];
        let mut scanned = 0usize;
        while let Some((dir, rel, depth)) = stack.pop() {
            if matches.len() >= limit || scanned >= MAX_ENTRIES {
                break;
            }
            let mut children: Vec<PathBuf> = match fs::read_dir(&dir) {
                Ok(rd) => rd.filter_map(|e| e.ok().map(|e| e.path())).collect(),
                Err(_) => continue,
            };
            children.sort();
            for child in children {
                if matches.len() >= limit || scanned >= MAX_ENTRIES {
                    break;
                }
                let name = match child.file_name() {
                    Some(n) => n.to_string_lossy().into_owned(),
                    None => continue,
                };
                if denied_name(&name)
                    || SKIP_DIRS.iter().any(|s| name.eq_ignore_ascii_case(s))
                {
                    continue;
                }
                let Some(is_dir) = entry_kind(&root, &child) else {
                    continue;
                };
                let child_rel = if rel.is_empty() {
                    name.clone()
                } else {
                    format!("{}/{}", rel, name)
                };
                if is_dir {
                    if depth > 0 {
                        stack.push((child, child_rel, depth - 1));
                    }
                } else {
                    scanned += 1;
                    if glob_allows(glob.as_deref(), &name, &child_rel) {
                        search_file(&child_rel, &child, matcher.as_ref(), limit, &mut matches);
                    }
                }
            }
        }
        let truncated = matches.len() >= limit || scanned >= MAX_ENTRIES;
        Ok(json!({ "matches": matches, "truncated": truncated }))
    })
    .await
    .map_err(|e| e.to_string())?
}

/* ------------------------------------------------------------------ */
/* write_change — the one write surface                                */
/* ------------------------------------------------------------------ */

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteFile {
    path: String,
    #[serde(default)]
    text: Option<String>,
    #[serde(default)]
    base64: Option<String>,
}

/// A file validated and decoded, ready to create: its repo-relative path,
/// where it lands under the grant root, and its bytes.
struct Prepared {
    rel: String,
    target: PathBuf,
    bytes: Vec<u8>,
}

/// A Stip change id: workflow.py's `SLUG` — `^[a-z0-9]+(-[a-z0-9]+)*$`.
fn valid_change_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= MAX_CHANGE_ID
        && id.split('-').all(|part| {
            !part.is_empty() && part.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        })
}

/// `rel` must name a NEW file inside `.workflow/changes/<change_id>/` —
/// clean components only (no `..`, no dot segments, no separators beyond
/// `/`), no denied names anywhere on the path, and nothing already sitting
/// at the target. Writes never follow a symlink: every existing component
/// of the target must be a real directory, and the deepest existing
/// ancestor must canonicalize inside the grant root.
fn resolve_change_file(root: &Path, change_id: &str, rel: &str) -> Result<PathBuf, &'static str> {
    if rel.is_empty() || rel.chars().count() > MAX_PATH_CHARS {
        return Err("denied");
    }
    let mut clean = PathBuf::new();
    for c in Path::new(rel).components() {
        match c {
            Component::Normal(name) => clean.push(name),
            _ => return Err("denied"),
        }
    }
    /* exactly `.workflow/changes/<change_id>/<something>` — nothing else may be written */
    let prefix = Path::new(WRITE_ROOT).join(change_id);
    if !clean.starts_with(&prefix) || clean == prefix {
        return Err("denied");
    }
    if denied_rel(&clean) {
        return Err("denied");
    }
    let target = root.join(&clean);
    /* every existing component must be a real dir — a symlink anywhere on
       the path, even pointing back inside the repo, is refused */
    let mut probe = root.to_path_buf();
    let mut deepest = root.to_path_buf();
    for c in clean.components() {
        probe.push(c.as_os_str());
        match fs::symlink_metadata(&probe) {
            Ok(meta) => {
                if meta.file_type().is_symlink() {
                    return Err("denied");
                }
                if probe == target {
                    return Err("exists");
                }
                deepest = probe.clone();
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => break,
            Err(_) => return Err("denied"),
        }
    }
    let canonical = deepest.canonicalize().map_err(|_| "denied")?;
    if !canonical.starts_with(root) {
        return Err("denied");
    }
    Ok(target)
}

/// Validate the whole request and decode every file's bytes BEFORE the
/// person is asked: the confirmation only ever lists a writable set.
fn prepare_change(root: &Path, change_id: &str, files: &[WriteFile]) -> Result<Vec<Prepared>, String> {
    if !valid_change_id(change_id) {
        return Err("'changeId' must be a lowercase slug like 'billing-screen-a1b2'".to_string());
    }
    if files.is_empty() {
        return Err("no files to write".to_string());
    }
    if files.len() > MAX_WRITE_FILES {
        return Err(format!("a change takes at most {} files", MAX_WRITE_FILES));
    }
    let mut prepared = Vec::with_capacity(files.len());
    let mut seen = std::collections::HashSet::new();
    let mut total = 0usize;
    for f in files {
        let target = resolve_change_file(root, change_id, &f.path).map_err(|e| format!("{}: {}", f.path, e))?;
        if !seen.insert(f.path.clone()) {
            return Err(format!("{}: duplicate path", f.path));
        }
        let bytes = match (&f.text, &f.base64) {
            (Some(text), None) => text.clone().into_bytes(),
            (None, Some(data)) => {
                use base64::Engine;
                base64::engine::general_purpose::STANDARD
                    .decode(data)
                    .map_err(|_| format!("{}: invalid base64", f.path))?
            }
            _ => return Err(format!("{}: exactly one of text or base64 is required", f.path)),
        };
        if bytes.len() > MAX_WRITE_FILE_BYTES {
            return Err(format!("{}: over the {}-byte file cap", f.path, MAX_WRITE_FILE_BYTES));
        }
        total += bytes.len();
        if total > MAX_WRITE_BYTES {
            return Err(format!("the pack is over the {}-byte total cap", MAX_WRITE_BYTES));
        }
        prepared.push(Prepared {
            rel: f.path.clone(),
            target,
            bytes,
        });
    }
    Ok(prepared)
}

/// Create each prepared file — `create_new` so a race that lands a file
/// first still fails instead of overwriting. Stops at the first failure and
/// says what was written before it.
fn write_prepared(prepared: &[Prepared]) -> Result<Vec<String>, String> {
    let mut written = Vec::new();
    for f in prepared {
        if let Some(parent) = f.target.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("{}: {}", f.rel, e))?;
        }
        match std::fs::OpenOptions::new().write(true).create_new(true).open(&f.target) {
            Ok(mut file) => {
                use std::io::Write;
                file.write_all(&f.bytes).map_err(|e| format!("{}: {}", f.rel, e))?;
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                return Err(format!("{}: exists", f.rel));
            }
            Err(e) => return Err(format!("{}: {}", f.rel, e)),
        }
        written.push(f.rel.clone());
    }
    Ok(written)
}

/// Write one Stip change into the linked project — the ONLY write the app
/// offers. Every file is new, under `.workflow/changes/<change_id>/` only,
/// after a native confirmation listing them all. Answers `{ dir, written,
/// repo }`, `"cancelled"` when the person declines, or a sandbox error.
#[tauri::command]
pub async fn repo_write_change(
    app: AppHandle,
    link_id: String,
    change_id: String,
    files: Vec<WriteFile>,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let grant = grant_for(&app, &link_id)?;
        let root = PathBuf::from(&grant.path)
            .canonicalize()
            .map_err(|_| "The linked folder moved or was removed".to_string())?;
        if !root.is_dir() {
            return Err("The linked folder is not a directory".to_string());
        }
        let prepared = prepare_change(&root, &change_id, &files)?;
        let dir = format!("{}/{}", WRITE_ROOT, change_id);
        let mut listing = prepared
            .iter()
            .take(15)
            .map(|f| format!("  {}", f.rel))
            .collect::<Vec<_>>();
        if prepared.len() > listing.len() {
            listing.push(format!("  … and {} more", prepared.len() - listing.len()));
        }
        let accepted = rfd::MessageDialog::new()
            .set_title(&format!("Write a Stip change to \"{}\"?", grant.name))
            .set_description(&format!(
                "The doop handoff creates {} new file{} under {}/ — nothing existing is changed or overwritten:\n\n{}",
                prepared.len(),
                if prepared.len() == 1 { "" } else { "s" },
                dir,
                listing.join("\n"),
            ))
            .set_buttons(rfd::MessageButtons::OkCancel)
            .show();
        if accepted != rfd::MessageDialogResult::Ok {
            return Err("cancelled".to_string());
        }
        let written = write_prepared(&prepared)?;
        Ok(json!({ "dir": dir, "written": written, "repo": grant.name }))
    })
    .await
    .map_err(|e| e.to_string())?
}

/* ------------------------------------------------------------------ */
/* tests                                                               */
/* ------------------------------------------------------------------ */

#[cfg(test)]
mod tests {
    use super::*;

    /// A repo layout with a symlink that escapes and one that stays inside,
    /// a denied `.env`, a `node_modules` dir and one oversized file. Returns
    /// the repo dir and the "outside" dir the escape symlink points at —
    /// both must stay alive for the test's duration.
    fn fixture() -> (tempfile::TempDir, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let outside_dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::create_dir_all(root.join("src/components")).unwrap();
        fs::create_dir_all(root.join("node_modules/pkg")).unwrap();
        fs::write(root.join("src/App.tsx"), "export const x = 1\nTOKEN here\n").unwrap();
        fs::write(
            root.join("src/components/Button.tsx"),
            "export function Button() {}\nTOKEN there\n",
        )
        .unwrap();
        fs::write(root.join("node_modules/pkg/index.js"), "TOKEN noise\n").unwrap();
        fs::write(root.join(".env"), "SECRET=1\n").unwrap();
        fs::write(root.join("keys.pem"), "-----BEGIN-----\n").unwrap();
        fs::write(root.join("big.txt"), "x".repeat(MAX_FILE_BYTES as usize + 1)).unwrap();
        let outside = outside_dir.path().join("outside.txt");
        fs::write(&outside, "outside\n").unwrap();
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&outside, root.join("escape")).unwrap();
            std::os::unix::fs::symlink(root.join("src"), root.join("inside")).unwrap();
        }
        (dir, outside_dir)
    }

    #[test]
    fn deny_list_matches_names() {
        for name in [".env", ".env.local", "a.PEM", "id_rsa", "secrets.txt", "prod.tfvars"] {
            assert!(denied_name(name), "{name} should be denied");
        }
        for name in ["env.ts", "App.tsx", "keynote.md", "monkey.rs"] {
            assert!(!denied_name(name), "{name} should be allowed");
        }
    }

    #[test]
    fn resolve_rejects_escapes() {
        let (dir, _outside) = fixture();
        let root = dir.path().canonicalize().unwrap();
        for rel in ["../outside.txt", "a/../../x", "/abs", "..", "node_modules/pkg/index.js", ".env", "keys.pem"] {
            assert!(resolve_under(&root, rel).is_err(), "{rel} should fail");
        }
        assert!(resolve_under(&root, "src/App.tsx").is_ok());
        // "" and "." both mean the root; "./x" means "x"
        for rel in ["", ".", "./src/App.tsx"] {
            assert!(resolve_under(&root, rel).is_ok(), "{rel} should pass");
        }
    }

    #[cfg(unix)]
    #[test]
    fn resolve_rejects_symlink_escape() {
        let (dir, _outside) = fixture();
        let root = dir.path().canonicalize().unwrap();
        assert_eq!(resolve_under(&root, "escape").unwrap_err(), "denied");
        // a symlink that stays inside resolves fine
        assert!(resolve_under(&root, "inside/App.tsx").is_ok());
    }

    #[test]
    fn walk_skips_denied_and_heavy_dirs() {
        let (dir, _outside) = fixture();
        let root = dir.path().canonicalize().unwrap();
        let (entries, _) = walk(&root, "", MAX_DEPTH);
        let paths: Vec<String> = entries
            .iter()
            .map(|e| e["path"].as_str().unwrap().to_string())
            .collect();
        assert!(paths.contains(&"src".to_string()));
        assert!(paths.contains(&"src/App.tsx".to_string()));
        for bad in [".env", "keys.pem", "node_modules", "node_modules/pkg", "escape"] {
            assert!(!paths.iter().any(|p| p == bad), "{bad} must not be listed");
        }
    }

    #[test]
    fn walk_honours_depth_and_caps() {
        let (dir, _outside) = fixture();
        let root = dir.path().canonicalize().unwrap();
        let (shallow, _) = walk(&root, "", 0);
        assert!(shallow.iter().all(|e| !e["path"].as_str().unwrap().contains('/')));
        let (deep, _) = walk(&root, "", MAX_DEPTH);
        assert!(deep.iter().any(|e| e["path"].as_str().unwrap().contains('/')));
    }

    #[test]
    fn glob_matching() {
        assert!(glob_match("*.tsx", "App.tsx"));
        assert!(glob_match("*.tsx", "app.TSX"));
        assert!(glob_match("src/*", "src/App.tsx"));
        assert!(!glob_match("*.rs", "App.tsx"));
        assert!(glob_match("*", "anything"));
    }

    #[test]
    fn read_caps_and_errors() {
        let (dir, _outside) = fixture();
        let root = dir.path().canonicalize().unwrap();
        // too-large file refuses itself, not the call
        let big = resolve_under(&root, "big.txt").unwrap();
        assert!(fs::metadata(&big).unwrap().len() > MAX_FILE_BYTES);
        // binary content answers "binary"
        fs::write(root.join("bin.dat"), [0u8, 159, 255]).unwrap();
        assert!(String::from_utf8(fs::read(root.join("bin.dat")).unwrap()).is_err());
    }

    #[test]
    fn search_respects_skip_dirs() {
        let (dir, _outside) = fixture();
        let root = dir.path().canonicalize().unwrap();
        // the walk the command does, driven by the same helpers
        let mut hits = Vec::new();
        let mut stack = vec![(root.clone(), String::new(), MAX_DEPTH)];
        while let Some((dir, rel, depth)) = stack.pop() {
            for entry in fs::read_dir(&dir).unwrap().filter_map(|e| e.ok()) {
                let name = entry.file_name().to_string_lossy().into_owned();
                if denied_name(&name) || SKIP_DIRS.iter().any(|s| name.eq_ignore_ascii_case(s)) {
                    continue;
                }
                let child_rel = if rel.is_empty() { name.clone() } else { format!("{}/{}", rel, name) };
                let Some(is_dir) = entry_kind(&root, &entry.path()) else { continue };
                if is_dir {
                    if depth > 0 {
                        stack.push((entry.path(), child_rel, depth - 1));
                    }
                } else {
                    search_file(&child_rel, &entry.path(), &|l| l.contains("TOKEN"), 100, &mut hits);
                }
            }
        }
        let paths: Vec<String> = hits.iter().map(|m| m["path"].as_str().unwrap().to_string()).collect();
        assert!(paths.iter().any(|p| p == "src/App.tsx"));
        assert!(!paths.iter().any(|p| p.contains("node_modules")));
    }

    /* ---- repo_write_change's sandbox (the dialog and grant lookup stay
       untested: prepare_change/resolve_change_file/write_prepared are the
       parts that can hurt a repo) ---- */

    fn text_file(path: &str) -> WriteFile {
        WriteFile {
            path: path.to_string(),
            text: Some("body\n".to_string()),
            base64: None,
        }
    }

    #[test]
    fn change_ids_are_slugs() {
        for id in ["billing-screen-a1b2", "x", "a-b-c"] {
            assert!(valid_change_id(id), "{id} should pass");
        }
        for id in ["", "A-b", "a_b", "a--b", "-ab", "ab-", "a.b", "a/b"] {
            assert!(!valid_change_id(id), "{id} should fail");
        }
    }

    #[test]
    fn write_stays_inside_the_change_folder() {
        let (dir, _outside) = fixture();
        let root = dir.path().canonicalize().unwrap();
        let id = "new-change-1";
        for rel in [
            "proposal.md",
            ".workflow/changes/new-change-1",
            ".workflow/changes/other-9/spec.md",
            ".workflow/specs/x.md",
            "src/App.tsx",
            ".workflow/changes/new-change-1/../evil.md",
            ".workflow/changes/new-change-1/../../x.md",
            "/.workflow/changes/new-change-1/x.md",
            ".workflow/changes/new-change-1/.env",
            ".workflow/changes/new-change-1/secret-notes.md",
        ] {
            assert!(
                resolve_change_file(&root, id, rel).is_err(),
                "{rel} should fail"
            );
        }
        for rel in [
            ".workflow/changes/new-change-1/proposal.md",
            ".workflow/changes/new-change-1/spec.md",
            ".workflow/changes/new-change-1/assets/screen-1.png",
        ] {
            assert!(
                resolve_change_file(&root, id, rel).is_ok(),
                "{rel} should pass"
            );
        }
    }

    #[test]
    fn write_never_overwrites() {
        let (dir, _outside) = fixture();
        let root = dir.path().canonicalize().unwrap();
        let id = "new-change-2";
        let rel = ".workflow/changes/new-change-2/proposal.md";
        let first = prepare_change(&root, id, &[text_file(rel)]).unwrap();
        write_prepared(&first).unwrap();
        /* the same file again is refused before any dialog would show */
        assert!(resolve_change_file(&root, id, rel).is_err());
        assert!(prepare_change(&root, id, &[text_file(rel)]).is_err());
        /* an existing directory can't be landed on either */
        assert!(resolve_change_file(&root, id, ".workflow/changes/new-change-2").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn write_refuses_symlinked_dirs() {
        let (dir, outside) = fixture();
        let root = dir.path().canonicalize().unwrap();
        /* `.workflow/changes` itself is a symlink out — every write under it
           must be refused even though the files would look inside-folder */
        let link = root.join(".workflow");
        std::os::unix::fs::symlink(outside.path(), &link).unwrap();
        let rel = ".workflow/changes/new-change-3/proposal.md";
        assert!(resolve_change_file(&root, "new-change-3", rel).is_err());
    }

    #[test]
    fn write_decodes_and_caps_content() {
        let (dir, _outside) = fixture();
        let root = dir.path().canonicalize().unwrap();
        let id = "new-change-4";
        let png = WriteFile {
            path: ".workflow/changes/new-change-4/assets/a.png".to_string(),
            text: None,
            base64: Some(base64::engine::Engine::encode(
                &base64::engine::general_purpose::STANDARD,
                [137u8, 80, 78, 71],
            )),
        };
        let prepared = prepare_change(&root, id, &[text_file(".workflow/changes/new-change-4/spec.md"), png]).unwrap();
        assert_eq!(prepared[1].bytes, vec![137u8, 80, 78, 71]);
        /* both content kinds set — refused */
        let both = WriteFile {
            path: ".workflow/changes/new-change-4/x.md".to_string(),
            text: Some("a".into()),
            base64: Some("YQ==".into()),
        };
        assert!(prepare_change(&root, id, &[both]).is_err());
        let bad_b64 = WriteFile {
            path: ".workflow/changes/new-change-4/y.png".to_string(),
            text: None,
            base64: Some("!!!".into()),
        };
        assert!(prepare_change(&root, id, &[bad_b64]).is_err());
    }

    #[test]
    fn write_prepared_creates_nested_files() {
        let (dir, _outside) = fixture();
        let root = dir.path().canonicalize().unwrap();
        let id = "new-change-5";
        let prepared = prepare_change(
            &root,
            id,
            &[
                text_file(".workflow/changes/new-change-5/proposal.md"),
                text_file(".workflow/changes/new-change-5/assets/deep/one.png"),
            ],
        )
        .unwrap();
        let written = write_prepared(&prepared).unwrap();
        assert_eq!(written.len(), 2);
        assert_eq!(
            fs::read_to_string(root.join(".workflow/changes/new-change-5/proposal.md")).unwrap(),
            "body\n"
        );
        assert!(root.join(".workflow/changes/new-change-5/assets/deep/one.png").is_file());
    }
}
