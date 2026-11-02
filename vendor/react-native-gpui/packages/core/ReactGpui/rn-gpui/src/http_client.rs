//! GPUI's HTTP client, backed by React Native's C++ client.
//!
//! There used to be two complete stacks: curl and OpenSSL for React Native's
//! `fetch`, `XHR` and `WebSocket`, and a Rust one (reqwest, hyper, tokio, rustls,
//! ring) for the three places GPUI itself loads a URL — `img(url)`, remote fonts,
//! and remote vector images. Only the second was ours to remove, and it was most
//! of the binary's TLS code twice over.
//!
//! A request is issued through the cxx bridge, which runs it on the C++ client's
//! own thread and calls [`complete`] with the whole response. That is the shape
//! GPUI wants: its trait returns a future, resolved once.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};

use futures::channel::oneshot;
use http_client::http::{HeaderValue, StatusCode};
use http_client::Url;
use http_client::{http, AsyncBody, HttpClient, Response};

/// The response a request resolved with.
struct Completed {
    status: u16,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
    error: String,
}

/// Requests waiting for their response, keyed by the id the bridge echoes back.
fn pending() -> &'static Mutex<HashMap<u64, oneshot::Sender<Completed>>> {
    static PENDING: OnceLock<Mutex<HashMap<u64, oneshot::Sender<Completed>>>> = OnceLock::new();
    PENDING.get_or_init(|| Mutex::new(HashMap::new()))
}

fn next_request_id() -> u64 {
    static NEXT: AtomicU64 = AtomicU64::new(1);
    NEXT.fetch_add(1, Ordering::Relaxed)
}

/// Delivers a finished request to the future waiting for it.
///
/// Registered once, in [`install`]: the C++ bridge calls into `rn-gpui-sys`,
/// which forwards here. A handler rather than a plain function because the crate
/// that owns the futures is the one above the bridge.
fn complete(request_id: u64, status: i32, headers: String, body: Vec<u8>, error: String) {
    let Some(sender) = pending()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(&request_id)
    else {
        return;
    };
    let completed = Completed {
        status: u16::try_from(status).unwrap_or(0),
        headers: headers
            .lines()
            .filter_map(|line| {
                let (name, value) = line.split_once(':')?;
                Some((name.trim().to_string(), value.trim().to_string()))
            })
            .collect(),
        body,
        error,
    };
    // The receiver is gone only if the future was dropped, which is not an error.
    let _ = sender.send(completed);
}

/// Registers the completion handler. Called once, before the app starts.
pub fn install() {
    let _ = rn_gpui_sys::HTTP_COMPLETE_HANDLER.set(Box::new(complete));
}

/// GPUI's [`HttpClient`], implemented over React Native's client.
#[derive(Default)]
pub struct RnHttpClient;

impl RnHttpClient {
    pub fn new() -> Self {
        Self
    }
}

impl HttpClient for RnHttpClient {
    fn user_agent(&self) -> Option<&HeaderValue> {
        None
    }

    fn proxy(&self) -> Option<&Url> {
        None
    }

    fn send(
        &self,
        request: http::Request<AsyncBody>,
    ) -> futures::future::BoxFuture<'static, anyhow::Result<Response<AsyncBody>>> {
        Box::pin(async move {
            let method = request.method().as_str().to_string();
            let uri = request.uri().to_string();
            let headers = request
                .headers()
                .iter()
                .map(|(name, value)| {
                    format!("{}: {}", name.as_str(), value.to_str().unwrap_or_default())
                })
                .collect::<Vec<_>>()
                .join("\n");

            // GPUI sends a body for POST; reading it here keeps the request
            // self-contained, because the future outlives the borrow.
            let mut body = Vec::new();
            {
                use futures::io::AsyncReadExt;
                let mut reader = request.into_body();
                reader.read_to_end(&mut body).await?;
            }
            let body = String::from_utf8_lossy(&body).into_owned();

            let (sender, receiver) = oneshot::channel();
            let request_id = next_request_id();
            pending()
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .insert(request_id, sender);

            rn_gpui_sys::ffi::rn_gpui_http_request(request_id, &method, &uri, &headers, &body);

            let completed = receiver
                .await
                .map_err(|_| anyhow::anyhow!("the HTTP request was dropped"))?;
            if !completed.error.is_empty() {
                anyhow::bail!("{uri}: {}", completed.error);
            }

            let mut builder = http::Response::builder()
                .status(StatusCode::from_u16(completed.status).unwrap_or_default());
            for (name, value) in completed.headers {
                builder = builder.header(name, value);
            }
            Ok(builder.body(AsyncBody::from_bytes(completed.body.into()))?)
        })
    }
}
