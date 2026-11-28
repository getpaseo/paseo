//! Global shortcuts on Wayland, through the desktop portal.
//!
//! A Wayland client cannot grab keys for itself, so `xdg-desktop-portal` does it:
//! the app opens a session on `org.freedesktop.portal.GlobalShortcuts`, asks for
//! the shortcuts it wants, and the desktop (GNOME, KDE and others) binds them,
//! asking the user first where it needs to. A press arrives as the portal's
//! `Activated` signal. The desktop owns the final key, so the user can move it.

use std::collections::HashMap;
use std::sync::mpsc::{channel, Sender};
use std::sync::OnceLock;
use std::thread;

use zbus::blocking::{Connection, Proxy};
use zbus::zvariant::{ObjectPath, OwnedValue, Value};

const DESTINATION: &str = "org.freedesktop.portal.Desktop";
const PATH: &str = "/org/freedesktop/portal/desktop";
const INTERFACE: &str = "org.freedesktop.portal.GlobalShortcuts";

/// Where a press is sent from the thread the portal's signal arrives on.
pub static ACTIVATED_HANDLER: OnceLock<Box<dyn Fn(String) + Send + Sync>> = OnceLock::new();

/// Where a refusal the portal reports after the fact is sent: `(id, reason)`.
pub static FAILURE_HANDLER: OnceLock<Box<dyn Fn(String, String) + Send + Sync>> = OnceLock::new();

/// One shortcut to ask the portal for.
pub struct Binding {
    pub id: String,
    pub description: String,
    /// The preferred key, in the portal's spelling (`ALT+space`).
    pub trigger: String,
}

/// A connection to the portal, which takes the shortcuts to bind.
pub struct Portal {
    commands: Sender<Vec<Binding>>,
}

impl Portal {
    /// Replaces what is bound with `bindings`.
    pub fn set(&self, bindings: Vec<Binding>) {
        let _ = self.commands.send(bindings);
    }
}

fn report(id: &str, reason: &str) {
    if let Some(handler) = FAILURE_HANDLER.get() {
        handler(id.to_string(), reason.to_string());
    }
}

/// Connects to the portal, or says why it cannot.
pub fn start(app_id: &str) -> Result<Portal, String> {
    let connection = Connection::session().map_err(|error| error.to_string())?;
    let proxy =
        Proxy::new(&connection, DESTINATION, PATH, INTERFACE).map_err(|error| error.to_string())?;
    let _version: u32 = proxy
        .get_property("version")
        .map_err(|_| "this desktop has no GlobalShortcuts portal".to_string())?;
    register_app_id(&connection, app_id);

    let listening = connection.clone();
    thread::Builder::new()
        .name("rn-gpui-portal-shortcuts".into())
        .spawn(move || listen(listening))
        .map_err(|error| error.to_string())?;
    let (commands, receiver) = channel();
    thread::Builder::new()
        .name("rn-gpui-portal-bind".into())
        .spawn(move || bind_loop(connection, receiver))
        .map_err(|error| error.to_string())?;
    Ok(Portal { commands })
}

/// Tells the portal which app this is. A process that was not started through a
/// desktop file has no identity for it otherwise, and the portal refuses
/// shortcuts to an app it cannot name. The portal knows an app by an installed
/// desktop file called `<app id>.desktop`, so when there is none one is written
/// for the user, once. A sandbox gives the app its id itself, so there the call is
/// not needed, and an older portal does not have it.
fn register_app_id(connection: &Connection, app_id: &str) {
    if app_id.is_empty() || std::env::var_os("FLATPAK_ID").is_some() {
        return;
    }
    let register = || {
        connection.call_method(
            Some(DESTINATION),
            PATH,
            Some("org.freedesktop.host.portal.Registry"),
            "Register",
            &(app_id, HashMap::<&str, Value>::new()),
        )
    };
    let Err(error) = register() else {
        return;
    };
    if error.to_string().contains("App info not found") && write_desktop_file(app_id) {
        if let Err(error) = register() {
            log::warn!("[desktop] could not register {app_id:?} with the portal: {error}");
        }
    } else {
        log::warn!("[desktop] could not register {app_id:?} with the portal: {error}");
    }
}

/// The text of a minimal desktop file for an app that is run from `exec`.
fn desktop_entry(name: &str, exec: &str) -> String {
    let exec = exec.replace('\\', "\\\\").replace('"', "\\\"");
    format!(
        "[Desktop Entry]\nType=Application\nName={name}\nExec=\"{exec}\"\nTerminal=false\nNoDisplay=true\n"
    )
}

/// Writes `<app id>.desktop` into the user's applications folder unless a desktop
/// file of that name is already installed somewhere. Returns whether one was
/// written.
fn write_desktop_file(app_id: &str) -> bool {
    let file_name = format!("{app_id}.desktop");
    let data_home = std::env::var_os("XDG_DATA_HOME")
        .map(std::path::PathBuf::from)
        .or_else(|| {
            std::env::var_os("HOME").map(|home| std::path::Path::new(&home).join(".local/share"))
        });
    let data_dirs = std::env::var("XDG_DATA_DIRS")
        .unwrap_or_else(|_| "/usr/local/share:/usr/share".to_string());
    let installed = data_home
        .iter()
        .cloned()
        .chain(data_dirs.split(':').map(std::path::PathBuf::from))
        .any(|dir| dir.join("applications").join(&file_name).exists());
    if installed {
        return false;
    }
    let Some(directory) = data_home.map(|dir| dir.join("applications")) else {
        return false;
    };
    // An AppImage's own path is stable, while the executable's is a mount that
    // changes on every run.
    let executable = std::env::var_os("APPIMAGE")
        .map(std::path::PathBuf::from)
        .or_else(|| std::env::current_exe().ok());
    let Some(executable) = executable else {
        return false;
    };
    let name = executable
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or(app_id);
    let entry = desktop_entry(name, &executable.to_string_lossy());
    std::fs::create_dir_all(&directory).is_ok()
        && std::fs::write(directory.join(file_name), entry).is_ok()
}

fn listen(connection: Connection) {
    let Ok(proxy) = Proxy::new(&connection, DESTINATION, PATH, INTERFACE) else {
        return;
    };
    let Ok(signals) = proxy.receive_signal("Activated") else {
        return;
    };
    for message in signals {
        let body = message.body();
        let Ok((_session, id, _time, _options)) =
            body.deserialize::<(ObjectPath, String, u64, HashMap<String, OwnedValue>)>()
        else {
            continue;
        };
        if let Some(handler) = ACTIVATED_HANDLER.get() {
            handler(id);
        }
    }
}

fn bind_loop(connection: Connection, receiver: std::sync::mpsc::Receiver<Vec<Binding>>) {
    let mut session: Option<String> = None;
    let mut serial = 0u32;
    while let Ok(mut bindings) = receiver.recv() {
        // Only the newest list matters when several queued up.
        while let Ok(newer) = receiver.try_recv() {
            bindings = newer;
        }
        if let Some(path) = session.take() {
            close(&connection, &path);
        }
        if bindings.is_empty() {
            continue;
        }
        serial += 1;
        match bind(&connection, &bindings, serial) {
            Ok((path, refused)) => {
                session = Some(path);
                for id in refused {
                    report(&id, "the desktop did not bind this shortcut");
                }
            }
            Err(reason) => {
                for binding in &bindings {
                    report(&binding.id, &reason);
                }
            }
        }
    }
}

fn close(connection: &Connection, session: &str) {
    let _ = connection.call_method(
        Some(DESTINATION),
        session,
        Some("org.freedesktop.portal.Session"),
        "Close",
        &(),
    );
}

/// Opens a session and binds the shortcuts in it; returns the session and the ids
/// the portal left unbound.
fn bind(
    connection: &Connection,
    bindings: &[Binding],
    serial: u32,
) -> Result<(String, Vec<String>), String> {
    let proxy =
        Proxy::new(connection, DESTINATION, PATH, INTERFACE).map_err(|error| error.to_string())?;

    let created = request(connection, &format!("create{serial}"), |token| {
        let mut options = HashMap::<&str, Value>::new();
        options.insert("handle_token", Value::from(token.to_string()));
        options.insert(
            "session_handle_token",
            Value::from(format!("rngpui_session_{serial}")),
        );
        proxy.call_method("CreateSession", &(options,))
    })?;
    let session: String = created
        .get("session_handle")
        .and_then(|value| String::try_from(value.try_clone().ok()?).ok())
        .ok_or_else(|| "the portal gave no session".to_string())?;

    let shortcuts: Vec<(String, HashMap<&str, Value>)> = bindings
        .iter()
        .map(|binding| {
            let mut details = HashMap::<&str, Value>::new();
            details.insert("description", Value::from(binding.description.clone()));
            details.insert("preferred_trigger", Value::from(binding.trigger.clone()));
            (binding.id.clone(), details)
        })
        .collect();
    let session_path = ObjectPath::try_from(session.as_str()).map_err(|error| error.to_string())?;
    let bound = request(connection, &format!("bind{serial}"), |token| {
        let mut options = HashMap::<&str, Value>::new();
        options.insert("handle_token", Value::from(token.to_string()));
        proxy.call_method(
            "BindShortcuts",
            &(session_path.clone(), shortcuts.clone(), "", options),
        )
    });
    let bound = match bound {
        Ok(bound) => bound,
        Err(reason) => {
            close(connection, &session);
            return Err(reason);
        }
    };
    let granted: Option<Vec<(String, HashMap<String, OwnedValue>)>> = bound
        .get("shortcuts")
        .and_then(|value| value.try_clone().ok())
        .and_then(|value| value.try_into().ok());
    let refused = match granted {
        Some(granted) => bindings
            .iter()
            .filter(|binding| !granted.iter().any(|(id, _)| *id == binding.id))
            .map(|binding| binding.id.clone())
            .collect(),
        None => Vec::new(),
    };
    Ok((session, refused))
}

/// Makes one portal request and waits for its `Response`. The signal is listened
/// for before the call, because the portal can answer before the call returns.
fn request(
    connection: &Connection,
    label: &str,
    call: impl FnOnce(&str) -> zbus::Result<zbus::Message>,
) -> Result<HashMap<String, OwnedValue>, String> {
    let token = format!("rngpui_{label}");
    let sender = connection
        .unique_name()
        .map(|name| name.as_str().trim_start_matches(':').replace('.', "_"))
        .ok_or_else(|| "no D-Bus name".to_string())?;
    let path = format!("/org/freedesktop/portal/desktop/request/{sender}/{token}");
    let proxy = Proxy::new(
        connection,
        DESTINATION,
        path,
        "org.freedesktop.portal.Request",
    )
    .map_err(|error| error.to_string())?;
    let mut responses = proxy
        .receive_signal("Response")
        .map_err(|error| error.to_string())?;
    call(&token).map_err(|error| error.to_string())?;
    let message = responses
        .next()
        .ok_or_else(|| "the portal did not answer".to_string())?;
    let body = message.body();
    let (code, results): (u32, HashMap<String, OwnedValue>) =
        body.deserialize().map_err(|error| error.to_string())?;
    match code {
        0 => Ok(results),
        1 => Err("the shortcut was declined".to_string()),
        _ => Err("the desktop could not bind the shortcut".to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_desktop_file_names_the_app_and_how_to_run_it() {
        let entry = desktop_entry("My App", "/opt/my app/bin");
        assert!(entry.starts_with("[Desktop Entry]\n"));
        assert!(entry.contains("Name=My App\n"));
        assert!(entry.contains("Exec=\"/opt/my app/bin\"\n"));
    }
}
