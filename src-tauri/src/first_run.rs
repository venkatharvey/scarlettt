// Whether this is the first launch of a *new installation* over data from an old
// one, and what to offer if so.
//
// macOS does not remove `~/Library/Application Support/<identifier>/` when an app is
// dragged to the Trash, so someone who used Scarlettt, uninstalled it, and installed
// it again still has their chats on disk. They should be asked. Someone who has never
// run it should not be — there is nothing to ask about.
//
// "Data exists" alone cannot tell those apart, because the data survives the
// uninstall either way. What distinguishes them is the *executable*: installing means
// copying the bundle, and a copy gets a new creation time. Measured — the same binary
// copied to a new location went from 17:01:14 to 19:08:37. So a marker recording the
// running executable's ctime answers the question:
//
//   no data dir            -> first-ever run, nothing to ask
//   marker matches the exe -> an ordinary launch
//   marker missing/differs -> a new installation over existing data: ask, once
//
// Both ways of being wrong are harmless, which is why this signal is good enough: a
// false positive asks a question, and a false negative leaves the data alone.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

const MARKER: &str = ".install-marker";

/// Every archive is `<app dir name>.previous-<unix seconds>`, a SIBLING of the app
/// data dir. Built from one place so the code that writes archives and the code that
/// finds them again cannot disagree about the shape.
const ARCHIVE_INFIX: &str = ".previous-";

fn archive_prefix(app_dir: &Path) -> String {
    format!(
        "{}{}",
        app_dir.file_name().and_then(|n| n.to_str()).unwrap_or("scarlettt"),
        ARCHIVE_INFIX
    )
}

#[derive(Serialize, Deserialize)]
struct Marker {
    /// Seconds since the epoch. Changes when the app is copied, which is what an
    /// install is.
    exe_ctime: u64,
    app_version: String,
}

/// What the previous installation left behind, in the terms the user will be asked
/// about — conversations, not files.
#[derive(Debug, Serialize)]
pub struct PreviousData {
    pub sessions: u32,
    pub messages: u32,
    pub bytes: u64,
    /// Whether the engine is already downloaded, i.e. whether starting fresh means
    /// fetching ~150MB again.
    pub engine_present: bool,
}

/// Models sitting in Ollama's own store that this app could adopt without
/// downloading them again. Reported separately from `PreviousData` because they are
/// *not ours* — they may belong to an Ollama the user installed themselves.
#[derive(Debug, Serialize)]
pub struct ImportableModels {
    pub count: u32,
    pub names: Vec<String>,
    pub bytes: u64,
}

#[derive(Debug, Serialize)]
pub struct FirstRunState {
    /// False on an ordinary launch and on a genuinely first run. Only true when
    /// there is a real choice to put to the user.
    pub ask: bool,
    pub previous: Option<PreviousData>,
    pub importable: Option<ImportableModels>,
}

#[cfg(unix)]
fn ctime_secs(path: &Path) -> Option<u64> {
    use std::os::unix::fs::MetadataExt;
    std::fs::metadata(path).ok().map(|m| m.ctime() as u64)
}

/// Windows has no ctime; `creation_time` is 100ns ticks since 1601. The absolute epoch
/// is irrelevant here — this value is only ever compared against itself (the install
/// marker), so scaling to whole seconds is enough.
#[cfg(windows)]
fn ctime_secs(path: &Path) -> Option<u64> {
    use std::os::windows::fs::MetadataExt;
    std::fs::metadata(path).ok().map(|m| m.creation_time() / 10_000_000)
}

fn file_bytes(path: &Path) -> u64 {
    std::fs::metadata(path).map(|m| m.len()).unwrap_or(0)
}

fn dir_bytes(path: &Path) -> u64 {
    let Ok(entries) = std::fs::read_dir(path) else { return 0 };
    entries
        .flatten()
        .map(|e| match e.file_type() {
            Ok(t) if t.is_dir() => dir_bytes(&e.path()),
            Ok(_) => e.metadata().map(|m| m.len()).unwrap_or(0),
            Err(_) => 0,
        })
        .sum()
}

/// Reads Ollama's model store without starting a server: manifests are one file per
/// tag under `manifests/registry.ollama.ai/<namespace>/<model>/<tag>`.
fn scan_models(models_dir: &Path) -> Option<ImportableModels> {
    let manifests = models_dir.join("manifests");
    if !manifests.exists() {
        return None;
    }
    let mut names = Vec::new();
    // registry / namespace / model / tag
    for registry in std::fs::read_dir(&manifests).ok()?.flatten() {
        for ns in std::fs::read_dir(registry.path()).ok().into_iter().flatten().flatten() {
            for model in std::fs::read_dir(ns.path()).ok().into_iter().flatten().flatten() {
                let model_name = model.file_name().to_string_lossy().to_string();
                for tag in std::fs::read_dir(model.path()).ok().into_iter().flatten().flatten() {
                    names.push(format!("{}:{}", model_name, tag.file_name().to_string_lossy()));
                }
            }
        }
    }
    if names.is_empty() {
        return None;
    }
    names.sort();
    Some(ImportableModels {
        count: names.len() as u32,
        names,
        bytes: dir_bytes(&models_dir.join("blobs")),
    })
}

fn count_chats(db: &Path) -> (u32, u32) {
    if !db.exists() {
        return (0, 0);
    }
    match rusqlite::Connection::open(db) {
        Ok(conn) => {
            let sessions = conn
                .query_row("SELECT COUNT(*) FROM chat_sessions", [], |r| r.get::<_, i64>(0))
                .unwrap_or(0) as u32;
            let messages = conn
                .query_row("SELECT COUNT(*) FROM messages", [], |r| r.get::<_, i64>(0))
                .unwrap_or(0) as u32;
            (sessions, messages)
        }
        Err(_) => (0, 0),
    }
}

/// `shared_models_dir` is Ollama's default store (`~/.ollama/models`), which may
/// belong to an Ollama the user installed themselves.
pub fn evaluate(
    app_dir: &Path,
    shared_models_dir: &Path,
    app_version: &str,
    ask_enabled: bool,
) -> FirstRunState {
    let importable = scan_models(shared_models_dir);
    let none = FirstRunState { ask: false, previous: None, importable: None };

    // Disabled in development: `cargo build` rewrites the executable, so its ctime
    // changes on every rebuild and the prompt would fire constantly.
    if !ask_enabled {
        return none;
    }

    let (sessions, messages) = count_chats(&app_dir.join("scarlettt.db"));
    if sessions == 0 && importable.is_none() {
        // Nothing to restore and nothing to adopt: a genuinely new user.
        return none;
    }

    let exe_ctime = std::env::current_exe().ok().as_deref().and_then(ctime_secs);
    let marker: Option<Marker> = std::fs::read_to_string(app_dir.join(MARKER))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok());

    let same_install = match (&marker, exe_ctime) {
        (Some(m), Some(now)) => m.exe_ctime == now && m.app_version == app_version,
        _ => false,
    };
    if same_install {
        return none;
    }

    FirstRunState {
        ask: true,
        previous: (sessions > 0).then(|| PreviousData {
            sessions,
            messages,
            // The conversations' own size, not the directory's. `dir_bytes` here
            // reported the engine and the model store too — 642MB next to a count of
            // chats that occupied 28KB of it.
            bytes: file_bytes(&app_dir.join(DATABASE_FILE)),
            engine_present: app_dir.join(crate::ollama::MANAGED_BINARY_NAME).exists(),
        }),
        importable,
    }
}

/// Records that the question has been answered, so it is asked once per install.
pub fn acknowledge(app_dir: &Path, app_version: &str) -> Result<(), String> {
    let marker = Marker {
        exe_ctime: std::env::current_exe().ok().as_deref().and_then(ctime_secs).unwrap_or(0),
        app_version: app_version.to_string(),
    };
    std::fs::create_dir_all(app_dir).map_err(|e| e.to_string())?;
    std::fs::write(
        app_dir.join(MARKER),
        serde_json::to_string(&marker).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())
}

/// The name of the chat database, which is the only thing "start fresh" is about.
pub const DATABASE_FILE: &str = "scarlettt.db";

/// What a fresh start moves or deletes: the user's own data, and nothing else.
///
/// **An allowlist, and it has to be.** This was "every entry except `models/`", which
/// swept the *engine* along with the conversations — measured on one archive: 200MB of
/// `mlx_metal_v4`, 184MB of `mlx_metal_v3`, an 80MB `scarlettt-engine` and a 13MB
/// `llama-server`, 35 files and 516MB in total, sitting beside a 28KB database. Three
/// things wrong with that: the size reported next to "4 conversations" was the engine's,
/// a fresh start silently threw away a 147MB download the Welcome-back screen had just
/// advertised as already done, and restoring never brought it back (a restore merges
/// chats), so the disk was gone until the archive was deleted.
///
/// `models/` was already spared so adopted hardlinked blobs survive, and `~/.ollama` is
/// never in scope at all — it is Ollama's own store and may belong to another install.
/// Anything added here later must be *data*: a new file that belongs to the runtime
/// does not go in this list, and a new file that belongs to the user does.
fn our_entries(app_dir: &Path) -> Vec<PathBuf> {
    [DATABASE_FILE]
        .iter()
        .map(|name| app_dir.join(name))
        .filter(|path| path.exists())
        .collect()
}

/// Renames the previous data aside so it can be recovered later.
pub fn archive(app_dir: &Path) -> Result<PathBuf, String> {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let dest = app_dir.with_file_name(format!("{}{}", archive_prefix(app_dir), stamp));
    std::fs::create_dir_all(&dest).map_err(|e| e.to_string())?;
    for path in our_entries(app_dir) {
        if let Some(name) = path.file_name() {
            let _ = std::fs::rename(&path, dest.join(name));
        }
    }
    log::info!("Archived previous data to {:?}", dest);
    Ok(dest)
}

/// Deletes the previous data. Only ever the app's own directory.
pub fn discard(app_dir: &Path) -> Result<(), String> {
    for path in our_entries(app_dir) {
        let result = if path.is_dir() {
            std::fs::remove_dir_all(&path)
        } else {
            std::fs::remove_file(&path)
        };
        if let Err(e) = result {
            log::warn!("Could not remove {:?}: {}", path, e);
        }
    }
    log::info!("Discarded previous data in {:?}", app_dir);
    Ok(())
}

/// Adopts models from Ollama's store into ours by **hardlinking** the blobs.
///
/// Ollama addresses blobs by digest, so they are immutable and safe to share: one
/// copy on disk, referenced from both stores. Verified end to end before this was
/// written — a store built this way served, ran inference, and deleting the model
/// from it left the original untouched, because `ollama rm` unlinks rather than
/// truncating. That is what makes this safe: link counts, not trust.
///
/// Manifests are copied rather than linked. They are ~150KB in total and they are
/// what makes the two stores independent — sharing them would put the two apps back
/// in each other's way.
///
/// Falls back to a copy per blob when linking fails, which it will across
/// filesystems (someone whose `~/.ollama` lives on an external drive).
pub fn import_models(from: &Path, to: &Path) -> Result<(u32, u64, bool), String> {
    let (src_blobs, src_manifests) = (from.join("blobs"), from.join("manifests"));
    if !src_blobs.exists() {
        return Err("No model store to import from".into());
    }
    let (dst_blobs, dst_manifests) = (to.join("blobs"), to.join("manifests"));
    std::fs::create_dir_all(&dst_blobs).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dst_manifests).map_err(|e| e.to_string())?;

    let mut linked = 0u32;
    let mut bytes = 0u64;
    let mut copied_any = false;

    for entry in std::fs::read_dir(&src_blobs).map_err(|e| e.to_string())?.flatten() {
        let name = entry.file_name();
        let dest = dst_blobs.join(&name);
        if dest.exists() {
            continue;
        }
        let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
        match std::fs::hard_link(entry.path(), &dest) {
            Ok(()) => {
                linked += 1;
                bytes += size;
            }
            Err(_) => {
                // Different filesystem, or a filesystem without links. Costs disk,
                // but still beats re-downloading.
                if std::fs::copy(entry.path(), &dest).is_ok() {
                    linked += 1;
                    bytes += size;
                    copied_any = true;
                }
            }
        }
    }

    // Copy only the manifests whose blobs all made it across. Copying every manifest
    // (the old behaviour) advertised models whose weights had failed to link or copy —
    // a store that lists a model it then can't run, which `acknowledge_first_run` would
    // then mark settled. Incomplete ones are skipped and logged.
    let (imported, skipped) = copy_complete_manifests(&src_manifests, &dst_manifests, &dst_blobs)?;
    if skipped > 0 {
        log::warn!("Import skipped {} model manifest(s) whose blobs did not all come across", skipped);
    }
    log::info!("Adopted {} blobs ({} bytes) as {} model(s), copies used: {}", linked, bytes, imported, copied_any);
    Ok((linked, bytes, copied_any))
}

/// Copy the manifest tree, but only the tag manifests whose every referenced blob is
/// present in `blobs` — so a model whose weights failed to import is never advertised.
/// Returns (imported, skipped) tag counts; a leaf file under `manifests/` is one tag.
fn copy_complete_manifests(from: &Path, to: &Path, blobs: &Path) -> Result<(u32, u32), String> {
    std::fs::create_dir_all(to).map_err(|e| e.to_string())?;
    let (mut imported, mut skipped) = (0u32, 0u32);
    for entry in std::fs::read_dir(from).map_err(|e| e.to_string())?.flatten() {
        let dest = to.join(entry.file_name());
        match entry.file_type() {
            Ok(t) if t.is_dir() => {
                let (i, s) = copy_complete_manifests(&entry.path(), &dest, blobs)?;
                imported += i;
                skipped += s;
            }
            Ok(_) => {
                if manifest_complete(&entry.path(), blobs) {
                    if std::fs::copy(entry.path(), &dest).is_ok() {
                        imported += 1;
                    }
                } else {
                    skipped += 1;
                }
            }
            Err(_) => {}
        }
    }
    Ok((imported, skipped))
}

/// Whether every blob a tag manifest references (its config + layers) exists in
/// `blobs`. Ollama records a digest as `sha256:HASH` and stores the blob as the file
/// `sha256-HASH`, so the check maps one to the other. A manifest that can't be read or
/// parsed, or that names no blobs, is treated as incomplete rather than complete.
fn manifest_complete(manifest_path: &Path, blobs: &Path) -> bool {
    let Ok(text) = std::fs::read_to_string(manifest_path) else { return false; };
    let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) else { return false; };
    let mut digests: Vec<String> = Vec::new();
    if let Some(d) = json.get("config").and_then(|c| c.get("digest")).and_then(|d| d.as_str()) {
        digests.push(d.to_string());
    }
    if let Some(layers) = json.get("layers").and_then(|l| l.as_array()) {
        for layer in layers {
            if let Some(d) = layer.get("digest").and_then(|d| d.as_str()) {
                digests.push(d.to_string());
            }
        }
    }
    !digests.is_empty() && digests.iter().all(|d| blobs.join(d.replacen(':', "-", 1)).exists())
}


/// One set of data that "start fresh" set aside, as Settings needs to describe it.
#[derive(Debug, Serialize)]
pub struct ArchivedData {
    /// The bare directory name. This is the handle restore and delete are addressed
    /// by, because nothing records the path when the archive is written.
    pub id: String,
    /// Unix seconds, parsed out of the directory name — the only timestamp there is.
    pub archived_at: u64,
    pub sessions: u32,
    pub messages: u32,
    pub bytes: u64,
}

/// Every archive beside this app's data dir, newest first.
pub fn list_archives(app_dir: &Path) -> Vec<ArchivedData> {
    let Some(parent) = app_dir.parent() else { return Vec::new() };
    let Ok(entries) = std::fs::read_dir(parent) else { return Vec::new() };
    let prefix = archive_prefix(app_dir);

    let mut found: Vec<ArchivedData> = entries
        .flatten()
        .filter(|entry| entry.file_type().map(|t| t.is_dir()).unwrap_or(false))
        .filter_map(|entry| {
            let id = entry.file_name().to_string_lossy().to_string();
            // The stamp must parse, or this is some other directory that happens to
            // start the same way — a `.previous-notes` folder someone made by hand.
            let archived_at = id.strip_prefix(&prefix)?.parse::<u64>().ok()?;
            let (sessions, messages) = count_chats(&entry.path().join("scarlettt.db"));
            Some(ArchivedData {
                id,
                archived_at,
                sessions,
                messages,
                // The database's size, for the same reason. An archive written before
                // the allowlist above still holds a whole engine, and reporting that
                // as the weight of four conversations is how this was found.
                bytes: file_bytes(&entry.path().join(DATABASE_FILE)),
            })
        })
        .collect();

    found.sort_by(|a, b| b.archived_at.cmp(&a.archived_at));
    found
}

/// The path of one archive, from the id `list_archives` reported.
///
/// There is deliberately **no id-validating variant of this taking a string from the
/// frontend**. An earlier version had one, guarding a `remove_dir_all` against a
/// traversal out of Application Support, because the UI addressed archives by id.
/// It no longer does — restore and delete act on all of them — so no untrusted name
/// reaches a filesystem call at all, which is a better answer than validating one.
/// If a per-archive action ever comes back, the guard has to come back with it.
fn archive_path(app_dir: &Path, id: &str) -> PathBuf {
    app_dir.with_file_name(id)
}

/// Deletes every archive. Unlike `discard`, this touches only the set-aside copies.
///
/// Counts failures rather than swallowing them: a partial delete that reports success
/// leaves the user looking at a Settings row that will not go away.
pub fn delete_archives(app_dir: &Path) -> Result<u32, String> {
    let mut deleted = 0u32;
    let mut failures = Vec::new();
    for archive in list_archives(app_dir) {
        let path = archive_path(app_dir, &archive.id);
        match std::fs::remove_dir_all(&path) {
            Ok(()) => deleted += 1,
            Err(e) => failures.push(format!("{}: {}", archive.id, e)),
        }
    }
    if !failures.is_empty() {
        return Err(format!("Could not delete {}", failures.join("; ")));
    }
    log::info!("Deleted {} archived set(s) of conversations", deleted);
    Ok(deleted)
}

/// Every archive's database, oldest first, for merging back in one pass.
///
/// Oldest first so that when two archives hold a row with the same id, the newer one
/// is the one that loses — `INSERT OR IGNORE` keeps whatever landed first, and the
/// older copy is the one the newer archive was created *from*.
pub fn archived_databases(app_dir: &Path) -> Vec<PathBuf> {
    let mut archives = list_archives(app_dir);
    archives.reverse();
    archives
        .into_iter()
        .map(|archive| archive_path(app_dir, &archive.id).join(DATABASE_FILE))
        .filter(|db| db.exists())
        .collect()
}
