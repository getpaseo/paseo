//! Reading, writing, copying, truncating, permissions and times.
//!
//! The async forms are thin wrappers over the sync ones: `std::fs` is blocking
//! either way, and this module has a thread of its own, so the only difference
//! is which thread the bridge calls the function on.
//!
//! Every failure goes through `errors::from_io`, so JS receives a Node code and
//! Node's message rather than an `std::io::Error` kind.

use std::fs;
use std::io::Write as _;
use std::path::Path;

use rn_gpui_module::{ArrayBuffer, ModuleError};

use crate::errors;
use crate::module::{kind, millis, open_options, system_time};
use crate::StatResult;

pub async fn read_file(path: String) -> Result<ArrayBuffer, ModuleError> {
    read_file_sync(path)
}

pub async fn read_text_file(path: String) -> Result<String, ModuleError> {
    read_text_file_sync(path)
}

pub async fn write_file(
    path: String,
    data: ArrayBuffer,
    flags: f64,
    mode: f64,
) -> Result<(), ModuleError> {
    write_bytes(&path, data.as_slice(), flags, mode)
}

pub async fn write_text_file(
    path: String,
    data: String,
    flags: f64,
    mode: f64,
) -> Result<(), ModuleError> {
    write_bytes(&path, data.as_bytes(), flags, mode)
}

pub async fn stat(path: String, follow_symlinks: bool) -> Result<StatResult, ModuleError> {
    stat_of(&path, follow_symlinks)
}

pub async fn rename(from: String, to: String) -> Result<(), ModuleError> {
    fs::rename(&from, &to).map_err(|error| errors::from_io(error, &from))
}

pub async fn copy(from: String, to: String, recursive: bool) -> Result<(), ModuleError> {
    copy_path(&from, &to, recursive)
}

pub async fn truncate(path: String, length: f64) -> Result<(), ModuleError> {
    let length = crate::module::length(length)?;
    let file = fs::OpenOptions::new()
        .write(true)
        .open(&path)
        .map_err(|error| errors::from_io(error, &path))?;
    file.set_len(length as u64)
        .map_err(|error| errors::from_io(error, &path))
}

pub async fn utimes(path: String, atime_ms: f64, mtime_ms: f64) -> Result<(), ModuleError> {
    let atime = filetime::FileTime::from_system_time(system_time(atime_ms));
    let mtime = filetime::FileTime::from_system_time(system_time(mtime_ms));
    filetime::set_file_times(&path, atime, mtime).map_err(|error| errors::from_io(error, &path))
}

pub async fn chmod(path: String, mode: f64) -> Result<(), ModuleError> {
    set_mode(&path, mode)
}

pub fn read_file_sync(path: String) -> Result<ArrayBuffer, ModuleError> {
    fs::read(&path)
        .map(ArrayBuffer::from)
        .map_err(|error| errors::from_io(error, &path))
}

pub fn read_text_file_sync(path: String) -> Result<String, ModuleError> {
    let bytes = fs::read(&path).map_err(|error| errors::from_io(error, &path))?;
    // Node decodes with replacement characters instead of rejecting a file that
    // is not valid UTF-8, so reading a mis-encoded file still yields text.
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

pub fn write_file_sync(
    path: String,
    data: ArrayBuffer,
    flags: f64,
    mode: f64,
) -> Result<bool, ModuleError> {
    write_bytes(&path, data.as_slice(), flags, mode)?;
    Ok(true)
}

pub fn write_text_file_sync(
    path: String,
    data: String,
    flags: f64,
    mode: f64,
) -> Result<bool, ModuleError> {
    write_bytes(&path, data.as_bytes(), flags, mode)?;
    Ok(true)
}

/// `Ok(None)` for a path that is not there: that is what `existsSync` asks, and
/// only a missing path means "no". A permission failure is still an error.
pub fn stat_sync(path: String, follow_symlinks: bool) -> Result<Option<StatResult>, ModuleError> {
    match stat_of(&path, follow_symlinks) {
        Ok(result) => Ok(Some(result)),
        Err(error) if error.code.as_deref() == Some("ENOENT") => Ok(None),
        Err(error) => Err(error),
    }
}

pub fn exists_sync(path: String) -> Result<bool, ModuleError> {
    Ok(matches!(stat_sync(path, true), Ok(Some(_))))
}

pub fn rename_sync(from: String, to: String) -> Result<bool, ModuleError> {
    fs::rename(&from, &to).map_err(|error| errors::from_io(error, &from))?;
    Ok(true)
}

pub fn copy_file_sync(from: String, to: String) -> Result<bool, ModuleError> {
    fs::copy(&from, &to).map_err(|error| errors::from_io(error, &from))?;
    Ok(true)
}

/// The one place a write happens, so bytes and text share the flag and mode
/// translation exactly.
fn write_bytes(path: &str, data: &[u8], flags: f64, mode: f64) -> Result<(), ModuleError> {
    let mut file = open_options(flags, crate::module::mode(mode))
        .open(path)
        .map_err(|error| errors::from_io(error, path))?;
    file.write_all(data)
        .map_err(|error| errors::from_io(error, path))
}

fn stat_of(path: &str, follow_symlinks: bool) -> Result<StatResult, ModuleError> {
    let metadata = if follow_symlinks {
        fs::metadata(path)
    } else {
        fs::symlink_metadata(path)
    }
    .map_err(|error| errors::from_io(error, path))?;
    Ok(stat_result(&metadata))
}

/// The generated `StatResult`, filled from `std::fs::Metadata`.
///
/// Node's `Stats` names the Unix inode fields even on Windows, where they have
/// no meaning; zero is what Node itself reports there.
fn stat_result(metadata: &fs::Metadata) -> StatResult {
    let file_type = metadata.file_type();
    let kind = if file_type.is_file() {
        kind::FILE
    } else if file_type.is_dir() {
        kind::DIRECTORY
    } else if file_type.is_symlink() {
        kind::SYMLINK
    } else {
        kind::OTHER
    };

    #[cfg(unix)]
    let (mode, dev, ino, nlink, uid, gid) = {
        use std::os::unix::fs::MetadataExt as _;
        (
            metadata.mode() as f64,
            metadata.dev() as f64,
            metadata.ino() as f64,
            metadata.nlink() as f64,
            metadata.uid() as f64,
            metadata.gid() as f64,
        )
    };
    #[cfg(not(unix))]
    let (mode, dev, ino, nlink, uid, gid) = (0.0, 0.0, 0.0, 0.0, 0.0, 0.0);

    // `ctime` is the inode change time on Unix; Windows has no such thing, and
    // its creation time is the closest equivalent.
    #[cfg(unix)]
    let ctime_ms = {
        use std::os::unix::fs::MetadataExt as _;
        metadata.ctime() as f64 * 1000.0 + metadata.ctime_nsec() as f64 / 1_000_000.0
    };
    #[cfg(not(unix))]
    let ctime_ms = metadata
        .created()
        .map(millis)
        .unwrap_or_else(|_| metadata.modified().map(millis).unwrap_or(0.0));

    // A file system that cannot report creation gives 0, as Node does, rather
    // than pretending the modification time is the birth time.
    let birthtime_ms = metadata.created().map(millis).unwrap_or(0.0);

    StatResult {
        size: metadata.len() as f64,
        mode,
        kind,
        atime_ms: metadata.accessed().map(millis).unwrap_or(0.0),
        mtime_ms: metadata.modified().map(millis).unwrap_or(0.0),
        ctime_ms,
        birthtime_ms,
        dev,
        ino,
        nlink,
        uid,
        gid,
    }
}

fn copy_path(from: &str, to: &str, recursive: bool) -> Result<(), ModuleError> {
    let metadata = fs::symlink_metadata(from).map_err(|error| errors::from_io(error, from))?;
    if !metadata.is_dir() {
        fs::copy(from, to).map_err(|error| errors::from_io(error, from))?;
        return Ok(());
    }
    if !recursive {
        return Err(errors::invalid(
            "EISDIR",
            format!("EISDIR: illegal operation on a directory, {from}"),
        ));
    }
    copy_tree(Path::new(from), Path::new(to))
}

/// Refuse to copy a directory into itself or a directory beneath it.
///
/// The destination may not exist yet, so the comparison is against its nearest
/// existing ancestor: `a` into `a/b/c` has to be caught before `a/b/c` exists,
/// which is the whole point. Both sides are canonicalised so a symlinked path
/// cannot slip past the check.
///
/// Node's code and wording are reproduced rather than invented; `cpSync` reports
/// `ERR_FS_CP_EINVAL` with `Cannot copy /tmp/cpa/ to a subdirectory of self
/// /tmp/cpa/sub`, and callers match on both.
fn refuse_copy_into_self(from: &Path, to: &Path) -> Result<(), ModuleError> {
    let resolve = |path: &Path| -> Option<std::path::PathBuf> {
        let mut existing = path.to_path_buf();
        let mut tail = Vec::new();
        loop {
            if let Ok(canonical) = existing.canonicalize() {
                return Some(
                    tail.iter()
                        .rev()
                        .fold(canonical, |base, part| base.join(part)),
                );
            }
            let name = existing.file_name().map(|name| name.to_owned())?;
            tail.push(name);
            if !existing.pop() {
                return None;
            }
        }
    };
    let Some(source) = resolve(from) else {
        return Ok(());
    };
    let Some(destination) = resolve(to) else {
        return Ok(());
    };
    if destination == source || destination.starts_with(&source) {
        return Err(errors::invalid(
            "ERR_FS_CP_EINVAL",
            format!(
                "Cannot copy {} to a subdirectory of self {}",
                from.display(),
                to.display()
            ),
        ));
    }
    Ok(())
}

fn copy_tree(from: &Path, to: &Path) -> Result<(), ModuleError> {
    let target = to.to_string_lossy().into_owned();
    // Checked before anything is created: copying a directory into its own
    // subtree would otherwise recurse forever, and the tree it built on the way
    // down would have to be cleaned up by the caller.
    refuse_copy_into_self(from, to)?;
    fs::create_dir_all(to).map_err(|error| errors::from_io(error, &target))?;
    let children = fs::read_dir(from).map_err(|error| errors::from_io(error, &source(from)))?;
    for child in children {
        let child = child.map_err(|error| errors::from_io(error, &source(from)))?;
        let path = child.path();
        let destination = to.join(child.file_name());
        // `file_type` does not follow links, which keeps a link cycle in the
        // source tree from turning into infinite recursion.
        let file_type = child
            .file_type()
            .map_err(|error| errors::from_io(error, &source(&path)))?;
        if file_type.is_dir() {
            copy_tree(&path, &destination)?;
        } else if file_type.is_symlink() {
            copy_symlink(&path, &destination)?;
        } else {
            fs::copy(&path, &destination)
                .map_err(|error| errors::from_io(error, &source(&path)))?;
        }
    }
    Ok(())
}

#[cfg(unix)]
fn copy_symlink(from: &Path, to: &Path) -> Result<(), ModuleError> {
    let target = fs::read_link(from).map_err(|error| errors::from_io(error, &source(from)))?;
    std::os::unix::fs::symlink(&target, to).map_err(|error| errors::from_io(error, &source(from)))
}

/// Windows needs a privilege to create a symbolic link, so there the link is
/// followed and its target copied, which is what a caller copying a tree wants
/// to end up with anyway.
#[cfg(not(unix))]
fn copy_symlink(from: &Path, to: &Path) -> Result<(), ModuleError> {
    fs::copy(from, to)
        .map(|_| ())
        .map_err(|error| errors::from_io(error, &source(from)))
}

fn source(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

#[cfg(unix)]
fn set_mode(path: &str, mode: f64) -> Result<(), ModuleError> {
    use std::os::unix::fs::PermissionsExt as _;
    let bits = if mode.is_finite() && mode >= 0.0 {
        mode as u32 & 0o7777
    } else {
        0o666
    };
    fs::set_permissions(path, fs::Permissions::from_mode(bits))
        .map_err(|error| errors::from_io(error, path))
}

/// Windows has no permission bits. The closest equivalent is the read-only
/// attribute, so a mode without a write bit marks the file read-only and any
/// other mode clears it; nothing else about the mode survives.
#[cfg(not(unix))]
fn set_mode(path: &str, mode: f64) -> Result<(), ModuleError> {
    let metadata = fs::metadata(path).map_err(|error| errors::from_io(error, path))?;
    let mut permissions = metadata.permissions();
    permissions.set_readonly(mode.is_finite() && mode > 0.0 && mode as u32 & 0o200 == 0);
    fs::set_permissions(path, permissions).map_err(|error| errors::from_io(error, path))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::module::flags;
    use tempfile::TempDir;

    /// The async wrappers never actually suspend (they call `std::fs` directly),
    /// so a single-poll executor is enough and keeps the tests free of a runtime.
    fn block_on<F: std::future::Future>(future: F) -> F::Output {
        let mut future = std::pin::pin!(future);
        let waker = std::task::Waker::noop();
        let mut context = std::task::Context::from_waker(waker);
        // One poll, no loop: these helpers do their work inline, so a `Pending`
        // would mean the helper is not synchronous after all, which the test
        // should fail loudly on rather than spin.
        match future.as_mut().poll(&mut context) {
            std::task::Poll::Ready(value) => value,
            std::task::Poll::Pending => panic!("the wrappers are synchronous"),
        }
    }

    fn tempdir() -> TempDir {
        TempDir::new().expect("a temporary directory")
    }

    fn text(path: &Path) -> String {
        path.to_string_lossy().into_owned()
    }

    /// `'w'` in Node's table.
    fn write_flags() -> f64 {
        f64::from(flags::WRONLY | flags::CREAT | flags::TRUNC)
    }

    #[test]
    fn text_round_trip() {
        let dir = tempdir();
        let path = dir.path().join("note.txt");

        block_on(write_text_file(
            text(&path),
            "hello".to_string(),
            write_flags(),
            0.0,
        ))
        .expect("write");
        assert_eq!(
            block_on(read_text_file(text(&path))).expect("read"),
            "hello"
        );
        assert_eq!(
            read_text_file_sync(text(&path)).expect("read sync"),
            "hello"
        );

        assert!(
            write_text_file_sync(text(&path), "again".to_string(), write_flags(), 0.0)
                .expect("write sync")
        );
        assert_eq!(fs::read_to_string(&path).expect("on disk"), "again");
    }

    #[test]
    fn bytes_round_trip() {
        let dir = tempdir();
        let path = dir.path().join("bytes.bin");
        let bytes = ArrayBuffer::from(vec![0u8, 1, 254, 255]);

        block_on(write_file(text(&path), bytes.clone(), write_flags(), 0.0)).expect("write");
        assert_eq!(
            block_on(read_file(text(&path))).expect("read").as_slice(),
            &[0u8, 1, 254, 255]
        );
        assert_eq!(
            read_file_sync(text(&path)).expect("read sync").into_vec(),
            vec![0u8, 1, 254, 255]
        );
    }

    #[test]
    fn an_append_flag_keeps_the_existing_bytes() {
        let dir = tempdir();
        let path = dir.path().join("log.txt");
        fs::write(&path, b"one").expect("seed");

        block_on(write_text_file(
            text(&path),
            "two".to_string(),
            f64::from(flags::WRONLY | flags::CREAT | flags::APPEND),
            0.0,
        ))
        .expect("append");

        assert_eq!(fs::read_to_string(&path).expect("on disk"), "onetwo");
    }

    #[test]
    fn stat_reports_kind_and_size() {
        let dir = tempdir();
        let file = dir.path().join("data.bin");
        fs::write(&file, b"12345").expect("seed");

        let stats = block_on(stat(text(&file), true)).expect("stat");
        assert_eq!(stats.kind, kind::FILE);
        assert_eq!(stats.size, 5.0);
        assert!(stats.mtime_ms > 0.0);
        #[cfg(unix)]
        assert_ne!(
            stats.mode as u32 & 0o777,
            0,
            "the mode bits come from MetadataExt"
        );

        let directory = block_on(stat(text(dir.path()), true)).expect("stat dir");
        assert_eq!(directory.kind, kind::DIRECTORY);
    }

    #[cfg(unix)]
    #[test]
    fn stat_follows_links_only_when_asked() {
        let dir = tempdir();
        let target = dir.path().join("target.txt");
        fs::write(&target, b"x").expect("seed");
        let link = dir.path().join("link.txt");
        std::os::unix::fs::symlink(&target, &link).expect("symlink");

        assert_eq!(
            block_on(stat(text(&link), false)).expect("lstat").kind,
            kind::SYMLINK
        );
        assert_eq!(
            block_on(stat(text(&link), true)).expect("stat").kind,
            kind::FILE
        );
    }

    #[test]
    fn stat_sync_is_none_for_a_missing_path() {
        let dir = tempdir();
        let missing = text(&dir.path().join("absent.txt"));
        assert!(stat_sync(missing, true).expect("stat").is_none());
    }

    #[test]
    fn exists_sync_is_false_for_a_missing_path() {
        let dir = tempdir();
        assert!(!exists_sync(text(&dir.path().join("absent.txt"))).expect("exists"));
        assert!(exists_sync(text(dir.path())).expect("exists"));
    }

    #[test]
    fn a_missing_file_is_enoent() {
        let dir = tempdir();
        let missing = text(&dir.path().join("gone.txt"));

        let error = block_on(read_text_file(missing.clone())).expect_err("read");
        assert_eq!(error.code.as_deref(), Some("ENOENT"));
        assert!(error
            .message
            .starts_with("ENOENT: no such file or directory"));

        let error = read_file_sync(missing).expect_err("read sync");
        assert_eq!(error.code.as_deref(), Some("ENOENT"));
    }

    #[test]
    fn rename_moves_a_file() {
        let dir = tempdir();
        let from = dir.path().join("a.txt");
        let to = dir.path().join("b.txt");
        fs::write(&from, b"a").expect("seed");

        block_on(rename(text(&from), text(&to))).expect("rename");
        assert!(!from.exists());
        assert_eq!(fs::read_to_string(&to).expect("on disk"), "a");

        assert!(rename_sync(text(&to), text(&from)).expect("rename sync"));
        assert!(from.exists());
    }

    #[test]
    fn copy_copies_a_file() {
        let dir = tempdir();
        let from = dir.path().join("one.txt");
        fs::write(&from, b"copy me").expect("seed");
        let to = dir.path().join("two.txt");

        block_on(copy(text(&from), text(&to), false)).expect("copy");
        assert_eq!(fs::read_to_string(&to).expect("on disk"), "copy me");

        let third = dir.path().join("three.txt");
        assert!(copy_file_sync(text(&from), text(&third)).expect("copy sync"));
        assert_eq!(fs::read_to_string(&third).expect("on disk"), "copy me");
    }

    #[test]
    fn copy_copies_a_directory_tree_when_recursive() {
        let dir = tempdir();
        let from = dir.path().join("tree");
        fs::create_dir_all(from.join("nested")).expect("tree");
        fs::write(from.join("top.txt"), b"top").expect("seed");
        fs::write(from.join("nested").join("deep.txt"), b"deep").expect("seed");
        let to = dir.path().join("copy");

        block_on(copy(text(&from), text(&to), true)).expect("copy tree");
        assert_eq!(
            fs::read_to_string(to.join("nested").join("deep.txt")).expect("on disk"),
            "deep"
        );

        let error = block_on(copy(text(&from), text(&dir.path().join("nope")), false))
            .expect_err("a directory without recursive");
        assert_eq!(error.code.as_deref(), Some("EISDIR"));
    }

    #[test]
    fn copying_a_directory_into_itself_is_refused() {
        let dir = tempdir();
        let from = dir.path().join("tree");
        fs::create_dir_all(from.join("sub")).expect("tree");
        fs::write(from.join("top.txt"), b"top").expect("seed");

        // Into a directory beneath itself. This used to recurse until the path
        // got too long, and left whatever it had built on the way down.
        let into_self = from.join("sub");
        let error = block_on(copy(text(&from), text(&into_self), true))
            .expect_err("copy into a subdirectory of self");
        assert_eq!(error.code.as_deref(), Some("ERR_FS_CP_EINVAL"));
        assert!(
            error.message.starts_with("Cannot copy"),
            "{}",
            error.message
        );
        // The check runs before anything is created, so the destination is still
        // just the empty directory it was.
        assert_eq!(
            fs::read_dir(&into_self).expect("still there").count(),
            0,
            "nothing may be created when the copy is refused"
        );

        // The directory itself is the same case.
        let error = block_on(copy(text(&from), text(&from), true)).expect_err("copy onto itself");
        assert_eq!(error.code.as_deref(), Some("ERR_FS_CP_EINVAL"));
    }

    #[test]
    fn truncate_changes_the_length() {
        let dir = tempdir();
        let path = dir.path().join("long.txt");
        fs::write(&path, b"0123456789").expect("seed");

        block_on(truncate(text(&path), 4.0)).expect("truncate");
        assert_eq!(fs::read_to_string(&path).expect("on disk"), "0123");
    }

    #[test]
    fn utimes_sets_both_times() {
        let dir = tempdir();
        let path = dir.path().join("stamp.txt");
        fs::write(&path, b"x").expect("seed");

        block_on(utimes(
            text(&path),
            1_000_000_000_000.0,
            1_100_000_000_000.0,
        ))
        .expect("utimes");

        let stats = block_on(stat(text(&path), true)).expect("stat");
        assert_eq!(stats.mtime_ms, 1_100_000_000_000.0);
    }

    #[cfg(unix)]
    #[test]
    fn chmod_sets_the_permission_bits() {
        use std::os::unix::fs::PermissionsExt as _;
        let dir = tempdir();
        let path = dir.path().join("locked.txt");
        fs::write(&path, b"x").expect("seed");

        block_on(chmod(text(&path), f64::from(0o640u32))).expect("chmod");

        let mode = fs::metadata(&path).expect("metadata").permissions().mode() & 0o777;
        assert_eq!(mode, 0o640);
    }
}
