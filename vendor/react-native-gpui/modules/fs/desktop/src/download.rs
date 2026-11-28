//! `download`: an HTTP body streamed to a file.
//!
//! A transfer is two threads. The network thread makes the request and reads the
//! body in chunks; the coordinator receives them, writes `<path>.part` and renames
//! it onto `path` when the body is complete. Splitting them is what makes a cancel
//! prompt: the coordinator polls the cancel flag between messages, so it does not
//! wait on a socket that has gone quiet, and the network thread simply stops the
//! next time it tries to hand over a chunk.
//!
//! The module's own thread is only waited on through a channel, so a slow download
//! never blocks other file calls.

use std::collections::HashMap;
use std::fs::File;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError, SyncSender};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use rn_gpui_module::ModuleError;
use ureq::config::Config;
use ureq::tls::{RootCerts, TlsConfig};
use ureq::Agent;

use crate::{
    errors, DownloadHeader, DownloadOptions, DownloadProgress, DownloadResult, RNFsModule,
};

const CHUNK: usize = 64 * 1024;
const PROGRESS_INTERVAL: Duration = Duration::from_millis(100);
const POLL: Duration = Duration::from_millis(25);
/// How much of a failed response's body is kept for the error.
const ERROR_BODY_LIMIT: u64 = 2048;

pub type Downloads = Mutex<HashMap<u32, Arc<AtomicBool>>>;

enum Message {
    Head {
        status: u16,
        headers: Vec<DownloadHeader>,
        total: Option<u64>,
    },
    Rejected {
        status: u16,
        headers: Vec<DownloadHeader>,
        body: String,
    },
    Chunk(Vec<u8>),
    End,
    Failed(String),
}

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
    ModuleError::with_code("ABORT_ERR", "The download was aborted")
}

fn failed(message: impl Into<String>) -> ModuleError {
    ModuleError::with_code("ERR_DOWNLOAD", message.into())
}

fn id_of(value: f64) -> u32 {
    value as u32
}

pub fn cancel(module: &RNFsModule, id: f64) -> bool {
    match module.downloads.lock().expect("downloads").get(&id_of(id)) {
        Some(stop) => {
            stop.store(true, Ordering::SeqCst);
            true
        }
        None => false,
    }
}

fn fetch(
    url: &str,
    method: &str,
    headers: &[DownloadHeader],
    sender: &SyncSender<Message>,
    stop: &AtomicBool,
) {
    let result = (|| -> Result<(), String> {
        let mut builder = ureq::http::Request::builder().method(method).uri(url);
        for header in headers {
            builder = builder.header(header.name.as_str(), header.value.as_str());
        }
        let request = builder.body(()).map_err(|e| e.to_string())?;
        let mut response = agent().run(request).map_err(|e| e.to_string())?;
        let status = response.status().as_u16();
        let mut listed: Vec<DownloadHeader> = Vec::new();
        for (name, value) in response.headers() {
            let value = String::from_utf8_lossy(value.as_bytes()).into_owned();
            match listed.iter_mut().find(|h| h.name == name.as_str()) {
                Some(existing) => {
                    existing.value.push_str(", ");
                    existing.value.push_str(&value);
                }
                None => listed.push(DownloadHeader {
                    name: name.as_str().to_string(),
                    value,
                }),
            }
        }
        let total = response
            .headers()
            .get("content-length")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse::<u64>().ok());
        let mut reader = response.body_mut().as_reader();
        if !(200..300).contains(&status) {
            let mut body = Vec::new();
            let _ = reader
                .by_ref()
                .take(ERROR_BODY_LIMIT)
                .read_to_end(&mut body);
            let _ = sender.send(Message::Rejected {
                status,
                headers: listed,
                body: String::from_utf8_lossy(&body).into_owned(),
            });
            return Ok(());
        }
        if sender
            .send(Message::Head {
                status,
                headers: listed,
                total,
            })
            .is_err()
        {
            return Ok(());
        }
        loop {
            if stop.load(Ordering::SeqCst) {
                return Ok(());
            }
            let mut chunk = vec![0u8; CHUNK];
            let read = reader.read(&mut chunk).map_err(|e| e.to_string())?;
            if read == 0 {
                let _ = sender.send(Message::End);
                return Ok(());
            }
            chunk.truncate(read);
            if sender.send(Message::Chunk(chunk)).is_err() {
                return Ok(());
            }
        }
    })();
    if let Err(message) = result {
        let _ = sender.send(Message::Failed(message));
    }
}

fn transfer(
    module_events: &crate::NativeFsEvents,
    id: u32,
    url: String,
    dest: PathBuf,
    method: String,
    headers: Vec<DownloadHeader>,
    stop: Arc<AtomicBool>,
) -> Result<DownloadResult, ModuleError> {
    let mut partial = dest.clone().into_os_string();
    partial.push(".part");
    let partial = PathBuf::from(partial);
    let shown = dest.display().to_string();

    let (sender, receiver) = mpsc::sync_channel::<Message>(8);
    {
        let stop = stop.clone();
        std::thread::spawn(move || fetch(&url, &method, &headers, &sender, &stop));
    }

    let mut file: Option<File> = None;
    let mut head: Option<(u16, Vec<DownloadHeader>, Option<u64>)> = None;
    let mut received: u64 = 0;
    let mut last_progress = Instant::now() - PROGRESS_INTERVAL;
    let emit = |received: u64, total: Option<u64>| {
        module_events.on_download_progress(DownloadProgress {
            id: f64::from(id),
            received: received as f64,
            total: total.map_or(-1.0, |t| t as f64),
        });
    };

    let outcome: Result<DownloadResult, ModuleError> = loop {
        if stop.load(Ordering::SeqCst) {
            break Err(aborted());
        }
        let message = match receiver.recv_timeout(POLL) {
            Ok(message) => message,
            Err(RecvTimeoutError::Timeout) => continue,
            Err(RecvTimeoutError::Disconnected) => break Err(failed("the connection closed")),
        };
        match message {
            Message::Rejected {
                status,
                headers,
                body,
            } => {
                break Ok(DownloadResult {
                    status: f64::from(status),
                    headers,
                    bytes: 0.0,
                    body: Some(body),
                });
            }
            Message::Head {
                status,
                headers,
                total,
            } => {
                match File::create(&partial) {
                    Ok(created) => file = Some(created),
                    Err(e) => break Err(errors::from_io(e, &shown)),
                }
                head = Some((status, headers, total));
                emit(0, total);
            }
            Message::Chunk(bytes) => {
                let Some(target) = file.as_mut() else {
                    break Err(failed("data arrived before the response"));
                };
                if let Err(e) = target.write_all(&bytes) {
                    break Err(errors::from_io(e, &shown));
                }
                received += bytes.len() as u64;
                if last_progress.elapsed() >= PROGRESS_INTERVAL {
                    last_progress = Instant::now();
                    emit(received, head.as_ref().and_then(|h| h.2));
                }
            }
            Message::End => {
                let Some((status, headers, total)) = head.take() else {
                    break Err(failed("the response had no head"));
                };
                if let Some(expected) = total {
                    if received != expected {
                        break Err(failed(format!(
                            "the connection closed after {received} of {expected} bytes"
                        )));
                    }
                }
                if let Some(mut target) = file.take() {
                    if let Err(e) = target.flush() {
                        break Err(errors::from_io(e, &shown));
                    }
                }
                if let Err(e) = std::fs::rename(&partial, &dest) {
                    break Err(errors::from_io(e, &shown));
                }
                emit(received, total);
                break Ok(DownloadResult {
                    status: f64::from(status),
                    headers,
                    bytes: received as f64,
                    body: None,
                });
            }
            Message::Failed(message) => break Err(failed(message)),
        }
    };

    drop(receiver);
    drop(file);
    let kept = matches!(&outcome, Ok(result) if result.body.is_none());
    if !kept {
        let _ = std::fs::remove_file(&partial);
    }
    outcome
}

pub async fn download(
    module: &RNFsModule,
    url: String,
    path: String,
    options: DownloadOptions,
) -> Result<DownloadResult, ModuleError> {
    let id = id_of(options.id);
    let stop = Arc::new(AtomicBool::new(false));
    {
        let mut running = module.downloads.lock().expect("downloads");
        if running.contains_key(&id) {
            return Err(failed(format!("download {id} is already running")));
        }
        running.insert(id, stop.clone());
    }
    let (sender, receiver) = futures::channel::oneshot::channel();
    let events = module.events.clone();
    let method = if options.method.is_empty() {
        "GET".to_string()
    } else {
        options.method
    };
    let flag = stop.clone();
    std::thread::spawn(move || {
        let result = transfer(
            &events,
            id,
            url,
            PathBuf::from(path),
            method,
            options.headers,
            flag,
        );
        let _ = sender.send(result);
    });
    let result = receiver.await;
    module.downloads.lock().expect("downloads").remove(&id);
    result.unwrap_or_else(|_| Err(failed("the download stopped unexpectedly")))
}
