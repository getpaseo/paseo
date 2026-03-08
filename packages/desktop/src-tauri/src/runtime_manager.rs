use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use futures_util::{SinkExt, StreamExt};
use http::Request;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::env;
use std::fs;
use std::io;
use std::iter;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message;

const LOCAL_TRANSPORT_EVENT_NAME: &str = "local-daemon-transport-event";
const MANAGED_STATE_FILE: &str = "managed-state.json";
const DEFAULT_MANAGED_HOME_BASENAME: &str = ".paseo";
const DEFAULT_MANAGED_HOME_DIRNAME: &str = "managed-home";
#[cfg(not(windows))]
const SHORT_SOCKET_FILENAME: &str = "paseo.sock";
const UNIX_CLIENT_URL: &str = "ws://localhost/ws";
#[cfg(windows)]
const PIPE_CLIENT_URL: &str = "ws://localhost/ws";
#[cfg(windows)]
const PIPE_PREFIX: &str = r"\\.\pipe\";
const DEFAULT_MANAGED_TCP_HOST: &str = "127.0.0.1";
const DEFAULT_MANAGED_TCP_PORT: u16 = 7771;
const CLI_SHIM_NAME: &str = "paseo";
#[cfg(windows)]
const CLI_SHIM_WINDOWS_NAME: &str = "paseo.cmd";
const CLI_INNER_DIR: &str = "bin";
const CLI_INNER_UNIX_NAME: &str = "paseo-managed";
#[cfg(windows)]
const CLI_INNER_WINDOWS_NAME: &str = "paseo-managed.cmd";

static RUNTIME_INSTALL_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedRuntimeManifest {
    pub runtime_id: String,
    pub runtime_version: String,
    pub platform: String,
    pub arch: String,
    pub created_at: String,
    pub node_relative_path: String,
    pub cli_entrypoint_relative_path: String,
    pub cli_shim_relative_path: String,
    pub server_runner_relative_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BundledRuntimePointer {
    runtime_id: String,
    runtime_version: String,
    relative_root: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManagedStateFile {
    runtime_id: String,
    runtime_root: String,
    managed_home: String,
    transport_type: String,
    transport_path: String,
    tcp_enabled: bool,
    tcp_listen: Option<String>,
    cli_shim_path: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PidFile {
    pid: Option<i64>,
    hostname: Option<String>,
}

#[derive(Debug, Clone)]
struct ManagedPaths {
    runtime_root: PathBuf,
    stable_runtime_root: PathBuf,
    managed_home: PathBuf,
    transport_path: PathBuf,
    logs_path: PathBuf,
    state_file_path: PathBuf,
    diagnostics_root: PathBuf,
}

#[derive(Debug, Clone)]
struct ManagedTransportTarget {
    transport_type: String,
    transport_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedTcpSettings {
    pub enabled: bool,
    pub host: String,
    pub port: u16,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedRuntimeStatus {
    pub runtime_id: String,
    pub runtime_version: String,
    pub bundled_runtime_root: String,
    pub installed_runtime_root: String,
    pub installed: bool,
    pub managed_home: String,
    pub transport_type: String,
    pub transport_path: String,
    pub diagnostics_root: String,
    pub state_file_path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedDaemonStatus {
    pub runtime_id: String,
    pub runtime_version: String,
    pub runtime_root: String,
    pub managed_home: String,
    pub transport_type: String,
    pub transport_path: String,
    pub daemon_pid: Option<i64>,
    pub daemon_running: bool,
    pub daemon_status: String,
    pub log_path: String,
    pub server_id: Option<String>,
    pub hostname: Option<String>,
    pub relay_enabled: bool,
    pub tcp_enabled: bool,
    pub tcp_listen: Option<String>,
    pub cli_shim_path: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedDaemonLogs {
    pub log_path: String,
    pub contents: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedPairingOffer {
    pub relay_enabled: bool,
    pub url: Option<String>,
    pub qr: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliShimResult {
    pub status: String,
    pub installed: bool,
    pub path: Option<String>,
    pub message: String,
    pub manual_instructions: Option<CliManualInstructions>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliManualInstructions {
    pub title: String,
    pub detail: String,
    pub commands: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalTransportEvent {
    session_id: String,
    kind: String,
    text: Option<String>,
    binary_base64: Option<String>,
    code: Option<u16>,
    reason: Option<String>,
    error: Option<String>,
}

struct LocalTransportSession {
    sender: mpsc::UnboundedSender<Message>,
}

pub struct LocalTransportState {
    next_session_id: AtomicU64,
    sessions: Arc<Mutex<HashMap<String, LocalTransportSession>>>,
}

impl Default for LocalTransportState {
    fn default() -> Self {
        Self {
            next_session_id: AtomicU64::new(1),
            sessions: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

impl LocalTransportState {
    fn alloc_session_id(&self) -> String {
        format!(
            "local-session-{}",
            self.next_session_id.fetch_add(1, Ordering::Relaxed)
        )
    }
}

#[cfg(unix)]
fn build_local_websocket_request(
    url: &str,
) -> Result<Request<()>, tokio_tungstenite::tungstenite::Error> {
    url.into_client_request()
}

#[cfg(windows)]
fn build_local_websocket_request(
    url: &str,
) -> Result<Request<()>, tokio_tungstenite::tungstenite::Error> {
    url.into_client_request()
}

#[cfg(all(test, unix))]
fn local_client_url() -> &'static str {
    UNIX_CLIENT_URL
}

#[cfg(all(test, windows))]
fn local_client_url() -> &'static str {
    PIPE_CLIENT_URL
}

#[cfg(unix)]
async fn connect_local_socket(
    socket_path: PathBuf,
) -> Result<
    tokio_tungstenite::WebSocketStream<tokio::net::UnixStream>,
    tokio_tungstenite::tungstenite::Error,
> {
    let stream = tokio::net::UnixStream::connect(socket_path)
        .await
        .map_err(tokio_tungstenite::tungstenite::Error::Io)?;
    let request = build_local_websocket_request(UNIX_CLIENT_URL)?;
    let (ws_stream, _) = tokio_tungstenite::client_async(request, stream).await?;
    Ok(ws_stream)
}

#[cfg(windows)]
async fn connect_local_pipe(
    pipe_path: String,
) -> Result<
    tokio_tungstenite::WebSocketStream<tokio::net::windows::named_pipe::NamedPipeClient>,
    tokio_tungstenite::tungstenite::Error,
> {
    let stream = tokio::net::windows::named_pipe::ClientOptions::new()
        .open(&pipe_path)
        .map_err(tokio_tungstenite::tungstenite::Error::Io)?;
    let request = build_local_websocket_request(PIPE_CLIENT_URL)?;
    let (ws_stream, _) = tokio_tungstenite::client_async(request, stream).await?;
    Ok(ws_stream)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manual_http_request_lacks_websocket_handshake_headers() {
        let request = Request::builder()
            .uri(local_client_url())
            .header("Host", "localhost")
            .body(())
            .expect("valid manual request");

        assert!(request.headers().get("sec-websocket-key").is_none());
        assert!(request.headers().get("sec-websocket-version").is_none());
        assert!(request.headers().get("upgrade").is_none());
        assert!(request.headers().get("connection").is_none());
    }

    #[test]
    fn generated_local_websocket_request_includes_required_headers() {
        let request = build_local_websocket_request(local_client_url())
            .expect("local websocket request should be generated");

        assert_eq!(request.uri().to_string(), local_client_url());
        assert_eq!(
            request
                .headers()
                .get("host")
                .and_then(|value| value.to_str().ok()),
            Some("localhost")
        );
        assert!(request.headers().contains_key("sec-websocket-key"));
        assert_eq!(
            request
                .headers()
                .get("sec-websocket-version")
                .and_then(|value| value.to_str().ok()),
            Some("13")
        );
        assert_eq!(
            request
                .headers()
                .get("upgrade")
                .and_then(|value| value.to_str().ok()),
            Some("websocket")
        );
        assert_eq!(
            request
                .headers()
                .get("connection")
                .and_then(|value| value.to_str().ok()),
            Some("Upgrade")
        );
    }

    #[test]
    fn cli_shim_result_serializes_manual_instructions_with_camel_case_keys() {
        let value = serde_json::to_value(CliShimResult {
            status: "manualInstallRequired".to_string(),
            installed: false,
            path: Some("/usr/local/bin/paseo".to_string()),
            message: "Manual install required.".to_string(),
            manual_instructions: Some(CliManualInstructions {
                title: "Install from Terminal".to_string(),
                detail: "Run the commands below.".to_string(),
                commands: "sudo ...".to_string(),
            }),
        })
        .expect("serializes");

        assert_eq!(
            value.get("status").and_then(|entry| entry.as_str()),
            Some("manualInstallRequired")
        );
        assert_eq!(
            value
                .get("manualInstructions")
                .and_then(|entry| entry.get("commands"))
                .and_then(|entry| entry.as_str()),
            Some("sudo ...")
        );
    }

    #[test]
    fn outer_cli_shim_contents_only_forwards_to_inner_launcher() {
        let contents = outer_cli_shim_contents(Path::new(
            "/Applications/Paseo.app/Contents/MacOS/paseo-managed",
        ));
        assert!(contents
            .contains("exec \"/Applications/Paseo.app/Contents/MacOS/paseo-managed\" \"$@\""));
        assert!(!contents.contains("--paseo-cli-shim"));
    }

    #[test]
    fn inner_cli_launcher_path_lives_inside_managed_runtime_tree() {
        let runtime_root = PathBuf::from("/tmp/paseo-desktop/runtime");
        let inner_launcher = managed_cli_inner_launcher_path(&runtime_root);

        assert_eq!(
            inner_launcher,
            PathBuf::from("/tmp/paseo-desktop/runtime/bin/paseo-managed")
        );
    }

    #[test]
    fn outer_shim_target_remains_stable_across_runtime_updates() {
        let runtime_root = PathBuf::from("/tmp/paseo-desktop/runtime");
        let first_runtime_root = PathBuf::from("/tmp/paseo-desktop/runtime/runtime-a");
        let second_runtime_root = PathBuf::from("/tmp/paseo-desktop/runtime/runtime-b");
        let first_target = managed_cli_inner_launcher_path(&runtime_root);
        let second_target = managed_cli_inner_launcher_path(&runtime_root);
        let first_contents = outer_cli_shim_contents(&first_target);
        let second_contents = outer_cli_shim_contents(&second_target);

        assert_ne!(first_runtime_root, second_runtime_root);
        assert_eq!(first_target, second_target);
        assert_eq!(first_contents, second_contents);
        assert!(!first_contents.contains(first_runtime_root.to_string_lossy().as_ref()));
        assert!(!first_contents.contains(second_runtime_root.to_string_lossy().as_ref()));
    }

    #[cfg(unix)]
    #[test]
    #[ignore = "requires a running local daemon socket"]
    fn connects_to_running_local_daemon_socket() {
        let socket_path = std::env::var("PASEO_LOCAL_SOCKET_SMOKE_PATH")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .map(PathBuf::from)
            .or_else(|| {
                dirs::home_dir().map(|home| {
                    home.join(DEFAULT_MANAGED_HOME_BASENAME)
                        .join(SHORT_SOCKET_FILENAME)
                })
            })
            .expect("socket path should resolve");

        assert!(
            socket_path.exists(),
            "socket path does not exist: {}",
            socket_path.display()
        );

        tauri::async_runtime::block_on(async move {
            let mut ws_stream = connect_local_socket(socket_path.clone())
                .await
                .unwrap_or_else(|error| {
                    panic!(
                        "local socket websocket handshake failed for {}: {error}",
                        socket_path.display()
                    )
                });
            ws_stream.close(None).await.expect("close websocket stream");
        });
    }
}

fn copy_dir_recursive(source: &Path, target: &Path) -> Result<(), String> {
    if !source.exists() {
        return Err(format!(
            "Managed runtime resource is missing at {}",
            source.display()
        ));
    }
    fs::create_dir_all(target)
        .map_err(|error| format!("Failed to create {}: {error}", target.display()))?;
    for entry in fs::read_dir(source)
        .map_err(|error| format!("Failed to read {}: {error}", source.display()))?
    {
        let entry = entry.map_err(|error| format!("Failed to read directory entry: {error}"))?;
        let source_path = entry.path();
        let target_path = target.join(entry.file_name());
        let file_type = entry
            .file_type()
            .map_err(|error| format!("Failed to inspect {}: {error}", source_path.display()))?;
        if file_type.is_symlink() {
            let resolved = fs::canonicalize(&source_path).map_err(|error| {
                format!(
                    "Failed to resolve symlink {}: {error}",
                    source_path.display()
                )
            })?;
            let resolved_type = fs::metadata(&resolved).map_err(|error| {
                format!(
                    "Failed to inspect resolved symlink {}: {error}",
                    resolved.display()
                )
            })?;
            if resolved_type.is_dir() {
                copy_dir_recursive(&resolved, &target_path)?;
                continue;
            }
            if let Some(parent) = target_path.parent() {
                fs::create_dir_all(parent)
                    .map_err(|error| format!("Failed to create {}: {error}", parent.display()))?;
            }
            fs::copy(&resolved, &target_path).map_err(|error| {
                format!(
                    "Failed to copy {} to {}: {error}",
                    resolved.display(),
                    target_path.display()
                )
            })?;
            continue;
        }
        if file_type.is_dir() {
            copy_dir_recursive(&source_path, &target_path)?;
            continue;
        }
        if let Some(parent) = target_path.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("Failed to create {}: {error}", parent.display()))?;
        }
        fs::copy(&source_path, &target_path).map_err(|error| {
            format!(
                "Failed to copy {} to {}: {error}",
                source_path.display(),
                target_path.display()
            )
        })?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let permissions = fs::metadata(&source_path)
                .map_err(|error| format!("Failed to read {}: {error}", source_path.display()))?
                .permissions()
                .mode();
            fs::set_permissions(&target_path, fs::Permissions::from_mode(permissions)).map_err(
                |error| {
                    format!(
                        "Failed to preserve mode on {}: {error}",
                        target_path.display()
                    )
                },
            )?;
        }
    }
    Ok(())
}

fn read_json_file<T: for<'de> Deserialize<'de>>(path: &Path) -> Result<T, String> {
    let raw = fs::read_to_string(path)
        .map_err(|error| format!("Failed to read {}: {error}", path.display()))?;
    serde_json::from_str::<T>(&raw)
        .map_err(|error| format!("Failed to parse {}: {error}", path.display()))
}

fn write_json_file<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let raw = serde_json::to_string_pretty(value)
        .map_err(|error| format!("Failed to serialize {}: {error}", path.display()))?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Failed to create {}: {error}", parent.display()))?;
    }
    fs::write(path, format!("{raw}\n"))
        .map_err(|error| format!("Failed to write {}: {error}", path.display()))
}

fn app_data_root(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|error| format!("Failed to resolve app data directory: {error}"))
}

fn resolve_test_root() -> Option<PathBuf> {
    std::env::var("PASEO_DESKTOP_TEST_ROOT")
        .ok()
        .map(PathBuf::from)
}

fn resolve_override_path(name: &str) -> Option<PathBuf> {
    std::env::var(name).ok().map(PathBuf::from)
}

#[cfg(windows)]
fn current_username() -> String {
    std::env::var("USER")
        .ok()
        .or_else(|| std::env::var("USERNAME").ok())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "user".to_string())
}

#[cfg(windows)]
fn hash_seed(value: &str) -> String {
    let mut hasher = DefaultHasher::new();
    value.hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

#[cfg(windows)]
fn build_windows_pipe_path(seed: &str) -> String {
    let user = current_username()
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() {
                character.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect::<String>();
    format!("{PIPE_PREFIX}paseo-managed-{user}-{}", hash_seed(seed))
}

fn default_transport_type() -> &'static str {
    #[cfg(windows)]
    {
        "pipe"
    }
    #[cfg(not(windows))]
    {
        "socket"
    }
}

#[cfg(target_os = "macos")]
fn default_managed_home() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("/tmp"))
        .join(DEFAULT_MANAGED_HOME_BASENAME)
}

#[cfg(not(target_os = "macos"))]
fn default_managed_home(root: &Path) -> PathBuf {
    root.join(DEFAULT_MANAGED_HOME_DIRNAME)
}

fn default_transport_path(managed_home: &Path, diagnostics_root: &Path) -> PathBuf {
    #[cfg(windows)]
    {
        PathBuf::from(build_windows_pipe_path(
            diagnostics_root.to_string_lossy().as_ref(),
        ))
    }
    #[cfg(target_os = "macos")]
    {
        let _ = diagnostics_root;
        managed_home.join(SHORT_SOCKET_FILENAME)
    }
    #[cfg(all(not(windows), not(target_os = "macos")))]
    {
        let _ = diagnostics_root;
        managed_home.join(SHORT_SOCKET_FILENAME)
    }
}

fn resolve_paths(app: &AppHandle, runtime_id: &str) -> Result<ManagedPaths, String> {
    if let Some(test_root) = resolve_test_root() {
        let runtime_root = resolve_override_path("PASEO_DESKTOP_MANAGED_RUNTIME_ROOT")
            .unwrap_or_else(|| test_root.join("runtime").join(runtime_id));
        let managed_home = resolve_override_path("PASEO_DESKTOP_MANAGED_HOME")
            .unwrap_or_else(|| test_root.join(DEFAULT_MANAGED_HOME_DIRNAME));
        let transport_path = resolve_override_path("PASEO_DESKTOP_MANAGED_SOCKET_PATH")
            .unwrap_or_else(|| default_transport_path(&managed_home, &test_root));
        return Ok(ManagedPaths {
            runtime_root,
            stable_runtime_root: test_root.join("runtime"),
            managed_home: managed_home.clone(),
            transport_path,
            logs_path: managed_home.join("daemon.log"),
            state_file_path: test_root.join(MANAGED_STATE_FILE),
            diagnostics_root: test_root,
        });
    }

    let root = app_data_root(app)?;
    let runtime_root = resolve_override_path("PASEO_DESKTOP_MANAGED_RUNTIME_ROOT")
        .unwrap_or_else(|| root.join("runtime").join(runtime_id));
    let managed_home = resolve_override_path("PASEO_DESKTOP_MANAGED_HOME").unwrap_or_else(|| {
        #[cfg(target_os = "macos")]
        {
            default_managed_home()
        }
        #[cfg(not(target_os = "macos"))]
        {
            default_managed_home(&root)
        }
    });
    let transport_path = resolve_override_path("PASEO_DESKTOP_MANAGED_SOCKET_PATH")
        .unwrap_or_else(|| default_transport_path(&managed_home, &root));
    Ok(ManagedPaths {
        runtime_root,
        stable_runtime_root: root.join("runtime"),
        managed_home: managed_home.clone(),
        transport_path,
        logs_path: managed_home.join("daemon.log"),
        state_file_path: root.join(MANAGED_STATE_FILE),
        diagnostics_root: root,
    })
}

fn dev_resource_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources")
}

fn bundled_runtime_root(app: &AppHandle) -> Result<PathBuf, String> {
    if let Ok(resource_dir) = app.path().resource_dir() {
        let candidate = resource_dir.join("managed-runtime");
        if candidate.exists() {
            return Ok(candidate);
        }
    }
    let dev = dev_resource_root().join("managed-runtime");
    if dev.exists() {
        return Ok(dev);
    }
    Err("Managed runtime resources are not bundled with this desktop build.".to_string())
}

fn load_bundled_runtime_pointer(
    app: &AppHandle,
) -> Result<(PathBuf, BundledRuntimePointer), String> {
    let root = bundled_runtime_root(app)?;
    let pointer_path = root.join("current-runtime.json");
    let pointer = read_json_file::<BundledRuntimePointer>(&pointer_path)?;
    Ok((root, pointer))
}

fn load_runtime_manifest(runtime_root: &Path) -> Result<ManagedRuntimeManifest, String> {
    read_json_file::<ManagedRuntimeManifest>(&runtime_root.join("runtime-manifest.json"))
}

fn read_server_id(managed_home: &Path) -> Option<String> {
    let raw = fs::read_to_string(managed_home.join("server-id")).ok()?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn tail_log(path: &Path, max_lines: usize) -> String {
    let raw = match fs::read_to_string(path) {
        Ok(value) => value,
        Err(_) => return String::new(),
    };
    let mut lines = raw.lines().rev().take(max_lines).collect::<Vec<_>>();
    lines.reverse();
    lines.join("\n")
}

fn is_pid_running(pid: i32) -> bool {
    #[cfg(unix)]
    {
        let output = Command::new("kill")
            .arg("-0")
            .arg(pid.to_string())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
        return output.map(|status| status.success()).unwrap_or(false);
    }
    #[cfg(not(unix))]
    {
        let _ = pid;
        false
    }
}

fn to_stdio_message(input: Option<&str>) -> String {
    input.unwrap_or_default().trim().to_string()
}

fn parse_tcp_listen(listen: &str) -> Result<(String, u16), String> {
    let trimmed = listen.trim();
    let (host, port_raw) = trimmed
        .rsplit_once(':')
        .ok_or_else(|| "Managed TCP listen target must be host:port.".to_string())?;
    let host = host.trim();
    if host.is_empty() {
        return Err("Managed TCP host cannot be empty.".to_string());
    }
    let port = port_raw
        .trim()
        .parse::<u16>()
        .map_err(|_| "Managed TCP port must be a valid integer.".to_string())?;
    if port == 0 {
        return Err("Managed TCP port must be greater than 0.".to_string());
    }
    if port == 6767 {
        return Err("Managed TCP mode cannot use port 6767.".to_string());
    }
    Ok((host.to_string(), port))
}

fn resolve_tcp_settings_from_state(state: Option<&ManagedStateFile>) -> ManagedTcpSettings {
    let listen = state
        .and_then(|value| value.tcp_listen.clone())
        .unwrap_or_else(|| format!("{DEFAULT_MANAGED_TCP_HOST}:{DEFAULT_MANAGED_TCP_PORT}"));
    let (host, port) = parse_tcp_listen(&listen).unwrap_or((
        DEFAULT_MANAGED_TCP_HOST.to_string(),
        DEFAULT_MANAGED_TCP_PORT,
    ));
    ManagedTcpSettings {
        enabled: state.map(|value| value.tcp_enabled).unwrap_or(false),
        host,
        port,
    }
}

fn managed_transport_target(
    paths: &ManagedPaths,
    state: Option<&ManagedStateFile>,
) -> Result<ManagedTransportTarget, String> {
    let tcp_settings = resolve_tcp_settings_from_state(state);
    if tcp_settings.enabled {
        return Ok(ManagedTransportTarget {
            transport_type: "tcp".to_string(),
            transport_path: format!("{}:{}", tcp_settings.host, tcp_settings.port),
        });
    }
    Ok(ManagedTransportTarget {
        transport_type: default_transport_type().to_string(),
        transport_path: paths.transport_path.to_string_lossy().into_owned(),
    })
}

fn cli_host_for_target(target: &ManagedTransportTarget) -> String {
    match target.transport_type.as_str() {
        "tcp" => target.transport_path.clone(),
        "pipe" => format!("pipe://{}", target.transport_path),
        _ => format!("unix://{}", target.transport_path),
    }
}

fn cli_env(paths: &ManagedPaths) -> Vec<(String, String)> {
    let state = read_state_file(&paths.state_file_path);
    let target =
        managed_transport_target(paths, state.as_ref()).unwrap_or(ManagedTransportTarget {
            transport_type: default_transport_type().to_string(),
            transport_path: paths.transport_path.to_string_lossy().into_owned(),
        });
    vec![
        (
            "PASEO_HOME".to_string(),
            paths.managed_home.to_string_lossy().into_owned(),
        ),
        ("PASEO_HOST".to_string(), cli_host_for_target(&target)),
    ]
}

fn cli_command(
    runtime_root: &Path,
    manifest: &ManagedRuntimeManifest,
    args: &[&str],
    paths: &ManagedPaths,
) -> Result<Command, String> {
    let node = runtime_root.join(&manifest.node_relative_path);
    let cli = runtime_root.join(&manifest.cli_entrypoint_relative_path);
    if !node.exists() {
        return Err(format!(
            "Bundled Node runtime is missing at {}",
            node.display()
        ));
    }
    if !cli.exists() {
        return Err(format!(
            "Bundled CLI entrypoint is missing at {}",
            cli.display()
        ));
    }
    let mut command = Command::new(node);
    command.arg(cli);
    command.args(args);
    for (key, value) in cli_env(paths) {
        command.env(key, value);
    }
    Ok(command)
}

fn shell_single_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', r"'\''"))
}

fn escape_applescript_string(value: &str) -> String {
    value.replace('\\', r"\\").replace('"', "\\\"")
}

#[cfg(windows)]
fn powershell_double_quote(value: &str) -> String {
    value.replace('`', "``").replace('"', "`\"")
}

fn managed_cli_inner_launcher_path(launcher_root: &Path) -> PathBuf {
    #[cfg(windows)]
    {
        return launcher_root
            .join(CLI_INNER_DIR)
            .join(CLI_INNER_WINDOWS_NAME);
    }
    #[cfg(not(windows))]
    {
        launcher_root.join(CLI_INNER_DIR).join(CLI_INNER_UNIX_NAME)
    }
}

fn outer_cli_shim_path() -> Result<PathBuf, String> {
    #[cfg(target_os = "macos")]
    {
        return Ok(PathBuf::from("/usr/local/bin").join(CLI_SHIM_NAME));
    }
    #[cfg(all(not(target_os = "macos"), not(windows)))]
    {
        return Ok(PathBuf::from("/usr/local/bin").join(CLI_SHIM_NAME));
    }
    #[cfg(windows)]
    {
        let local_app_data = dirs::data_local_dir().ok_or_else(|| {
            "Failed to resolve LocalAppData for CLI shim instructions.".to_string()
        })?;
        Ok(local_app_data
            .join("Microsoft")
            .join("WinGet")
            .join("Links")
            .join(CLI_SHIM_WINDOWS_NAME))
    }
}

fn inner_cli_launcher_contents(paths: &ManagedPaths, manifest: &ManagedRuntimeManifest) -> String {
    let node = paths.runtime_root.join(&manifest.node_relative_path);
    let cli = paths
        .runtime_root
        .join(&manifest.cli_entrypoint_relative_path);
    #[cfg(windows)]
    {
        return format!(
            "@echo off\r\nset \"PASEO_HOME={}\"\r\n\"{}\" \"{}\" %*\r\n",
            paths.managed_home.display(),
            node.display(),
            cli.display()
        );
    }
    #[cfg(not(windows))]
    {
        format!(
            "#!/bin/sh\nexport PASEO_HOME={}\nexec \"{}\" \"{}\" \"$@\"\n",
            shell_single_quote(paths.managed_home.to_string_lossy().as_ref()),
            node.display(),
            cli.display()
        )
    }
}

fn outer_cli_shim_contents(inner_launcher: &Path) -> String {
    #[cfg(windows)]
    {
        return format!("@echo off\r\n\"{}\" %*\r\n", inner_launcher.display());
    }
    #[cfg(not(windows))]
    {
        format!("#!/bin/sh\nexec \"{}\" \"$@\"\n", inner_launcher.display())
    }
}

fn write_cli_launcher(path: &Path, contents: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Failed to create {}: {error}", parent.display()))?;
    }
    fs::write(path, contents)
        .map_err(|error| format!("Failed to write {}: {error}", path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o755))
            .map_err(|error| format!("Failed to chmod {}: {error}", path.display()))?;
    }
    Ok(())
}

fn ensure_inner_cli_launcher(
    paths: &ManagedPaths,
    manifest: &ManagedRuntimeManifest,
) -> Result<PathBuf, String> {
    let inner_launcher = managed_cli_inner_launcher_path(&paths.stable_runtime_root);
    write_cli_launcher(
        &inner_launcher,
        &inner_cli_launcher_contents(paths, manifest),
    )?;
    Ok(inner_launcher)
}

fn cli_manual_instructions(
    paths: &ManagedPaths,
    manifest: &ManagedRuntimeManifest,
) -> Result<CliManualInstructions, String> {
    let inner_launcher = ensure_inner_cli_launcher(paths, manifest)?;
    let outer_shim = outer_cli_shim_path()?;
    #[cfg(windows)]
    {
        let target_dir = outer_shim
            .parent()
            .ok_or_else(|| "CLI shim target is missing a parent directory.".to_string())?;
        let contents = outer_cli_shim_contents(&inner_launcher);
        return Ok(CliManualInstructions {
            title: "Install the Paseo CLI from PowerShell".to_string(),
            detail: "If the automatic install does not complete, run these commands in PowerShell to write the PATH shim manually.".to_string(),
            commands: format!(
                "$target = \"{}\"\nNew-Item -ItemType Directory -Force -Path \"{}\" | Out-Null\n$contents = @\"\n{}\"@\nSet-Content -Path $target -Value $contents -Encoding ASCII\n",
                powershell_double_quote(outer_shim.to_string_lossy().as_ref()),
                powershell_double_quote(target_dir.to_string_lossy().as_ref()),
                contents
            ),
        });
    }
    #[cfg(not(windows))]
    {
        Ok(CliManualInstructions {
            title: "Install the Paseo CLI from Terminal".to_string(),
            detail: "If the automatic install does not complete, run these commands in Terminal to write the global PATH shim manually.".to_string(),
            commands: format!(
                "sudo mkdir -p {target_dir}\nprintf '%s\\n' {lines} | sudo tee {target_path} >/dev/null\nsudo chmod 755 {target_path}\n",
                target_dir = shell_single_quote(
                    outer_shim
                        .parent()
                        .ok_or_else(|| "CLI shim target is missing a parent directory.".to_string())?
                        .to_string_lossy()
                        .as_ref()
                ),
                target_path = shell_single_quote(outer_shim.to_string_lossy().as_ref()),
                lines = iter::once("#!/bin/sh".to_string())
                    .chain(iter::once(format!(
                        "exec \"{}\" \"$@\"",
                        inner_launcher.to_string_lossy()
                    )))
                    .map(|line| shell_single_quote(&line))
                    .collect::<Vec<_>>()
                    .join(" ")
            ),
        })
    }
}

fn detect_installed_cli_shim_path(paths: &ManagedPaths) -> Option<String> {
    let outer_shim = outer_cli_shim_path().ok()?;
    let inner_launcher = managed_cli_inner_launcher_path(&paths.stable_runtime_root);
    let expected = outer_cli_shim_contents(&inner_launcher);
    let actual = fs::read_to_string(&outer_shim).ok()?;
    (actual == expected).then(|| outer_shim.to_string_lossy().into_owned())
}

fn read_pid_from_home(managed_home: &Path) -> Option<i64> {
    read_json_file::<PidFile>(&managed_home.join("paseo.pid"))
        .ok()
        .and_then(|parsed| parsed.pid)
}

fn read_hostname_from_home(managed_home: &Path) -> Option<String> {
    read_json_file::<PidFile>(&managed_home.join("paseo.pid"))
        .ok()
        .and_then(|parsed| parsed.hostname)
}

fn read_state_file(path: &Path) -> Option<ManagedStateFile> {
    read_json_file::<ManagedStateFile>(path).ok()
}

fn write_state_file(path: &Path, value: &ManagedStateFile) -> Result<(), String> {
    write_json_file(path, value)
}

fn runtime_install_lock() -> &'static Mutex<()> {
    RUNTIME_INSTALL_LOCK.get_or_init(|| Mutex::new(()))
}

fn install_runtime_if_needed(source_root: &Path, target_root: &Path) -> Result<(), String> {
    let _guard = runtime_install_lock()
        .lock()
        .map_err(|_| "Managed runtime install lock was poisoned.".to_string())?;

    let target_manifest = target_root.join("runtime-manifest.json");
    if target_manifest.exists() {
        return Ok(());
    }

    if target_root.exists() {
        fs::remove_dir_all(target_root).map_err(|error| {
            format!(
                "Failed to remove incomplete runtime {}: {error}",
                target_root.display()
            )
        })?;
    }

    let staging_root = target_root.with_extension(format!("installing-{}", std::process::id()));
    if staging_root.exists() {
        fs::remove_dir_all(&staging_root).map_err(|error| {
            format!(
                "Failed to remove stale runtime staging dir {}: {error}",
                staging_root.display()
            )
        })?;
    }

    copy_dir_recursive(source_root, &staging_root)?;
    let staging_manifest = staging_root.join("runtime-manifest.json");
    if !staging_manifest.exists() {
        let _ = fs::remove_dir_all(&staging_root);
        return Err(format!(
            "Managed runtime staging manifest is missing at {}",
            staging_manifest.display()
        ));
    }

    fs::rename(&staging_root, target_root).map_err(|error| {
        let _ = fs::remove_dir_all(&staging_root);
        format!(
            "Failed to finalize managed runtime install from {} to {}: {error}",
            staging_root.display(),
            target_root.display()
        )
    })?;

    Ok(())
}

fn ensure_runtime_installed_internal(app: &AppHandle) -> Result<ManagedRuntimeStatus, String> {
    let (bundled_root, pointer) = load_bundled_runtime_pointer(app)?;
    let source_root = bundled_root.join(&pointer.relative_root);
    let paths = resolve_paths(app, &pointer.runtime_id)?;
    install_runtime_if_needed(&source_root, &paths.runtime_root)?;
    let manifest = load_runtime_manifest(&paths.runtime_root)?;
    if let Some(parent) = paths.transport_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Failed to create {}: {error}", parent.display()))?;
    }
    fs::create_dir_all(&paths.managed_home)
        .map_err(|error| format!("Failed to create {}: {error}", paths.managed_home.display()))?;
    ensure_inner_cli_launcher(&paths, &manifest)?;
    let existing_state = read_state_file(&paths.state_file_path);
    let target = managed_transport_target(&paths, existing_state.as_ref())?;
    let state = ManagedStateFile {
        runtime_id: manifest.runtime_id.clone(),
        runtime_root: paths.runtime_root.to_string_lossy().into_owned(),
        managed_home: paths.managed_home.to_string_lossy().into_owned(),
        transport_type: target.transport_type.clone(),
        transport_path: target.transport_path.clone(),
        tcp_enabled: existing_state
            .as_ref()
            .map(|entry| entry.tcp_enabled)
            .unwrap_or(false),
        tcp_listen: existing_state
            .as_ref()
            .and_then(|entry| entry.tcp_listen.clone()),
        cli_shim_path: existing_state.and_then(|entry| entry.cli_shim_path),
    };
    write_state_file(&paths.state_file_path, &state)?;

    Ok(ManagedRuntimeStatus {
        runtime_id: manifest.runtime_id,
        runtime_version: manifest.runtime_version,
        bundled_runtime_root: source_root.to_string_lossy().into_owned(),
        installed_runtime_root: paths.runtime_root.to_string_lossy().into_owned(),
        installed: true,
        managed_home: paths.managed_home.to_string_lossy().into_owned(),
        transport_type: state.transport_type,
        transport_path: state.transport_path,
        diagnostics_root: paths.diagnostics_root.to_string_lossy().into_owned(),
        state_file_path: paths.state_file_path.to_string_lossy().into_owned(),
    })
}

fn run_cli_json_command(
    runtime_root: &Path,
    manifest: &ManagedRuntimeManifest,
    args: &[&str],
    paths: &ManagedPaths,
) -> Result<serde_json::Value, String> {
    let output = cli_command(runtime_root, manifest, args, paths)?
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|error| format!("Failed to run bundled CLI: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "Bundled CLI failed (exit {}): {}",
            output.status.code().unwrap_or(-1),
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    serde_json::from_str(stdout.trim()).map_err(|error| {
        format!(
            "Failed to parse bundled CLI JSON output: {error}; stdout={}",
            stdout.trim()
        )
    })
}

fn managed_daemon_status_internal(app: &AppHandle) -> Result<ManagedDaemonStatus, String> {
    let status = ensure_runtime_installed_internal(app)?;
    let paths = resolve_paths(app, &status.runtime_id)?;
    let manifest = load_runtime_manifest(&paths.runtime_root)?;
    let state = read_state_file(&paths.state_file_path);
    let target = managed_transport_target(&paths, state.as_ref())?;
    let tcp_settings = resolve_tcp_settings_from_state(state.as_ref());
    let cli_status = run_cli_json_command(
        &paths.runtime_root,
        &manifest,
        &[
            "daemon",
            "status",
            "--home",
            &paths.managed_home.to_string_lossy(),
            "--json",
        ],
        &paths,
    )
    .ok();

    let daemon_status = cli_status
        .as_ref()
        .and_then(|value| value.get("status"))
        .and_then(|value| value.as_str())
        .unwrap_or(if read_pid_from_home(&paths.managed_home).is_some() {
            "running"
        } else {
            "stopped"
        })
        .to_string();
    let daemon_pid = cli_status
        .as_ref()
        .and_then(|value| value.get("pid"))
        .and_then(|value| {
            value
                .as_i64()
                .or_else(|| value.as_str().and_then(|raw| raw.parse::<i64>().ok()))
        })
        .or_else(|| read_pid_from_home(&paths.managed_home));
    let daemon_running = daemon_pid
        .map(|pid| is_pid_running(pid as i32))
        .unwrap_or(false)
        || daemon_status == "running";

    Ok(ManagedDaemonStatus {
        runtime_id: manifest.runtime_id,
        runtime_version: manifest.runtime_version,
        runtime_root: paths.runtime_root.to_string_lossy().into_owned(),
        managed_home: paths.managed_home.to_string_lossy().into_owned(),
        transport_type: target.transport_type,
        transport_path: target.transport_path,
        daemon_pid,
        daemon_running,
        daemon_status,
        log_path: paths.logs_path.to_string_lossy().into_owned(),
        server_id: read_server_id(&paths.managed_home),
        hostname: read_hostname_from_home(&paths.managed_home),
        relay_enabled: true,
        tcp_enabled: tcp_settings.enabled,
        tcp_listen: tcp_settings
            .enabled
            .then(|| format!("{}:{}", tcp_settings.host, tcp_settings.port)),
        cli_shim_path: detect_installed_cli_shim_path(&paths),
    })
}

#[cfg(target_os = "macos")]
fn install_cli_shim_via_macos_prompt(shim_path: &Path, contents: &str) -> Result<(), String> {
    // Manual smoke path: click Install CLI in the desktop app on macOS and confirm the
    // /usr/local/bin/paseo prompt writes the trivial outer shim shown in cli_manual_instructions().
    let temp_path = std::env::temp_dir().join(format!("paseo-cli-shim-{}", std::process::id()));
    write_cli_launcher(&temp_path, contents)?;
    let command = format!(
        "mkdir -p {target_dir} && install -m 755 {temp_path} {target_path}",
        target_dir = shell_single_quote(
            shim_path
                .parent()
                .ok_or_else(|| "CLI shim target is missing a parent directory.".to_string())?
                .to_string_lossy()
                .as_ref()
        ),
        temp_path = shell_single_quote(temp_path.to_string_lossy().as_ref()),
        target_path = shell_single_quote(shim_path.to_string_lossy().as_ref())
    );
    let output = Command::new("osascript")
        .arg("-e")
        .arg(format!(
            "do shell script \"{}\" with administrator privileges",
            escape_applescript_string(&command)
        ))
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|error| format!("Failed to request macOS CLI install privileges: {error}"))?;
    let _ = fs::remove_file(&temp_path);
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if stderr.contains("User canceled") || stderr.contains("(-128)") {
        return Err("ELEVATION_DENIED".to_string());
    }
    Err(if stderr.is_empty() {
        "Failed to install the global CLI shim.".to_string()
    } else {
        stderr
    })
}

#[cfg(target_os = "macos")]
fn remove_cli_shim_via_macos_prompt(shim_path: &Path) -> Result<(), String> {
    let command = format!(
        "rm -f {}",
        shell_single_quote(shim_path.to_string_lossy().as_ref())
    );
    let output = Command::new("osascript")
        .arg("-e")
        .arg(format!(
            "do shell script \"{}\" with administrator privileges",
            escape_applescript_string(&command)
        ))
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|error| format!("Failed to request macOS CLI uninstall privileges: {error}"))?;
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    Err(if stderr.is_empty() {
        "Failed to remove the global CLI shim.".to_string()
    } else {
        stderr
    })
}

fn install_cli_shim_internal(app: &AppHandle) -> Result<CliShimResult, String> {
    let status = ensure_runtime_installed_internal(app)?;
    let paths = resolve_paths(app, &status.runtime_id)?;
    let manifest = load_runtime_manifest(&paths.runtime_root)?;
    let inner_launcher = ensure_inner_cli_launcher(&paths, &manifest)?;
    let shim_path = outer_cli_shim_path()?;
    let shim_contents = outer_cli_shim_contents(&inner_launcher);
    let manual_instructions = cli_manual_instructions(&paths, &manifest)?;

    #[cfg(target_os = "macos")]
    let install_result = install_cli_shim_via_macos_prompt(&shim_path, &shim_contents);
    #[cfg(all(not(target_os = "macos"), not(windows)))]
    let install_result = write_cli_launcher(&shim_path, &shim_contents);
    #[cfg(windows)]
    let install_result: Result<(), String> = Err("AUTOMATIC_INSTALL_UNAVAILABLE".to_string());

    match install_result {
        Ok(()) => {
            let mut state = read_state_file(&paths.state_file_path).unwrap_or(ManagedStateFile {
                runtime_id: status.runtime_id.clone(),
                runtime_root: paths.runtime_root.to_string_lossy().into_owned(),
                managed_home: paths.managed_home.to_string_lossy().into_owned(),
                transport_type: status.transport_type.clone(),
                transport_path: status.transport_path.clone(),
                tcp_enabled: false,
                tcp_listen: None,
                cli_shim_path: None,
            });
            state.cli_shim_path = Some(shim_path.to_string_lossy().into_owned());
            write_state_file(&paths.state_file_path, &state)?;
            Ok(CliShimResult {
                status: "installed".to_string(),
                installed: true,
                path: Some(shim_path.to_string_lossy().into_owned()),
                message: format!("Paseo CLI installed at {}.", shim_path.display()),
                manual_instructions: None,
            })
        }
        Err(error) if error == "ELEVATION_DENIED" => Ok(CliShimResult {
            status: "elevationDenied".to_string(),
            installed: false,
            path: Some(shim_path.to_string_lossy().into_owned()),
            message: "CLI install needs administrator approval. If you dismissed the prompt, install it from Terminal with the commands below.".to_string(),
            manual_instructions: Some(manual_instructions),
        }),
        Err(error) if error == "AUTOMATIC_INSTALL_UNAVAILABLE" => Ok(CliShimResult {
            status: "automaticInstallUnavailable".to_string(),
            installed: false,
            path: Some(shim_path.to_string_lossy().into_owned()),
            message: "Automatic CLI install is not available on this platform. Finish the install manually with the commands below.".to_string(),
            manual_instructions: Some(manual_instructions),
        }),
        Err(error) => Ok(CliShimResult {
            status: "manualInstallRequired".to_string(),
            installed: false,
            path: Some(shim_path.to_string_lossy().into_owned()),
            message: format!(
                "Automatic CLI install did not complete: {error}. Finish the install manually with the commands below."
            ),
            manual_instructions: Some(manual_instructions),
        }),
    }
}

fn uninstall_cli_shim_internal(app: &AppHandle) -> Result<CliShimResult, String> {
    let status = ensure_runtime_installed_internal(app)?;
    let paths = resolve_paths(app, &status.runtime_id)?;
    let shim_path = detect_installed_cli_shim_path(&paths)
        .map(PathBuf::from)
        .or_else(|| {
            read_state_file(&paths.state_file_path)
                .and_then(|entry| entry.cli_shim_path.map(PathBuf::from))
        })
        .unwrap_or(outer_cli_shim_path()?);
    if shim_path.exists() {
        #[cfg(target_os = "macos")]
        remove_cli_shim_via_macos_prompt(&shim_path)?;
        #[cfg(all(not(target_os = "macos"), not(windows)))]
        fs::remove_file(&shim_path)
            .map_err(|error| format!("Failed to remove {}: {error}", shim_path.display()))?;
        #[cfg(windows)]
        fs::remove_file(&shim_path)
            .map_err(|error| format!("Failed to remove {}: {error}", shim_path.display()))?;
    }
    let mut state = read_state_file(&paths.state_file_path).unwrap_or(ManagedStateFile {
        runtime_id: status.runtime_id.clone(),
        runtime_root: paths.runtime_root.to_string_lossy().into_owned(),
        managed_home: paths.managed_home.to_string_lossy().into_owned(),
        transport_type: status.transport_type.clone(),
        transport_path: status.transport_path.clone(),
        tcp_enabled: false,
        tcp_listen: None,
        cli_shim_path: None,
    });
    state.cli_shim_path = None;
    write_state_file(&paths.state_file_path, &state)?;

    Ok(CliShimResult {
        status: "removed".to_string(),
        installed: false,
        path: Some(shim_path.to_string_lossy().into_owned()),
        message: "Paseo CLI shim removed.".to_string(),
        manual_instructions: None,
    })
}

fn start_managed_daemon_internal(app: &AppHandle) -> Result<ManagedDaemonStatus, String> {
    let status = ensure_runtime_installed_internal(app)?;
    let paths = resolve_paths(app, &status.runtime_id)?;
    let existing_status = managed_daemon_status_internal(app)?;
    if existing_status.daemon_running {
        return Ok(existing_status);
    }
    if let Some(parent) = paths.transport_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Failed to create {}: {error}", parent.display()))?;
    }
    let manifest = load_runtime_manifest(&paths.runtime_root)?;
    let state = read_state_file(&paths.state_file_path);
    let target = managed_transport_target(&paths, state.as_ref())?;
    let output = cli_command(
        &paths.runtime_root,
        &manifest,
        &[
            "start",
            "--home",
            &paths.managed_home.to_string_lossy(),
            "--listen",
            &target.transport_path,
        ],
        &paths,
    )?
    .stdout(Stdio::piped())
    .stderr(Stdio::piped())
    .output()
    .map_err(|error| format!("Failed to launch managed daemon: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "Managed daemon start failed (exit {}): {}",
            output.status.code().unwrap_or(-1),
            to_stdio_message(Some(&String::from_utf8_lossy(&output.stderr)))
        ));
    }
    for _ in 0..30 {
        let daemon_status = managed_daemon_status_internal(app)?;
        if daemon_status.daemon_running {
            return Ok(daemon_status);
        }
        std::thread::sleep(std::time::Duration::from_millis(200));
    }
    managed_daemon_status_internal(app)
}

fn stop_managed_daemon_internal(app: &AppHandle) -> Result<ManagedDaemonStatus, String> {
    let status = ensure_runtime_installed_internal(app)?;
    let paths = resolve_paths(app, &status.runtime_id)?;
    let manifest = load_runtime_manifest(&paths.runtime_root)?;
    let output = cli_command(
        &paths.runtime_root,
        &manifest,
        &[
            "daemon",
            "stop",
            "--home",
            &paths.managed_home.to_string_lossy(),
            "--json",
        ],
        &paths,
    )?
    .stdout(Stdio::piped())
    .stderr(Stdio::piped())
    .output()
    .map_err(|error| format!("Failed to stop managed daemon: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "Managed daemon stop failed (exit {}): {}",
            output.status.code().unwrap_or(-1),
            to_stdio_message(Some(&String::from_utf8_lossy(&output.stderr)))
        ));
    }
    managed_daemon_status_internal(app)
}

fn restart_managed_daemon_internal(app: &AppHandle) -> Result<ManagedDaemonStatus, String> {
    let status = ensure_runtime_installed_internal(app)?;
    let paths = resolve_paths(app, &status.runtime_id)?;
    let manifest = load_runtime_manifest(&paths.runtime_root)?;
    let state = read_state_file(&paths.state_file_path);
    let target = managed_transport_target(&paths, state.as_ref())?;
    let output = cli_command(
        &paths.runtime_root,
        &manifest,
        &[
            "daemon",
            "restart",
            "--home",
            &paths.managed_home.to_string_lossy(),
            "--listen",
            &target.transport_path,
            "--json",
        ],
        &paths,
    )?
    .stdout(Stdio::piped())
    .stderr(Stdio::piped())
    .output()
    .map_err(|error| format!("Failed to restart managed daemon: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "Managed daemon restart failed (exit {}): {}",
            output.status.code().unwrap_or(-1),
            to_stdio_message(Some(&String::from_utf8_lossy(&output.stderr)))
        ));
    }
    managed_daemon_status_internal(app)
}

fn update_managed_tcp_settings_internal(
    app: &AppHandle,
    settings: ManagedTcpSettings,
) -> Result<ManagedDaemonStatus, String> {
    if settings.enabled {
        parse_tcp_listen(&format!("{}:{}", settings.host.trim(), settings.port))?;
    }
    let status = ensure_runtime_installed_internal(app)?;
    let paths = resolve_paths(app, &status.runtime_id)?;
    let mut state = read_state_file(&paths.state_file_path).unwrap_or(ManagedStateFile {
        runtime_id: status.runtime_id.clone(),
        runtime_root: paths.runtime_root.to_string_lossy().into_owned(),
        managed_home: paths.managed_home.to_string_lossy().into_owned(),
        transport_type: status.transport_type.clone(),
        transport_path: status.transport_path.clone(),
        tcp_enabled: false,
        tcp_listen: None,
        cli_shim_path: None,
    });
    state.tcp_enabled = settings.enabled;
    state.tcp_listen = Some(format!("{}:{}", settings.host.trim(), settings.port));
    let target = managed_transport_target(&paths, Some(&state))?;
    state.transport_type = target.transport_type;
    state.transport_path = target.transport_path;
    write_state_file(&paths.state_file_path, &state)?;

    if managed_daemon_status_internal(app)?.daemon_running {
        return restart_managed_daemon_internal(app);
    }
    managed_daemon_status_internal(app)
}

#[tauri::command]
pub async fn managed_runtime_status(app: AppHandle) -> Result<ManagedRuntimeStatus, String> {
    tauri::async_runtime::spawn_blocking(move || ensure_runtime_installed_internal(&app))
        .await
        .map_err(|error| format!("Managed runtime status task failed: {error}"))?
}

#[tauri::command]
pub async fn ensure_managed_runtime(app: AppHandle) -> Result<ManagedRuntimeStatus, String> {
    tauri::async_runtime::spawn_blocking(move || ensure_runtime_installed_internal(&app))
        .await
        .map_err(|error| format!("Managed runtime install task failed: {error}"))?
}

#[tauri::command]
pub async fn managed_daemon_status(app: AppHandle) -> Result<ManagedDaemonStatus, String> {
    tauri::async_runtime::spawn_blocking(move || managed_daemon_status_internal(&app))
        .await
        .map_err(|error| format!("Managed daemon status task failed: {error}"))?
}

#[tauri::command]
pub async fn start_managed_daemon(app: AppHandle) -> Result<ManagedDaemonStatus, String> {
    tauri::async_runtime::spawn_blocking(move || start_managed_daemon_internal(&app))
        .await
        .map_err(|error| format!("Managed daemon start task failed: {error}"))?
}

#[tauri::command]
pub async fn stop_managed_daemon(app: AppHandle) -> Result<ManagedDaemonStatus, String> {
    tauri::async_runtime::spawn_blocking(move || stop_managed_daemon_internal(&app))
        .await
        .map_err(|error| format!("Managed daemon stop task failed: {error}"))?
}

#[tauri::command]
pub async fn restart_managed_daemon(app: AppHandle) -> Result<ManagedDaemonStatus, String> {
    tauri::async_runtime::spawn_blocking(move || restart_managed_daemon_internal(&app))
        .await
        .map_err(|error| format!("Managed daemon restart task failed: {error}"))?
}

#[tauri::command]
pub async fn managed_daemon_logs(app: AppHandle) -> Result<ManagedDaemonLogs, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let status = ensure_runtime_installed_internal(&app)?;
        let paths = resolve_paths(&app, &status.runtime_id)?;
        Ok(ManagedDaemonLogs {
            log_path: paths.logs_path.to_string_lossy().into_owned(),
            contents: tail_log(&paths.logs_path, 400),
        })
    })
    .await
    .map_err(|error| format!("Managed daemon logs task failed: {error}"))?
}

#[tauri::command]
pub async fn managed_daemon_pairing(app: AppHandle) -> Result<ManagedPairingOffer, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let status = ensure_runtime_installed_internal(&app)?;
        let paths = resolve_paths(&app, &status.runtime_id)?;
        let manifest = load_runtime_manifest(&paths.runtime_root)?;
        let value = run_cli_json_command(
            &paths.runtime_root,
            &manifest,
            &[
                "daemon",
                "pair",
                "--home",
                &paths.managed_home.to_string_lossy(),
                "--json",
            ],
            &paths,
        )?;
        serde_json::from_value::<ManagedPairingOffer>(value)
            .map_err(|error| format!("Failed to parse managed pairing offer: {error}"))
    })
    .await
    .map_err(|error| format!("Managed daemon pairing task failed: {error}"))?
}

#[tauri::command]
pub async fn install_cli_shim(app: AppHandle) -> Result<CliShimResult, String> {
    tauri::async_runtime::spawn_blocking(move || install_cli_shim_internal(&app))
        .await
        .map_err(|error| format!("CLI shim install task failed: {error}"))?
}

#[tauri::command]
pub async fn uninstall_cli_shim(app: AppHandle) -> Result<CliShimResult, String> {
    tauri::async_runtime::spawn_blocking(move || uninstall_cli_shim_internal(&app))
        .await
        .map_err(|error| format!("CLI shim uninstall task failed: {error}"))?
}

#[tauri::command]
pub async fn update_managed_daemon_tcp_settings(
    app: AppHandle,
    settings: ManagedTcpSettings,
) -> Result<ManagedDaemonStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        update_managed_tcp_settings_internal(&app, settings)
    })
    .await
    .map_err(|error| format!("Managed daemon TCP settings task failed: {error}"))?
}

async fn spawn_local_transport_session<S>(
    app: AppHandle,
    transport_state: State<'_, LocalTransportState>,
    session_id: String,
    ws_stream: tokio_tungstenite::WebSocketStream<S>,
) -> Result<String, String>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    let (mut write, mut read) = ws_stream.split();
    let (sender, mut receiver) = mpsc::unbounded_channel::<Message>();
    transport_state
        .sessions
        .lock()
        .map_err(|_| "Local transport session lock poisoned.".to_string())?
        .insert(session_id.clone(), LocalTransportSession { sender });

    let app_for_read = app.clone();
    let app_for_write = app.clone();
    let sessions_for_read = Arc::clone(&transport_state.sessions);
    let read_session_id = session_id.clone();
    tauri::async_runtime::spawn(async move {
        let _ = app_for_read.emit(
            LOCAL_TRANSPORT_EVENT_NAME,
            LocalTransportEvent {
                session_id: read_session_id.clone(),
                kind: "open".to_string(),
                text: None,
                binary_base64: None,
                code: None,
                reason: None,
                error: None,
            },
        );

        while let Some(message) = read.next().await {
            match message {
                Ok(Message::Text(text)) => {
                    let _ = app_for_read.emit(
                        LOCAL_TRANSPORT_EVENT_NAME,
                        LocalTransportEvent {
                            session_id: read_session_id.clone(),
                            kind: "message".to_string(),
                            text: Some(text.to_string()),
                            binary_base64: None,
                            code: None,
                            reason: None,
                            error: None,
                        },
                    );
                }
                Ok(Message::Binary(bytes)) => {
                    let _ = app_for_read.emit(
                        LOCAL_TRANSPORT_EVENT_NAME,
                        LocalTransportEvent {
                            session_id: read_session_id.clone(),
                            kind: "message".to_string(),
                            text: None,
                            binary_base64: Some(BASE64_STANDARD.encode(bytes)),
                            code: None,
                            reason: None,
                            error: None,
                        },
                    );
                }
                Ok(Message::Close(frame)) => {
                    let _ = app_for_read.emit(
                        LOCAL_TRANSPORT_EVENT_NAME,
                        LocalTransportEvent {
                            session_id: read_session_id.clone(),
                            kind: "close".to_string(),
                            text: None,
                            binary_base64: None,
                            code: frame.as_ref().map(|value| value.code.into()),
                            reason: frame.as_ref().map(|value| value.reason.to_string()),
                            error: None,
                        },
                    );
                    break;
                }
                Ok(Message::Ping(_)) | Ok(Message::Pong(_)) => {}
                Ok(Message::Frame(_)) => {}
                Err(error) => {
                    let _ = app_for_read.emit(
                        LOCAL_TRANSPORT_EVENT_NAME,
                        LocalTransportEvent {
                            session_id: read_session_id.clone(),
                            kind: "error".to_string(),
                            text: None,
                            binary_base64: None,
                            code: None,
                            reason: None,
                            error: Some(error.to_string()),
                        },
                    );
                    break;
                }
            }
        }

        if let Ok(mut sessions) = sessions_for_read.lock() {
            sessions.remove(&read_session_id);
        }
    });

    let sessions_for_write = Arc::clone(&transport_state.sessions);
    let write_session_id = session_id.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(message) = receiver.recv().await {
            if write.send(message).await.is_err() {
                let _ = app_for_write.emit(
                    LOCAL_TRANSPORT_EVENT_NAME,
                    LocalTransportEvent {
                        session_id: write_session_id.clone(),
                        kind: "error".to_string(),
                        text: None,
                        binary_base64: None,
                        code: None,
                        reason: None,
                        error: Some("Local transport write failed.".to_string()),
                    },
                );
                break;
            }
        }
        if let Ok(mut sessions) = sessions_for_write.lock() {
            sessions.remove(&write_session_id);
        }
    });

    Ok(session_id)
}

#[tauri::command]
pub async fn open_local_daemon_transport(
    app: AppHandle,
    transport_state: State<'_, LocalTransportState>,
    transport_type: String,
    transport_path: String,
) -> Result<String, String> {
    let session_id = transport_state.alloc_session_id();
    let _ = app;
    match transport_type.as_str() {
        "pipe" => {
            #[cfg(windows)]
            {
                let ws_stream = connect_local_pipe(transport_path)
                    .await
                    .map_err(|error| format!("Failed to connect to local daemon pipe: {error}"))?;
                spawn_local_transport_session(app, transport_state, session_id, ws_stream).await
            }
            #[cfg(not(windows))]
            {
                Err(tokio_tungstenite::tungstenite::Error::Io(io::Error::new(
                    io::ErrorKind::Unsupported,
                    "Local pipe transport is only available on Windows.",
                ))
                .to_string())
            }
        }
        "socket" => {
            #[cfg(unix)]
            {
                let ws_stream = connect_local_socket(PathBuf::from(transport_path))
                    .await
                    .map_err(|error| {
                        format!("Failed to connect to local daemon socket: {error}")
                    })?;
                spawn_local_transport_session(app, transport_state, session_id, ws_stream).await
            }
            #[cfg(not(unix))]
            {
                Err(tokio_tungstenite::tungstenite::Error::Io(io::Error::new(
                    io::ErrorKind::Unsupported,
                    "Local socket transport is only available on Unix platforms.",
                ))
                .to_string())
            }
        }
        other => Err(format!("Unsupported local transport type: {other}")),
    }
}

#[tauri::command]
pub async fn send_local_daemon_transport_message(
    transport_state: State<'_, LocalTransportState>,
    session_id: String,
    text: Option<String>,
    binary_base64: Option<String>,
) -> Result<(), String> {
    let sessions = transport_state
        .sessions
        .lock()
        .map_err(|_| "Local transport session lock poisoned.".to_string())?;
    let session = sessions
        .get(&session_id)
        .ok_or_else(|| format!("Local transport session not found: {session_id}"))?;
    if let Some(text) = text {
        session
            .sender
            .send(Message::Text(text.into()))
            .map_err(|_| "Local transport session is closed.".to_string())?;
        return Ok(());
    }
    if let Some(binary_base64) = binary_base64 {
        let bytes = BASE64_STANDARD
            .decode(binary_base64.as_bytes())
            .map_err(|error| format!("Failed to decode local transport payload: {error}"))?;
        session
            .sender
            .send(Message::Binary(bytes.into()))
            .map_err(|_| "Local transport session is closed.".to_string())?;
        return Ok(());
    }
    Err("Local transport send requires text or binary payload.".to_string())
}

#[tauri::command]
pub async fn close_local_daemon_transport(
    transport_state: State<'_, LocalTransportState>,
    session_id: String,
) -> Result<(), String> {
    let mut sessions = transport_state
        .sessions
        .lock()
        .map_err(|_| "Local transport session lock poisoned.".to_string())?;
    let session = sessions
        .remove(&session_id)
        .ok_or_else(|| format!("Local transport session not found: {session_id}"))?;
    session
        .sender
        .send(Message::Close(None))
        .map_err(|_| "Local transport session is already closed.".to_string())?;
    Ok(())
}
