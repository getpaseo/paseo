//! URLs that open the app: from the OS, from the command line, or from a second
//! launch that handed its arguments to this process.

use crate::host::Host;
use serde_json::json;
use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

static INITIAL: Mutex<Option<String>> = Mutex::new(None);
static HOST: Mutex<Option<Host>> = Mutex::new(None);
static READY: AtomicBool = AtomicBool::new(false);

/// The first argument that is a URL with one of `schemes`.
pub fn url_in_args<I, S>(args: I, schemes: &[String]) -> Option<String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    args.into_iter().find_map(|arg| {
        let arg = arg.as_ref();
        let (scheme, _) = arg.split_once(':')?;
        schemes
            .iter()
            .any(|candidate| candidate.eq_ignore_ascii_case(scheme))
            .then(|| arg.to_string())
    })
}

/// JS is loaded: URLs from now on are `url` events rather than the launch URL.
pub fn mark_ready(host: Host) {
    *HOST.lock().expect("deep link host poisoned") = Some(host);
    READY.store(true, Ordering::Release);
}

/// A URL reached the app. Before JS is loaded it is the one that launched it.
pub fn handle_url(url: String) {
    if READY.load(Ordering::Acquire) {
        if let Some(host) = HOST.lock().expect("deep link host poisoned").as_ref() {
            host.emit_device_event_json("url", &json!({ "url": url }).to_string());
            return;
        }
    }
    let mut initial = INITIAL.lock().expect("deep link state poisoned");
    if initial.is_none() {
        *initial = Some(url);
    }
}

/// Reports to JS that another launch handed its arguments to this process.
pub fn second_instance(args: &[String]) {
    if READY.load(Ordering::Acquire) {
        if let Some(host) = HOST.lock().expect("deep link host poisoned").as_ref() {
            host.emit_device_event_json(
                "gpuiDesktop:secondInstance",
                &json!({ "args": args }).to_string(),
            );
        }
    }
}

pub fn initial_url() -> Option<String> {
    INITIAL.lock().expect("deep link state poisoned").clone()
}

/// Whether this process is the one running the app.
pub enum Instance {
    Primary,
    /// Another copy is running and has been handed the arguments.
    Forwarded,
}

/// Where the running copy listens: in the user's own runtime directory when
/// there is one (`XDG_RUNTIME_DIR` on Linux, the per-user `TMPDIR` on macOS),
/// whose permissions already keep other users out, else beside the app's data.
/// A socket path is limited to about a hundred bytes, so the name is a hash.
#[cfg(unix)]
fn socket_path(dir: &Path, app_id: &str) -> std::path::PathBuf {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    app_id.hash(&mut hasher);
    let runtime = ["XDG_RUNTIME_DIR", "TMPDIR"]
        .iter()
        .filter_map(|name| std::env::var_os(name))
        .map(std::path::PathBuf::from)
        .find(|path| path.is_dir());
    runtime.unwrap_or_else(|| dir.to_path_buf()).join(format!(
        "rngpui-{:012x}.sock",
        hasher.finish() & 0xffff_ffff_ffff
    ))
}

/// The pipe a Windows copy listens on. Pipe names are machine-wide, so the user
/// is part of the name and two users can each run the app.
#[cfg(windows)]
fn pipe_name(app_id: &str) -> String {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    app_id.hash(&mut hasher);
    let user: String = std::env::var("USERNAME")
        .unwrap_or_default()
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .collect();
    format!(
        r"\\.\pipe\rngpui-{user}-{:012x}",
        hasher.finish() & 0xffff_ffff_ffff
    )
}

#[cfg(unix)]
fn forward(dir: &Path, app_id: &str, args: &[String]) -> bool {
    let Ok(mut stream) = std::os::unix::net::UnixStream::connect(socket_path(dir, app_id)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    let message = json!({ "args": args }).to_string();
    if writeln!(stream, "{message}").is_err() {
        return false;
    }
    let mut reply = String::new();
    BufReader::new(stream).read_line(&mut reply).is_ok() && reply.trim() == "ok"
}

#[cfg(windows)]
fn forward(_dir: &Path, app_id: &str, args: &[String]) -> bool {
    let name = pipe_name(app_id);
    // Every instance of the pipe is busy while the running copy accepts another
    // client; the name only disappears with the process.
    const PIPE_BUSY: i32 = 231;
    let deadline = std::time::Instant::now() + Duration::from_secs(2);
    let file = loop {
        match std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(&name)
        {
            Ok(file) => break file,
            Err(error)
                if error.raw_os_error() == Some(PIPE_BUSY)
                    && std::time::Instant::now() < deadline =>
            {
                std::thread::sleep(Duration::from_millis(20));
            }
            Err(_) => return false,
        }
    };
    let message = json!({ "args": args }).to_string();
    let (sender, receiver) = std::sync::mpsc::channel();
    let spawned = std::thread::Builder::new()
        .name("single-instance-client".into())
        .spawn(move || {
            let mut file = file;
            let mut reply = String::new();
            let sent = writeln!(file, "{message}").is_ok()
                && BufReader::new(file).read_line(&mut reply).is_ok();
            let _ = sender.send(sent && reply.trim() == "ok");
        });
    spawned.is_ok()
        && receiver
            .recv_timeout(Duration::from_secs(2))
            .unwrap_or(false)
}

/// Becomes the running instance, or hands `args` to the one that is.
///
/// The first process listens on a Unix socket in the user's runtime directory,
/// which only that user can reach. On Windows it listens on a named pipe whose
/// access list names only the user, and which refuses remote clients. A later
/// launch connects, sends its arguments and exits. A socket whose process is
/// gone fails to connect, and the new process takes over; a pipe goes away with
/// its process.
#[cfg(unix)]
pub fn acquire(
    dir: &Path,
    app_id: &str,
    args: &[String],
    on_args: impl Fn(Vec<String>) + Send + 'static,
) -> Instance {
    use std::os::unix::fs::PermissionsExt;
    if forward(dir, app_id, args) {
        return Instance::Forwarded;
    }
    let path = socket_path(dir, app_id);
    if std::fs::create_dir_all(dir).is_err() {
        return Instance::Primary;
    }
    let _ = std::fs::remove_file(&path);
    let Ok(listener) = std::os::unix::net::UnixListener::bind(&path) else {
        return Instance::Primary;
    };
    let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    let spawned = std::thread::Builder::new()
        .name("single-instance".into())
        .spawn(move || {
            for stream in listener.incoming().flatten() {
                let _ = stream.set_read_timeout(Some(Duration::from_secs(1)));
                serve(&stream, &stream, &on_args);
            }
        });
    if let Err(error) = spawned {
        log::warn!("single instance listener not started: {error}");
    }
    Instance::Primary
}

#[cfg(windows)]
pub fn acquire(
    dir: &Path,
    app_id: &str,
    args: &[String],
    on_args: impl Fn(Vec<String>) + Send + 'static,
) -> Instance {
    if forward(dir, app_id, args) {
        return Instance::Forwarded;
    }
    let name = pipe_name(app_id);
    let Some(first) = pipe::create(&name, true) else {
        return Instance::Primary;
    };
    let on_args = std::sync::Arc::new(Mutex::new(on_args));
    let spawned = std::thread::Builder::new()
        .name("single-instance".into())
        .spawn(move || {
            let mut current = first;
            loop {
                pipe::connect(&current);
                // The next instance exists before this client is served, so a
                // launch arriving meanwhile finds the pipe busy, not missing.
                let Some(next) = pipe::create(&name, false) else {
                    return;
                };
                let served = std::mem::replace(&mut current, next);
                let on_args = on_args.clone();
                let _ = std::thread::Builder::new()
                    .name("single-instance-client".into())
                    .spawn(move || {
                        serve(&served, &served, &|args| {
                            (on_args.lock().expect("single instance callback poisoned"))(args)
                        });
                    });
            }
        });
    if let Err(error) = spawned {
        log::warn!("single instance listener not started: {error}");
    }
    Instance::Primary
}

#[cfg(windows)]
mod pipe {
    use std::io::{Read, Write};
    use std::os::windows::io::{FromRawHandle, OwnedHandle};
    use windows_sys::Win32::{
        Foundation::{LocalFree, INVALID_HANDLE_VALUE},
        Security::{
            Authorization::{
                ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
            },
            SECURITY_ATTRIBUTES,
        },
        Storage::FileSystem::{
            FlushFileBuffers, ReadFile, WriteFile, FILE_FLAG_FIRST_PIPE_INSTANCE,
            PIPE_ACCESS_DUPLEX,
        },
        System::Pipes::{
            ConnectNamedPipe, CreateNamedPipeW, DisconnectNamedPipe, PIPE_READMODE_BYTE,
            PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_BYTE, PIPE_UNLIMITED_INSTANCES, PIPE_WAIT,
        },
    };

    /// Owner rights only: the pipe's default access list also lets other users
    /// read it.
    const OWNER_ONLY: &str = "D:P(A;;GA;;;OW)";

    /// One server-side instance of the pipe.
    pub struct Instance(OwnedHandle);

    pub fn create(name: &str, first: bool) -> Option<Instance> {
        use std::os::windows::ffi::OsStrExt;
        let wide = |text: &str| -> Vec<u16> {
            std::ffi::OsStr::new(text)
                .encode_wide()
                .chain(Some(0))
                .collect()
        };
        let mut descriptor = std::ptr::null_mut();
        // SAFETY: both strings are NUL-terminated and `descriptor` receives a
        // LocalAlloc'd block that is freed below.
        let converted = unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                wide(OWNER_ONLY).as_ptr(),
                SDDL_REVISION_1,
                &mut descriptor,
                std::ptr::null_mut(),
            )
        };
        if converted == 0 {
            return None;
        }
        let attributes = SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: descriptor,
            bInheritHandle: 0,
        };
        let open_mode = PIPE_ACCESS_DUPLEX
            | if first {
                FILE_FLAG_FIRST_PIPE_INSTANCE
            } else {
                0
            };
        // SAFETY: `wide` is NUL-terminated and `attributes` outlives the call.
        let handle = unsafe {
            CreateNamedPipeW(
                wide(name).as_ptr(),
                open_mode,
                PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
                PIPE_UNLIMITED_INSTANCES,
                4096,
                4096,
                0,
                &attributes,
            )
        };
        // SAFETY: allocated by the conversion above and not used again.
        unsafe { LocalFree(descriptor) };
        if handle == INVALID_HANDLE_VALUE {
            return None;
        }
        // SAFETY: a valid handle this function owns.
        Some(Instance(unsafe {
            OwnedHandle::from_raw_handle(handle as _)
        }))
    }

    /// Blocks until a client has connected.
    pub fn connect(instance: &Instance) {
        use std::os::windows::io::AsRawHandle;
        // SAFETY: the handle is a pipe instance owned by `instance`. A client that
        // connected before this call makes it fail with ERROR_PIPE_CONNECTED,
        // which also means the pipe is ready.
        unsafe { ConnectNamedPipe(instance.0.as_raw_handle() as _, std::ptr::null_mut()) };
    }

    impl Read for &Instance {
        fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
            use std::os::windows::io::AsRawHandle;
            let mut read = 0u32;
            // SAFETY: `buffer` is valid for its length and the handle is open.
            let ok = unsafe {
                ReadFile(
                    self.0.as_raw_handle() as _,
                    buffer.as_mut_ptr(),
                    buffer.len().min(u32::MAX as usize) as u32,
                    &mut read,
                    std::ptr::null_mut(),
                )
            };
            if ok == 0 {
                // A client that closed its end reads as end of file.
                return Ok(0);
            }
            Ok(read as usize)
        }
    }

    impl Write for &Instance {
        fn write(&mut self, buffer: &[u8]) -> std::io::Result<usize> {
            use std::os::windows::io::AsRawHandle;
            let mut written = 0u32;
            // SAFETY: `buffer` is valid for its length and the handle is open.
            let ok = unsafe {
                WriteFile(
                    self.0.as_raw_handle() as _,
                    buffer.as_ptr(),
                    buffer.len().min(u32::MAX as usize) as u32,
                    &mut written,
                    std::ptr::null_mut(),
                )
            };
            if ok == 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(written as usize)
        }

        fn flush(&mut self) -> std::io::Result<()> {
            use std::os::windows::io::AsRawHandle;
            // SAFETY: the handle is open.
            unsafe { FlushFileBuffers(self.0.as_raw_handle() as _) };
            Ok(())
        }
    }

    impl Drop for Instance {
        fn drop(&mut self) {
            use std::os::windows::io::AsRawHandle;
            // SAFETY: the handle is still open. Disconnecting discards what the
            // client has not read, so the reply is flushed to it first.
            unsafe {
                FlushFileBuffers(self.0.as_raw_handle() as _);
                DisconnectNamedPipe(self.0.as_raw_handle() as _);
            }
        }
    }
}

fn serve(reader: impl Read, mut writer: impl Write, on_args: &impl Fn(Vec<String>)) {
    let mut line = String::new();
    let mut reader = BufReader::new(reader).take(64 * 1024);
    if reader.read_line(&mut line).is_err() {
        return;
    }
    let Ok(message) = serde_json::from_str::<serde_json::Value>(&line) else {
        return;
    };
    let args = message
        .get("args")
        .and_then(serde_json::Value::as_array)
        .map(|args| {
            args.iter()
                .filter_map(|arg| arg.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    on_args(args);
    let _ = writeln!(writer, "ok");
}

use std::io::Read;

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    fn schemes() -> Vec<String> {
        vec!["myapp".to_string()]
    }

    #[test]
    fn the_url_among_the_arguments_is_found_by_scheme() {
        let args = ["app", "--flag", "MYAPP://open/1", "other://x"];
        assert_eq!(
            url_in_args(args, &schemes()).as_deref(),
            Some("MYAPP://open/1")
        );
        assert_eq!(url_in_args(["app", "https://x"], &schemes()), None);
    }

    #[test]
    fn a_second_launch_hands_its_arguments_to_the_first() {
        let dir = std::env::temp_dir().join(format!("rngpui-instance-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let (sender, receiver) = mpsc::channel();
        let sender = Mutex::new(sender);
        let first = acquire(&dir, "com.example.test", &[], move |args| {
            let _ = sender.lock().unwrap().send(args);
        });
        assert!(matches!(first, Instance::Primary));
        let second = acquire(
            &dir,
            "com.example.test",
            &["app".to_string(), "myapp://hello".to_string()],
            |_| panic!("the second launch must not become primary"),
        );
        assert!(matches!(second, Instance::Forwarded));
        let received = receiver.recv_timeout(Duration::from_secs(2)).unwrap();
        assert_eq!(
            url_in_args(&received, &schemes()).as_deref(),
            Some("myapp://hello")
        );
        #[cfg(unix)]
        let _ = std::fs::remove_file(socket_path(&dir, "com.example.test"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn a_stale_socket_is_taken_over() {
        let dir = std::env::temp_dir().join(format!("rngpui-stale-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        // A socket file nothing listens on is what a crashed copy leaves behind.
        let path = socket_path(&dir, "com.example.stale");
        let _ = std::fs::remove_file(&path);
        drop(std::os::unix::net::UnixListener::bind(&path).unwrap());
        let instance = acquire(&dir, "com.example.stale", &[], |_| {});
        assert!(matches!(instance, Instance::Primary));
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn the_socket_is_reachable_only_by_its_owner() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("rngpui-mode-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        acquire(&dir, "com.example.mode", &[], |_| {});
        let mode = std::fs::metadata(socket_path(&dir, "com.example.mode"))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o077, 0);
        let _ = std::fs::remove_file(socket_path(&dir, "com.example.mode"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(windows)]
    #[test]
    fn simultaneous_launches_are_all_delivered() {
        let dir = std::env::temp_dir();
        let (sender, receiver) = mpsc::channel();
        let sender = Mutex::new(sender);
        let first = acquire(&dir, "com.example.parallel", &[], move |args| {
            let _ = sender.lock().unwrap().send(args);
        });
        assert!(matches!(first, Instance::Primary));
        let launches: Vec<_> = (0..8)
            .map(|index| {
                let dir = dir.clone();
                std::thread::spawn(move || {
                    acquire(
                        &dir,
                        "com.example.parallel",
                        &[format!("myapp://{index}")],
                        |_| panic!("a later launch must not become primary"),
                    )
                })
            })
            .collect();
        for launch in launches {
            assert!(matches!(launch.join().unwrap(), Instance::Forwarded));
        }
        let mut seen: Vec<String> = (0..8)
            .map(|_| {
                receiver
                    .recv_timeout(Duration::from_secs(5))
                    .unwrap()
                    .remove(0)
            })
            .collect();
        seen.sort();
        let mut expected: Vec<String> = (0..8).map(|index| format!("myapp://{index}")).collect();
        expected.sort();
        assert_eq!(seen, expected);
    }

    #[cfg(windows)]
    #[test]
    fn a_second_first_instance_of_a_live_pipe_is_refused() {
        let name = pipe_name("com.example.access");
        assert!(name.starts_with(r"\\.\pipe\rngpui-"));
        let first = pipe::create(&name, true);
        assert!(first.is_some());
        // A second "first" instance of a live pipe is refused.
        assert!(pipe::create(&name, true).is_none());
    }
}
