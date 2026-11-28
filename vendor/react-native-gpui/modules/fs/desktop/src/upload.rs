//! `upload`: a file, or a range of one, streamed as an HTTP request body.
//!
//! The file is read in small blocks as the connection takes them, so the body is
//! never held in memory. The request runs on its own thread; the cancel flag is
//! checked on every block, which is what makes a cancel prompt while the
//! connection is busy.

use std::collections::HashMap;
use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use rn_gpui_module::ModuleError;
use ureq::config::Config;
use ureq::tls::{RootCerts, TlsConfig};
use ureq::{Agent, SendBody};

use crate::{
    errors, DownloadHeader, NativeFsEvents, RNFsModule, UploadOptions, UploadProgress,
    UploadResult,
};

const BLOCK: usize = 64 * 1024;
const PROGRESS_INTERVAL: Duration = Duration::from_millis(100);
const RESPONSE_BODY_LIMIT: u64 = 2048;

pub type Uploads = Mutex<HashMap<u32, Arc<AtomicBool>>>;

fn agent() -> &'static Agent {
    static AGENT: OnceLock<Agent> = OnceLock::new();
    AGENT.get_or_init(|| {
        let config = Config::builder()
            .http_status_as_error(false)
            .timeout_connect(Some(Duration::from_secs(30)))
            .tls_config(
                TlsConfig::builder()
                    .root_certs(RootCerts::PlatformVerifier)
                    .build(),
            )
            .build();
        Agent::new_with_config(config)
    })
}

fn aborted() -> ModuleError {
    ModuleError::with_code("ABORT_ERR", "The upload was aborted")
}

fn failed(message: impl Into<String>) -> ModuleError {
    ModuleError::with_code("ERR_UPLOAD", message.into())
}

fn id_of(value: f64) -> u32 {
    value as u32
}

pub fn cancel(module: &RNFsModule, id: f64) -> bool {
    match module.uploads.lock().expect("uploads").get(&id_of(id)) {
        Some(stop) => {
            stop.store(true, Ordering::SeqCst);
            true
        }
        None => false,
    }
}

struct Body {
    file: File,
    remaining: u64,
    sent: u64,
    total: u64,
    id: u32,
    events: NativeFsEvents,
    stop: Arc<AtomicBool>,
    last_progress: Instant,
}

impl Body {
    fn emit(&self) {
        self.events.on_upload_progress(UploadProgress {
            id: f64::from(self.id),
            sent: self.sent as f64,
            total: self.total as f64,
        });
    }
}

impl Read for Body {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        if self.stop.load(Ordering::SeqCst) {
            return Err(io::Error::new(io::ErrorKind::Other, "aborted"));
        }
        if self.remaining == 0 {
            return Ok(0);
        }
        let wanted = buffer.len().min(BLOCK).min(self.remaining as usize);
        let read = self.file.read(&mut buffer[..wanted])?;
        if read == 0 {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "the file is shorter than the requested range",
            ));
        }
        self.remaining -= read as u64;
        self.sent += read as u64;
        if self.last_progress.elapsed() >= PROGRESS_INTERVAL || self.remaining == 0 {
            self.last_progress = Instant::now();
            self.emit();
        }
        Ok(read)
    }
}

fn run(
    events: NativeFsEvents,
    id: u32,
    url: String,
    path: PathBuf,
    options: UploadOptions,
    stop: Arc<AtomicBool>,
) -> Result<UploadResult, ModuleError> {
    let shown = path.display().to_string();
    let mut file = File::open(&path).map_err(|e| errors::from_io(e, &shown))?;
    let size = file
        .metadata()
        .map_err(|e| errors::from_io(e, &shown))?
        .len();
    let offset = if options.offset > 0.0 {
        options.offset as u64
    } else {
        0
    };
    if offset > size {
        return Err(failed("the offset is past the end of the file"));
    }
    let length = if options.length < 0.0 {
        size - offset
    } else {
        options.length as u64
    };
    if offset + length > size {
        return Err(failed("the range is past the end of the file"));
    }
    file.seek(SeekFrom::Start(offset))
        .map_err(|e| errors::from_io(e, &shown))?;

    let method = if options.method.is_empty() {
        "PUT".to_string()
    } else {
        options.method.clone()
    };
    let mut builder = ureq::http::Request::builder().method(method.as_str()).uri(&url);
    let mut has_length = false;
    for header in &options.headers {
        if header.name.eq_ignore_ascii_case("content-length") {
            has_length = true;
        }
        builder = builder.header(header.name.as_str(), header.value.as_str());
    }
    if !has_length {
        builder = builder.header("content-length", length.to_string());
    }

    let mut body = Body {
        file,
        remaining: length,
        sent: 0,
        total: length,
        id,
        events,
        stop: stop.clone(),
        last_progress: Instant::now() - PROGRESS_INTERVAL,
    };
    body.emit();
    let request = builder
        .body(SendBody::from_reader(&mut body))
        .map_err(|e| failed(e.to_string()))?;
    let outcome = agent().run(request);
    if stop.load(Ordering::SeqCst) {
        return Err(aborted());
    }
    let mut response = outcome.map_err(|e| failed(e.to_string()))?;
    let status = response.status().as_u16();
    let mut headers: Vec<DownloadHeader> = Vec::new();
    for (name, value) in response.headers() {
        let value = String::from_utf8_lossy(value.as_bytes()).into_owned();
        match headers.iter_mut().find(|h| h.name == name.as_str()) {
            Some(existing) => {
                existing.value.push_str(", ");
                existing.value.push_str(&value);
            }
            None => headers.push(DownloadHeader {
                name: name.as_str().to_string(),
                value,
            }),
        }
    }
    let mut text = Vec::new();
    let _ = response
        .body_mut()
        .as_reader()
        .take(RESPONSE_BODY_LIMIT)
        .read_to_end(&mut text);
    Ok(UploadResult {
        status: f64::from(status),
        headers,
        body: String::from_utf8_lossy(&text).into_owned(),
    })
}

pub async fn upload(
    module: &RNFsModule,
    url: String,
    path: String,
    options: UploadOptions,
) -> Result<UploadResult, ModuleError> {
    let id = id_of(options.id);
    let stop = Arc::new(AtomicBool::new(false));
    {
        let mut running = module.uploads.lock().expect("uploads");
        if running.contains_key(&id) {
            return Err(failed(format!("upload {id} is already running")));
        }
        running.insert(id, stop.clone());
    }
    let (sender, receiver) = futures::channel::oneshot::channel();
    let events = module.events.clone();
    std::thread::spawn(move || {
        let _ = sender.send(run(events, id, url, PathBuf::from(path), options, stop));
    });
    let result = receiver.await;
    module.uploads.lock().expect("uploads").remove(&id);
    result.unwrap_or_else(|_| Err(failed("the upload stopped unexpectedly")))
}
