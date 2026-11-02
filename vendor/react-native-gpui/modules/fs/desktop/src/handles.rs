//! Open descriptors: `open`, `read`, `write`, `fstat`, `fsync`, `ftruncate`
//! and `close`.
//!
//! A descriptor is an id from the module's table plus a clone of the file that
//! shares its offset, which is what a descriptor is to the OS. The table owns
//! the original, so dropping the module closes every handle; ids are never
//! reused, so a stale `fd` that JS kept across a `close` fails with `EBADF`
//! instead of reaching an unrelated file.
//!
//! These functions are synchronous even though the trait methods around them are
//! `async`: the module has a thread of its own, so a blocking call here never
//! blocks JS or the UI.

use std::fs::File;
use std::io::{Read as _, Seek as _, Write as _};

use rn_gpui_module::{ArrayBuffer, ModuleError};

use crate::errors;
use crate::module::{bad_fd, descriptor, flags, kind, millis, open_options};
use crate::StatResult;

pub fn open(
    module: &crate::RNFsModule,
    path: String,
    flags: f64,
    mode: f64,
) -> Result<f64, ModuleError> {
    // The table owns the file; everything the caller asks of it goes through
    // `module.file(fd)`, which hands back a clone sharing the same offset.
    let file = open_options(flags, crate::module::mode(mode))
        .open(&path)
        .map_err(|error| errors::from_io(error, &path))?;

    let id = module.take_fd();
    // `RDONLY` is zero, so "writable" is the presence of any write bit rather
    // than the absence of a read bit.
    let writable = (flags as i32) & (flags::WRONLY | flags::RDWR) != 0;
    module
        .files
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .insert(id, (file, writable));
    Ok(f64::from(id))
}

pub fn read(
    module: &crate::RNFsModule,
    fd: f64,
    length: f64,
    position: f64,
) -> Result<ArrayBuffer, ModuleError> {
    let id = descriptor(fd)?;
    let length = crate::module::length(length)?;
    let mut file = module.file(fd)?;

    // Nothing larger than the file can be read, so the buffer is capped at what
    // remains rather than at what was asked for. A caller that passes a huge
    // `length` — which `readToEnd` used to do deliberately — would otherwise ask
    // for that many bytes up front and get whatever the allocator did with it.
    let cap = match offset(position)? {
        Some(start) => file
            .metadata()
            .ok()
            .and_then(|meta| meta.len().checked_sub(start))
            .map_or(length, |remaining| length.min(remaining as usize)),
        None => file
            .metadata()
            .ok()
            .and_then(|meta| {
                // A cursor read starts wherever the handle is, so the remainder
                // is measured from there rather than from the start.
                let current = file.stream_position().ok()?;
                meta.len().checked_sub(current)
            })
            .map_or(length, |remaining| length.min(remaining as usize)),
    };
    let mut buffer = vec![0u8; cap];
    let filled = match offset(position)? {
        Some(start) => read_at(&mut file, &mut buffer, start, id)?,
        None => read_cursor(&mut file, &mut buffer, id)?,
    };
    // A read that stopped at end of file is a short read, not a failure, so the
    // buffer is shrunk to what the OS actually produced rather than padded.
    buffer.truncate(filled);
    Ok(ArrayBuffer::from(buffer))
}

pub fn write(
    module: &crate::RNFsModule,
    fd: f64,
    data: ArrayBuffer,
    position: f64,
) -> Result<f64, ModuleError> {
    let id = descriptor(fd)?;
    let (mut file, writable) = module.file_and_writability(fd)?;
    // Checked from the flags the handle was opened with, not from what the OS
    // says: a write to a read-only handle is `EBADF` in Node, `EACCES` on
    // Windows and `EBADF` on Unix.
    if !writable {
        return Err(bad_fd(id));
    }
    let bytes = data.as_slice();
    if bytes.is_empty() {
        return Ok(0.0);
    }

    // Read before the borrow below: `positioned_write` needs `&mut File` so the
    // Windows branch can seek, and a match guard borrowing the file would overlap.
    let append_only = appends(&file);
    let written = match offset(position)? {
        // An append-mode descriptor appends whatever offset the caller passes:
        // a cursor write does that because the file was opened with `O_APPEND`
        // (or `FILE_APPEND_DATA`), and Linux also appends for a positioned
        // write. Ignoring the offset keeps the platforms alike and is what
        // callers of `appendFile` expect.
        Some(start) if !append_only => write_at(&mut file, bytes, start, id)?,
        _ => write_cursor(&mut file, bytes, id)?,
    };
    Ok(written as f64)
}

pub fn fstat(module: &crate::RNFsModule, fd: f64) -> Result<StatResult, ModuleError> {
    let id = descriptor(fd)?;
    let file = module.file(fd)?;
    let metadata = file.metadata().map_err(|error| io_error(error, id))?;
    Ok(stat_result(&metadata))
}

pub fn fsync(module: &crate::RNFsModule, fd: f64) -> Result<(), ModuleError> {
    let id = descriptor(fd)?;
    let file = module.file(fd)?;
    file.sync_all().map_err(|error| io_error(error, id))
}

pub fn ftruncate(module: &crate::RNFsModule, fd: f64, length: f64) -> Result<(), ModuleError> {
    let id = descriptor(fd)?;
    let length = crate::module::length(length)?;
    let file = module.file(fd)?;
    file.set_len(length as u64)
        .map_err(|error| io_error(error, id))
}

pub fn close(module: &crate::RNFsModule, fd: f64) -> Result<(), ModuleError> {
    let id = descriptor(fd)?;
    let mut files = module
        .files
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    // Removing rather than merely dropping the entry is what makes a second
    // close report `EBADF`: the id is gone, and it is never handed out again.
    files.remove(&id).ok_or_else(|| bad_fd(id))?;
    Ok(())
}

/// A failure from an operation on a descriptor.
///
/// The table may still know an id the kernel has already rejected — a write to a
/// read-only descriptor is the usual way — and Node reports that as `EBADF`, not
/// as a generic I/O error. Everything else goes through the shared mapping, with
/// the descriptor standing in for the path a Node message names.
fn io_error(error: std::io::Error, id: u32) -> ModuleError {
    #[cfg(unix)]
    if error.raw_os_error() == Some(libc::EBADF) {
        return bad_fd(id);
    }
    errors::from_io(error, &id.to_string())
}

/// The byte offset a `position` argument names, or `None` for "the current
/// offset", which is what a negative position means to `node:fs`.
fn offset(position: f64) -> Result<Option<u64>, ModuleError> {
    if !position.is_finite() {
        return Err(errors::invalid(
            "EINVAL",
            format!("EINVAL: invalid argument, position {position}"),
        ));
    }
    if position < 0.0 {
        return Ok(None);
    }
    Ok(Some(position as u64))
}

/// Whether the descriptor was opened for append.
///
/// The table stores only the `File`, so the bit is read back from the descriptor
/// itself with `F_GETFL`: that reports the flag the kernel actually holds, which
/// is more reliable than tracking a second copy beside the table.
#[cfg(unix)]
fn appends(file: &File) -> bool {
    use std::os::unix::io::AsRawFd as _;
    // SAFETY: `file` owns a valid descriptor for the duration of the call; `F_GETFL` takes no argument.
    let flags = unsafe { libc::fcntl(file.as_raw_fd(), libc::F_GETFL) };
    flags >= 0 && flags & libc::O_APPEND != 0
}

/// Windows keeps the append bit inside the handle's granted access, with no
/// portable way to read it back, so the answer is "no" here. Cursor writes still
/// append — `append(true)` opens with `FILE_APPEND_DATA`, which does that in the
/// kernel — and a write with an explicit offset lands at that offset, which is
/// what a caller using `pwrite` on Windows would expect.
#[cfg(not(unix))]
fn appends(_file: &File) -> bool {
    false
}

fn read_at(file: &mut File, buffer: &mut [u8], offset: u64, id: u32) -> Result<usize, ModuleError> {
    let mut filled = 0;
    while filled < buffer.len() {
        match positioned_read(file, &mut buffer[filled..], offset + filled as u64) {
            Ok(0) => break,
            Ok(count) => filled += count,
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(io_error(error, id)),
        }
    }
    Ok(filled)
}

fn read_cursor(file: &mut File, buffer: &mut [u8], id: u32) -> Result<usize, ModuleError> {
    let mut filled = 0;
    while filled < buffer.len() {
        match file.read(&mut buffer[filled..]) {
            Ok(0) => break,
            Ok(count) => filled += count,
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(io_error(error, id)),
        }
    }
    Ok(filled)
}

fn write_at(file: &mut File, bytes: &[u8], offset: u64, id: u32) -> Result<usize, ModuleError> {
    let mut written = 0;
    while written < bytes.len() {
        match positioned_write(file, &bytes[written..], offset + written as u64) {
            // A regular file does not write zero bytes for a non-empty buffer;
            // treating it as `EIO` keeps the loop from spinning forever.
            Ok(0) => return Err(errors::invalid("EIO", format!("EIO: i/o error, {id}"))),
            Ok(count) => written += count,
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(io_error(error, id)),
        }
    }
    Ok(written)
}

fn write_cursor(file: &mut File, bytes: &[u8], id: u32) -> Result<usize, ModuleError> {
    file.write_all(bytes).map_err(|error| io_error(error, id))?;
    Ok(bytes.len())
}

#[cfg(unix)]
fn positioned_read(file: &mut File, buffer: &mut [u8], offset: u64) -> std::io::Result<usize> {
    use std::os::unix::fs::FileExt as _;
    // `read_at` takes `&self`, but the call sites hold `&mut File` so the
    // Windows branch — which has to seek — shares one signature.
    (&*file).read_at(buffer, offset)
}

/// Windows' positional read, with the cursor left where it was.
///
/// `FileExt::seek_read` is documented as not affecting the cursor, but on a
/// synchronous handle — which is what `File::open` gives — the underlying
/// `ReadFile` with an `OVERLAPPED` offset keeps the file position as a side
/// effect. Node's positional forms leave the descriptor alone, and so does the
/// Unix branch above, so the position is saved and restored here. Without this a
/// positioned read moved the cursor, and a following cursor read started from the
/// wrong place.
#[cfg(windows)]
fn positioned_read(file: &mut File, buffer: &mut [u8], offset: u64) -> std::io::Result<usize> {
    use std::io::Seek as _;
    use std::os::windows::fs::FileExt as _;
    let saved = file.stream_position();
    let result = file.seek_read(buffer, offset);
    if let Ok(position) = saved {
        let _ = file.seek(std::io::SeekFrom::Start(position));
    }
    result
}

#[cfg(unix)]
fn positioned_write(file: &mut File, bytes: &[u8], offset: u64) -> std::io::Result<usize> {
    use std::os::unix::fs::FileExt as _;
    (&*file).write_at(bytes, offset)
}

/// Windows' positional write, with the cursor left where it was. Same reason as
/// `positioned_read` above.
#[cfg(windows)]
fn positioned_write(file: &mut File, bytes: &[u8], offset: u64) -> std::io::Result<usize> {
    use std::io::Seek as _;
    use std::os::windows::fs::FileExt as _;
    let saved = file.stream_position();
    let result = file.seek_write(bytes, offset);
    if let Ok(position) = saved {
        let _ = file.seek(std::io::SeekFrom::Start(position));
    }
    result
}

/// The generated `StatResult`, filled from `std::fs::Metadata`.
///
/// `files::stat` builds the same shape for a path. The two are deliberately
/// separate: `files` and `handles` are independent, and twenty duplicated lines
/// cost less than one file reaching into the other's internals.
fn stat_result(metadata: &std::fs::Metadata) -> StatResult {
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

    // Node's `Stats` names the Unix inode fields even on Windows, where they
    // have no meaning; zero is what Node reports there too.
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

    // `ctime` is the inode change time on Unix; Windows has no equivalent, and
    // its creation time is the closest thing it has.
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
    StatResult {
        size: metadata.len() as f64,
        mode,
        kind,
        atime_ms: metadata.accessed().map(millis).unwrap_or(0.0),
        mtime_ms: metadata.modified().map(millis).unwrap_or(0.0),
        ctime_ms,
        birthtime_ms: metadata.created().map(millis).unwrap_or(0.0),
        dev,
        ino,
        nlink,
        uid,
        gid,
    }
}

#[cfg(test)]
mod tests {
    use std::path::Path;
    use std::sync::Arc;

    use rn_gpui_module::{EventEmitter, ModuleInstance, Value};
    use tempfile::TempDir;

    use super::*;
    use crate::native_fs_module;

    /// The async trait methods never actually suspend — they call these helpers
    /// directly — so a single-poll executor drives the generated glue without a
    /// runtime.
    fn block_on<F: std::future::Future>(future: F) -> F::Output {
        let mut future = std::pin::pin!(future);
        let waker = std::task::Waker::noop();
        let mut context = std::task::Context::from_waker(waker);
        loop {
            match future.as_mut().poll(&mut context) {
                std::task::Poll::Ready(value) => return value,
                std::task::Poll::Pending => std::thread::yield_now(),
            }
        }
    }

    /// `NativeFsEvents` has a private emitter and no constructor, so a test
    /// cannot call `RNFsModule::create` itself. Building the instance through the
    /// descriptor the bridge uses is the supported way in, and it exercises the
    /// generated glue as a bonus.
    fn module() -> Arc<dyn ModuleInstance> {
        (native_fs_module::<crate::RNFsModule>().create)(EventEmitter::new(1))
    }

    fn index(name: &str) -> usize {
        native_fs_module::<crate::RNFsModule>()
            .methods
            .iter()
            .position(|method| method.name == name)
            .unwrap_or_else(|| panic!("the spec has no method {name}"))
    }

    fn call(
        module: &Arc<dyn ModuleInstance>,
        name: &str,
        args: Vec<Value>,
    ) -> Result<Value, ModuleError> {
        block_on(module.clone().call_promise(index(name), args)?)
    }

    fn text(path: &Path) -> String {
        path.to_string_lossy().into_owned()
    }

    fn open_fd(module: &Arc<dyn ModuleInstance>, path: &Path, flags_value: i32) -> f64 {
        let value = call(
            module,
            "open",
            vec![
                Value::String(text(path)),
                Value::Number(f64::from(flags_value)),
                Value::Number(0.0),
            ],
        )
        .expect("open");
        match value {
            Value::Number(fd) => fd,
            other => panic!("expected a descriptor, got {}", other.type_name()),
        }
    }

    fn read_bytes(
        module: &Arc<dyn ModuleInstance>,
        fd: f64,
        length: f64,
        position: f64,
    ) -> Result<Vec<u8>, ModuleError> {
        match call(
            module,
            "read",
            vec![
                Value::Number(fd),
                Value::Number(length),
                Value::Number(position),
            ],
        )? {
            Value::Buffer(bytes) => Ok(bytes),
            other => panic!("expected bytes, got {}", other.type_name()),
        }
    }

    fn write_bytes(
        module: &Arc<dyn ModuleInstance>,
        fd: f64,
        bytes: &[u8],
        position: f64,
    ) -> Result<f64, ModuleError> {
        match call(
            module,
            "write",
            vec![
                Value::Number(fd),
                Value::Buffer(bytes.to_vec()),
                Value::Number(position),
            ],
        )? {
            Value::Number(written) => Ok(written),
            other => panic!("expected a count, got {}", other.type_name()),
        }
    }

    fn stat_size(module: &Arc<dyn ModuleInstance>, fd: f64) -> f64 {
        let value = call(module, "fstat", vec![Value::Number(fd)]).expect("fstat");
        let Value::Object(fields) = value else {
            panic!("expected a stat object");
        };
        fields
            .iter()
            .find(|(name, _)| name == "size")
            .and_then(|(_, value)| match value {
                Value::Number(size) => Some(*size),
                _ => None,
            })
            .expect("a size field")
    }

    fn close_fd(module: &Arc<dyn ModuleInstance>, fd: f64) -> Result<Value, ModuleError> {
        call(module, "close", vec![Value::Number(fd)])
    }

    /// Open a fresh file containing `contents` and hand back its descriptor.
    fn opened(module: &Arc<dyn ModuleInstance>, dir: &TempDir, contents: &str) -> (String, f64) {
        let path = dir.path().join("data.txt");
        std::fs::write(&path, contents).expect("write the fixture file");
        let fd = open_fd(module, &path, flags::RDWR);
        (text(&path), fd)
    }

    #[test]
    fn a_handle_reads_back_what_it_wrote() {
        let dir = TempDir::new().expect("a temporary directory");
        let path = dir.path().join("note.txt");
        let module = module();

        let fd = open_fd(&module, &path, flags::WRONLY | flags::CREAT | flags::TRUNC);
        assert_eq!(
            write_bytes(&module, fd, b"hello", -1.0).expect("write"),
            5.0
        );
        assert_eq!(stat_size(&module, fd), 5.0);
        close_fd(&module, fd).expect("close");

        let fd = open_fd(&module, &path, flags::RDONLY);
        assert_eq!(read_bytes(&module, fd, 5.0, -1.0).expect("read"), b"hello");
        close_fd(&module, fd).expect("close");
    }

    #[test]
    fn a_positioned_read_leaves_the_cursor_alone() {
        let dir = TempDir::new().expect("a temporary directory");
        let module = module();
        let (_, fd) = opened(&module, &dir, "abcdef");

        assert_eq!(read_bytes(&module, fd, 2.0, 0.0).expect("read"), b"ab");
        // The cursor never moved, so a cursor read starts at the beginning.
        assert_eq!(read_bytes(&module, fd, 2.0, -1.0).expect("read"), b"ab");
        assert_eq!(read_bytes(&module, fd, 2.0, -1.0).expect("read"), b"cd");
        close_fd(&module, fd).expect("close");
    }

    #[test]
    fn a_positioned_write_only_touches_its_range() {
        let dir = TempDir::new().expect("a temporary directory");
        let module = module();
        let (path, fd) = opened(&module, &dir, "abcdef");

        assert_eq!(write_bytes(&module, fd, b"XY", 2.0).expect("write"), 2.0);
        assert_eq!(stat_size(&module, fd), 6.0);
        assert_eq!(std::fs::read(&path).expect("on disk"), b"abXYef");
        close_fd(&module, fd).expect("close");
    }

    #[test]
    fn reading_past_the_end_is_a_short_read_not_an_error() {
        let dir = TempDir::new().expect("a temporary directory");
        let module = module();
        let (_, fd) = opened(&module, &dir, "abc");

        // Two bytes asked for, one left: the buffer holds exactly one byte.
        assert_eq!(read_bytes(&module, fd, 2.0, 2.0).expect("read"), b"c");
        // Nothing left at all: an empty buffer, still a success.
        assert_eq!(read_bytes(&module, fd, 8.0, 10.0).expect("read"), b"");
        assert_eq!(read_bytes(&module, fd, 8.0, -1.0).expect("read"), b"abc");
        assert_eq!(read_bytes(&module, fd, 8.0, -1.0).expect("read"), b"");
        close_fd(&module, fd).expect("close");
    }

    #[test]
    fn a_huge_length_only_allocates_what_the_file_holds() {
        let dir = TempDir::new().expect("a temporary directory");
        let module = module();
        let (_, fd) = opened(&module, &dir, "0123456789");

        // The buffer is capped at what remains, so this returns rather than
        // trying to allocate four gigabytes. Finishing at all is the check: an
        // allocation of `u32::MAX` bytes would abort the test process instead.
        let bytes = read_bytes(&module, fd, u32::MAX as f64, 0.0).expect("read");
        assert_eq!(bytes, b"0123456789");
        close_fd(&module, fd).expect("close");
    }

    #[test]
    fn appending_ignores_the_position() {
        let dir = TempDir::new().expect("a temporary directory");
        let path = dir.path().join("log.txt");
        std::fs::write(&path, b"ab").expect("write the fixture file");
        let module = module();

        let fd = open_fd(&module, &path, flags::APPEND | flags::WRONLY | flags::CREAT);
        write_bytes(&module, fd, b"cd", -1.0).expect("append");
        // An append-mode descriptor appends even when an offset is passed, which
        // is what the kernel does on Linux and what `appendFile` means.
        write_bytes(&module, fd, b"ef", 0.0).expect("append");
        assert_eq!(stat_size(&module, fd), 6.0);
        close_fd(&module, fd).expect("close");
        assert_eq!(std::fs::read(&path).expect("on disk"), b"abcdef");
    }

    #[test]
    fn truncating_by_descriptor_changes_the_size() {
        let dir = TempDir::new().expect("a temporary directory");
        let module = module();
        let (_, fd) = opened(&module, &dir, "abcdef");

        call(
            &module,
            "ftruncate",
            vec![Value::Number(fd), Value::Number(3.0)],
        )
        .expect("ftruncate");
        assert_eq!(stat_size(&module, fd), 3.0);
        assert_eq!(read_bytes(&module, fd, 16.0, 0.0).expect("read"), b"abc");
        close_fd(&module, fd).expect("close");
    }

    #[test]
    fn syncing_a_handle_succeeds() {
        let dir = TempDir::new().expect("a temporary directory");
        let module = module();
        let (_, fd) = opened(&module, &dir, "abc");
        write_bytes(&module, fd, b"d", 3.0).expect("write");
        call(&module, "fsync", vec![Value::Number(fd)]).expect("fsync");
        close_fd(&module, fd).expect("close");
    }

    #[test]
    fn a_second_close_is_ebadf() {
        let dir = TempDir::new().expect("a temporary directory");
        let module = module();
        let (_, fd) = opened(&module, &dir, "abc");

        close_fd(&module, fd).expect("the first close");
        let error = close_fd(&module, fd).expect_err("the second close");
        assert_eq!(error.code.as_deref(), Some("EBADF"));
    }

    #[test]
    fn a_closed_descriptor_is_ebadf_for_every_op() {
        let dir = TempDir::new().expect("a temporary directory");
        let module = module();
        let (_, fd) = opened(&module, &dir, "abc");
        close_fd(&module, fd).expect("close");

        let error = read_bytes(&module, fd, 1.0, -1.0).expect_err("read");
        assert_eq!(error.code.as_deref(), Some("EBADF"));
        let error = write_bytes(&module, fd, b"x", -1.0).expect_err("write");
        assert_eq!(error.code.as_deref(), Some("EBADF"));
        let error = call(&module, "fstat", vec![Value::Number(fd)]).expect_err("fstat");
        assert_eq!(error.code.as_deref(), Some("EBADF"));
    }

    #[test]
    fn opening_a_missing_file_is_enoent() {
        let dir = TempDir::new().expect("a temporary directory");
        let path = dir.path().join("gone.txt");
        let module = module();

        let error = call(
            &module,
            "open",
            vec![
                Value::String(text(&path)),
                Value::Number(f64::from(flags::RDONLY)),
                Value::Number(0.0),
            ],
        )
        .expect_err("open");
        assert_eq!(error.code.as_deref(), Some("ENOENT"));
    }

    /// A descriptor the table still knows but the kernel rejects: Node says
    /// `EBADF` here, and so must this module, rather than a generic `EIO`.
    #[test]
    fn writing_through_a_read_only_descriptor_is_ebadf() {
        let dir = TempDir::new().expect("a temporary directory");
        let module = module();
        let path = dir.path().join("data.txt");
        std::fs::write(&path, b"abc").expect("write the fixture file");
        let fd = open_fd(&module, &path, flags::RDONLY);

        let error = write_bytes(&module, fd, b"x", -1.0).expect_err("write");
        assert_eq!(error.code.as_deref(), Some("EBADF"));
        // Reading is still fine, and the file is untouched.
        assert_eq!(read_bytes(&module, fd, 3.0, 0.0).expect("read"), b"abc");
        close_fd(&module, fd).expect("close");
    }

    #[test]
    fn a_non_finite_position_is_einval() {
        let dir = TempDir::new().expect("a temporary directory");
        let module = module();
        let (_, fd) = opened(&module, &dir, "abc");

        let error = read_bytes(&module, fd, 1.0, f64::NAN).expect_err("read");
        assert_eq!(error.code.as_deref(), Some("EINVAL"));
        let error = write_bytes(&module, fd, b"x", f64::INFINITY).expect_err("write");
        assert_eq!(error.code.as_deref(), Some("EINVAL"));
        close_fd(&module, fd).expect("close");
    }
}
