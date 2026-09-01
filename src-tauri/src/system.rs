// Host hardware facts, used by the models library to estimate whether a given
// model will actually run on this machine.

use serde::Serialize;
use sysinfo::{Disks, System};

#[derive(Debug, Serialize, Clone)]
pub struct SystemInfo {
    /// Bytes of physical RAM.
    pub total_memory: u64,
    /// Bytes currently free — the practical ceiling right now, since other apps
    /// are already holding memory.
    pub available_memory: u64,
    pub cpu_cores: usize,
    pub cpu_brand: String,
    pub arch: String,
    /// "macos" | "windows" | "linux" — used to label the hardware-fit sort.
    pub os: String,
    /// Apple Silicon shares one pool between CPU and GPU, so the whole figure is
    /// available to inference. On a discrete-GPU machine, VRAM is the real limit
    /// and system RAM overstates what the GPU can hold.
    pub unified_memory: bool,
    /// Free bytes on the volume models are written to — a download that doesn't
    /// fit fails partway, so it's worth checking before starting one.
    pub free_disk: u64,
    /// Bytes the GPU will actually hold, which is *not* the same as free RAM and
    /// is usually the real ceiling on context length.
    ///
    /// Metal caps a process's working set well below total memory, so a model can
    /// sit inside a generous RAM budget and still be refused by the GPU —
    /// llama.cpp then runs the overflow on the CPU. Measured on an M1 Pro/16GB:
    /// a 8.86 GiB load stayed 100% GPU, while 9.89 GiB placed only 9.51 GiB and
    /// dropped generation from 21 to 4 tok/s.
    ///
    /// `None` when it can't be known — a discrete GPU has its own VRAM that
    /// `sysinfo` can't see, and guessing there would be worse than not saying.
    pub gpu_working_set: Option<u64>,
}

/// First name for the home-screen greeting, or `None` when the OS won't say.
///
/// macOS keeps the account's *full* name ("Ada Lovelace") separate from the short
/// login name ("ada"), and `id -F` is the only way to read it without
/// linking AppKit. It's a BSD flag — GNU `id` rejects it — so Linux and Windows
/// fall through to the login name, which is the best they offer.
pub fn get_user_name() -> Option<String> {
    #[cfg(unix)]
    let full_name = std::process::Command::new("id")
        .arg("-F")
        .output()
        .ok()
        .filter(|out| out.status.success())
        .map(|out| String::from_utf8_lossy(&out.stdout).trim().to_string());

    #[cfg(not(unix))]
    let full_name: Option<String> = None;

    full_name
        .filter(|name| !name.is_empty())
        .or_else(|| std::env::var("USER").or_else(|_| std::env::var("USERNAME")).ok())
        // "Ada Lovelace" → "Ada". A login name has no space and passes through.
        .and_then(|name| name.split_whitespace().next().map(str::to_string))
        .filter(|name| !name.is_empty())
        .map(|name| {
            // Only reached with a login handle, since full names are already
            // capitalised — and lowercase reads as a bug in a 40px hero line.
            let mut chars = name.chars();
            match chars.next() {
                Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
                None => name,
            }
        })
}

/// Just the free-memory figure, cheap enough to poll.
///
/// `get_system_info` builds a `System::new_all()` and rescans every disk, which is
/// fine once at startup and far too much every ten seconds. This refreshes memory
/// alone — the only field that meaningfully changes while the app is open, and the
/// one Auto's context sizing depends on.
pub fn get_available_memory() -> u64 {
    let mut sys = System::new();
    sys.refresh_memory();
    sys.available_memory()
}

pub fn get_system_info() -> SystemInfo {
    let mut sys = System::new_all();
    sys.refresh_memory();

    let cpu_brand = sys
        .cpus()
        .first()
        .map(|c| c.brand().trim().to_string())
        .unwrap_or_default();

    // Models land under the user's home, so report the volume with the longest
    // mount point that contains it — that's the one actually backing the path.
    let home = std::env::var("HOME").unwrap_or_else(|_| "/".to_string());
    let disks = Disks::new_with_refreshed_list();
    let free_disk = disks
        .list()
        .iter()
        .filter(|d| home.starts_with(&*d.mount_point().to_string_lossy()))
        .max_by_key(|d| d.mount_point().to_string_lossy().len())
        .map(|d| d.available_space())
        .unwrap_or(0);

    let unified_memory = cfg!(target_os = "macos") && std::env::consts::ARCH == "aarch64";

    SystemInfo {
        total_memory: sys.total_memory(),
        available_memory: sys.available_memory(),
        cpu_cores: sys.cpus().len(),
        cpu_brand,
        arch: std::env::consts::ARCH.to_string(),
        os: std::env::consts::OS.to_string(),
        unified_memory,
        free_disk,
        // Apple Silicon shares one pool, and Metal's recommended working set runs
        // about two thirds of it. This is an approximation of a figure only
        // `MTLDevice.recommendedMaxWorkingSetSize` knows exactly — reading that
        // needs an Objective-C binding, so until then the offload detector in
        // Settings is what catches the cases this gets wrong.
        gpu_working_set: unified_memory.then(|| sys.total_memory() * 2 / 3),
    }
}
