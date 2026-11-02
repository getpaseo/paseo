//! Shared state and helpers for the file system module.
//!
//! The trait's methods are split across sibling files by concern — `files`,
//! `dirs`, `handles`, `paths`, `dialogs`, `watching` — because they are large and
//! largely independent. Rust allows the trait to be implemented in several files
//! of one crate, so each file owns its own `impl` block.
//!
//! Everything they share is here: the open file table, the flag translation, and
//! the conversions the bridge's `f64` arguments need.

use std::fs::File;
use std::sync::atomic::AtomicU32;
use std::sync::Mutex;

use rn_gpui_module::{ModuleError, ModuleThread};

use crate::NativeFsEvents;

use crate::errors;

/// Flags, as `node:fs` numbers them: Node's table, not the platform's, so these
/// are translated rather than passed through to `OpenOptions`.
pub mod flags {
    pub const RDONLY: i32 = 0;
    pub const WRONLY: i32 = 1;
    pub const RDWR: i32 = 2;
    pub const CREAT: i32 = 64;
    pub const EXCL: i32 = 128;
    pub const TRUNC: i32 = 512;
    pub const APPEND: i32 = 1024;
}

/// Access modes for `access`, matching `node:fs.constants`.
pub mod access {
    pub const F_OK: i32 = 0;
    pub const X_OK: i32 = 1;
    pub const W_OK: i32 = 2;
    pub const R_OK: i32 = 4;
}

/// The kind numbers the JS layer turns into `Stats` predicates.
pub mod kind {
    pub const FILE: f64 = 0.0;
    pub const DIRECTORY: f64 = 1.0;
    pub const SYMLINK: f64 = 2.0;
    pub const OTHER: f64 = 3.0;
}

pub struct RNFsModule {
    pub events: NativeFsEvents,
    /// Open files, keyed by the number JS holds. The table belongs to the
    /// instance, so a reload closes every descriptor when it drops.
    ///
    /// Each entry records whether the descriptor was opened writable. The OS
    /// reports a write to a read-only handle as `EBADF` on Unix and `EACCES` on
    /// Windows, and Node reports `EBADF` on both, so the answer is taken from what
    /// the handle was opened with rather than from the errno.
    pub files: Mutex<std::collections::HashMap<u32, (File, bool)>>,
    /// Never reused, so a stale `fd` from JS fails instead of closing an
    /// unrelated file.
    pub next_fd: AtomicU32,
    /// Live watchers, keyed the same way.
    pub watchers: Mutex<std::collections::HashMap<u32, crate::watching::Watcher>>,
    pub next_watcher: AtomicU32,
}

impl RNFsModule {
    pub fn create(events: NativeFsEvents) -> Self {
        Self {
            events,
            files: Mutex::new(std::collections::HashMap::new()),
            next_fd: AtomicU32::new(1),
            watchers: Mutex::new(std::collections::HashMap::new()),
            next_watcher: AtomicU32::new(1),
        }
    }

    pub fn take_fd(&self) -> u32 {
        self.next_fd
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    }

    pub fn take_watcher_id(&self) -> u32 {
        self.next_watcher
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    }

    /// A clone of an open file, sharing its offset — which is what a descriptor
    /// is. Holding the lock only for the lookup keeps a slow write from blocking
    /// every other call on this thread.
    pub fn file(&self, fd: f64) -> Result<File, ModuleError> {
        self.file_and_writability(fd).map(|(file, _)| file)
    }

    /// The handle and whether it can be written to.
    pub fn file_and_writability(&self, fd: f64) -> Result<(File, bool), ModuleError> {
        let id = descriptor(fd)?;
        let files = self.files.lock().unwrap_or_else(|e| e.into_inner());
        let (file, writable) = files.get(&id).ok_or_else(|| bad_fd(id))?;
        let cloned = file
            .try_clone()
            .map_err(|error| errors::from_io(error, &id.to_string()))?;
        Ok((cloned, *writable))
    }
}

/// The error Node raises for a descriptor it does not know.
pub fn bad_fd(id: u32) -> ModuleError {
    errors::invalid("EBADF", format!("EBADF: bad file descriptor, {id}"))
}

/// A descriptor from the bridge. Anything but a non-negative integer is a
/// programmer error, so it reports as a bad descriptor rather than a file error.
pub fn descriptor(value: f64) -> Result<u32, ModuleError> {
    if value.is_finite() && value >= 0.0 && value.fract() == 0.0 && value <= u32::MAX as f64 {
        Ok(value as u32)
    } else {
        Err(bad_fd(0))
    }
}

/// A byte length from the bridge.
pub fn length(value: f64) -> Result<usize, ModuleError> {
    if value.is_finite() && value >= 0.0 && value.fract() == 0.0 && value <= u32::MAX as f64 {
        Ok(value as usize)
    } else {
        Err(errors::invalid(
            "EINVAL",
            format!("EINVAL: invalid argument, length {value}"),
        ))
    }
}

/// A permission bitmask, clamped to the bits `std::fs` accepts. Zero means the
/// caller passed nothing, which Node treats as `0o666`.
pub fn mode(value: f64) -> u32 {
    if value.is_finite() && value > 0.0 {
        value as u32 & 0o7777
    } else {
        0o666
    }
}

/// `node:fs` numeric flags as `OpenOptions`.
pub fn open_options(flags_value: f64, mode: u32) -> std::fs::OpenOptions {
    let flags_value = flags_value as i32;
    let mut options = std::fs::OpenOptions::new();
    // Bit tests, not `matches!`: `matches!(value, A | B)` is the or-pattern
    // `value == A || value == B`, which for Node's flags asks whether the whole
    // mask equals 0 or 2. `'w'` is `WRONLY | CREAT | TRUNC` (577), so that test
    // was false and every write opened read-only and failed `EINVAL`.
    // `RDONLY` is zero, so "read" is the absence of `WRONLY` rather than a bit.
    options
        .read(flags_value & flags::WRONLY == 0)
        .write(flags_value & (flags::WRONLY | flags::RDWR) != 0)
        .create(flags_value & flags::CREAT != 0)
        .create_new(flags_value & flags::EXCL != 0)
        .truncate(flags_value & flags::TRUNC != 0)
        .append(flags_value & flags::APPEND != 0);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.mode(mode);
    }
    #[cfg(not(unix))]
    let _ = mode;
    options
}

/// Milliseconds since the epoch, as the bridge sends them.
pub fn system_time(ms: f64) -> std::time::SystemTime {
    if ms.is_finite() && ms >= 0.0 {
        std::time::UNIX_EPOCH + std::time::Duration::from_millis(ms as u64)
    } else {
        std::time::UNIX_EPOCH
    }
}

/// A `SystemTime` as milliseconds, which is what `StatResult` carries.
pub fn millis(time: std::time::SystemTime) -> f64 {
    time.duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as f64)
        .unwrap_or(0.0)
}

// The spec says `THREAD = Own`; this keeps the module compiled against that.
const _: ModuleThread = ModuleThread::Own;
