//! `AppState`'s `memoryWarning`: the OS saying memory is running low.

use crate::host::Host;

#[cfg(target_os = "macos")]
mod platform {
    use super::Host;
    use std::ffi::c_void;
    use std::sync::Mutex;

    static HOST: Mutex<Option<Host>> = Mutex::new(None);

    // DISPATCH_MEMORYPRESSURE_WARN | DISPATCH_MEMORYPRESSURE_CRITICAL
    const PRESSURE_MASK: usize = 0x2 | 0x4;

    extern "C" {
        static _dispatch_source_type_memorypressure: c_void;
        fn dispatch_source_create(
            source_type: *const c_void,
            handle: usize,
            mask: usize,
            queue: *mut c_void,
        ) -> *mut c_void;
        fn dispatch_source_set_event_handler_f(
            source: *mut c_void,
            handler: extern "C" fn(*mut c_void),
        );
        fn dispatch_get_global_queue(identifier: isize, flags: usize) -> *mut c_void;
        fn dispatch_resume(object: *mut c_void);
    }

    extern "C" fn on_pressure(_context: *mut c_void) {
        if let Some(host) = HOST.lock().expect("memory pressure host poisoned").as_ref() {
            host.emit_memory_warning();
        }
    }

    pub fn start(host: Host) {
        *HOST.lock().expect("memory pressure host poisoned") = Some(host);
        // SAFETY: the source is created once, keeps running for the life of the
        // process and is never released; the handler only reads `HOST`.
        unsafe {
            let queue = dispatch_get_global_queue(0, 0);
            let source = dispatch_source_create(
                &_dispatch_source_type_memorypressure,
                0,
                PRESSURE_MASK,
                queue,
            );
            if source.is_null() {
                log::warn!("memory pressure source unavailable");
                return;
            }
            dispatch_source_set_event_handler_f(source, on_pressure);
            dispatch_resume(source);
        }
    }
}

#[cfg(target_os = "linux")]
mod platform {
    use super::Host;
    use std::io::Write;
    use std::os::fd::AsRawFd;

    /// A stall of 150 ms within a 1 s window: the kernel's own definition of
    /// memory pressure worth telling an app about.
    const TRIGGER: &str = "some 150000 1000000\0";

    pub fn start(host: Host) {
        let spawned = std::thread::Builder::new()
            .name("memory-pressure".into())
            .spawn(move || {
                let Ok(mut file) = std::fs::OpenOptions::new()
                    .read(true)
                    .write(true)
                    .open("/proc/pressure/memory")
                else {
                    return;
                };
                if file.write_all(TRIGGER.as_bytes()).is_err() {
                    return;
                }
                loop {
                    let mut descriptor = libc::pollfd {
                        fd: file.as_raw_fd(),
                        events: libc::POLLPRI,
                        revents: 0,
                    };
                    // SAFETY: `descriptor` is one valid pollfd.
                    let ready = unsafe { libc::poll(&mut descriptor, 1, -1) };
                    if ready < 0 {
                        return;
                    }
                    if descriptor.revents & libc::POLLERR != 0 {
                        return;
                    }
                    if descriptor.revents & libc::POLLPRI != 0 {
                        host.emit_memory_warning();
                    }
                }
            });
        if let Err(error) = spawned {
            log::warn!("memory pressure monitor not started: {error}");
        }
    }
}

#[cfg(target_os = "windows")]
mod platform {
    use super::Host;
    use windows_sys::Win32::Foundation::{CloseHandle, WAIT_OBJECT_0};
    use windows_sys::Win32::System::Memory::{
        CreateMemoryResourceNotification, LowMemoryResourceNotification,
    };
    use windows_sys::Win32::System::Threading::WaitForSingleObject;

    pub fn start(host: Host) {
        let spawned = std::thread::Builder::new()
            .name("memory-pressure".into())
            .spawn(move || {
                // SAFETY: the handle is owned by this thread and closed on exit.
                let handle =
                    unsafe { CreateMemoryResourceNotification(LowMemoryResourceNotification) };
                if handle.is_null() {
                    return;
                }
                loop {
                    // SAFETY: `handle` is a valid notification object.
                    let result = unsafe { WaitForSingleObject(handle, u32::MAX) };
                    if result != WAIT_OBJECT_0 {
                        break;
                    }
                    host.emit_memory_warning();
                    // The object stays signalled while memory is low.
                    std::thread::sleep(std::time::Duration::from_secs(30));
                }
                // SAFETY: closes the handle opened above.
                unsafe { CloseHandle(handle) };
            });
        if let Err(error) = spawned {
            log::warn!("memory pressure monitor not started: {error}");
        }
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
mod platform {
    use super::Host;

    pub fn start(_host: Host) {}
}

/// Starts watching for memory pressure; each warning reaches JS as `memoryWarning`.
pub fn start(host: Host) {
    platform::start(host);
}
