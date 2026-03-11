use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Emitter};

static NEXT_ID: AtomicU32 = AtomicU32::new(1);
static PENDING_ROUTES: OnceLock<Mutex<HashMap<u32, serde_json::Value>>> = OnceLock::new();
static APP_HANDLE: OnceLock<AppHandle> = OnceLock::new();

fn pending_routes() -> &'static Mutex<HashMap<u32, serde_json::Value>> {
    PENDING_ROUTES.get_or_init(|| Mutex::new(HashMap::new()))
}

fn next_notification_id() -> u32 {
    NEXT_ID.fetch_add(1, Ordering::Relaxed)
}

fn emit_notification_clicked(route_data: serde_json::Value) {
    if let Some(app) = APP_HANDLE.get() {
        let _ = app.emit("notification-clicked", route_data);
    }
}

#[tauri::command]
pub async fn send_desktop_notification(
    title: String,
    body: Option<String>,
    route_data: Option<serde_json::Value>,
) -> Result<u32, String> {
    let id = next_notification_id();

    if let Some(data) = &route_data {
        pending_routes()
            .lock()
            .map_err(|e| format!("Lock error: {e}"))?
            .insert(id, data.clone());
    }

    platform::send_notification(id, &title, body.as_deref())?;

    Ok(id)
}

pub fn init_notification_delegate(app: &AppHandle) {
    let _ = APP_HANDLE.set(app.clone());
    platform::init_delegate();
}

fn handle_notification_click(id: u32) {
    let route_data = pending_routes()
        .lock()
        .ok()
        .and_then(|mut map| map.remove(&id));

    if let Some(data) = route_data {
        emit_notification_clicked(data);
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use super::*;
    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2::runtime::ProtocolObject;
    use objc2::{define_class, msg_send, AllocAnyThread};
    use objc2_foundation::{NSObject, NSObjectProtocol, NSString};
    use objc2_user_notifications::{
        UNMutableNotificationContent, UNNotificationRequest, UNNotificationResponse,
        UNUserNotificationCenter, UNUserNotificationCenterDelegate,
    };
    use std::sync::OnceLock;

    static DELEGATE: OnceLock<Retained<NotificationDelegate>> = OnceLock::new();

    define_class!(
        // SAFETY: NSObject has no subclassing requirements.
        #[unsafe(super(NSObject))]
        #[thread_kind = AllocAnyThread]
        #[name = "PaseoNotificationDelegate"]
        struct NotificationDelegate;

        unsafe impl NSObjectProtocol for NotificationDelegate {}

        unsafe impl UNUserNotificationCenterDelegate for NotificationDelegate {
            #[unsafe(method(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:))]
            fn did_receive_response(
                &self,
                _center: &UNUserNotificationCenter,
                response: &UNNotificationResponse,
                completion_handler: &block2::DynBlock<dyn Fn()>,
            ) {
                let id_str = response.notification().request().identifier().to_string();
                if let Ok(id) = id_str.parse::<u32>() {
                    handle_notification_click(id);
                }
                completion_handler.call(());
            }
        }
    );

    impl NotificationDelegate {
        fn new() -> Retained<Self> {
            let this = Self::alloc().set_ivars(());
            unsafe { msg_send![super(this), init] }
        }
    }

    pub fn init_delegate() {
        DELEGATE.get_or_init(|| {
            let delegate = NotificationDelegate::new();
            let center = UNUserNotificationCenter::currentNotificationCenter();
            center.setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
            delegate
        });
    }

    pub fn send_notification(id: u32, title: &str, body: Option<&str>) -> Result<(), String> {
        unsafe {
            let content = UNMutableNotificationContent::new();
            content.setTitle(&NSString::from_str(title));
            if let Some(body_text) = body {
                content.setBody(&NSString::from_str(body_text));
            }

            let identifier = NSString::from_str(&id.to_string());
            let request = UNNotificationRequest::requestWithIdentifier_content_trigger(
                &identifier,
                &content,
                None,
            );

            let center = UNUserNotificationCenter::currentNotificationCenter();

            let (tx, rx) = std::sync::mpsc::channel::<Result<(), String>>();
            let handler = RcBlock::new(move |error: *mut objc2_foundation::NSError| {
                if error.is_null() {
                    let _ = tx.send(Ok(()));
                } else {
                    let desc = (*error).localizedDescription();
                    let _ = tx.send(Err(desc.to_string()));
                }
            });

            center.addNotificationRequest_withCompletionHandler(&request, Some(&handler));

            rx.recv()
                .map_err(|e| format!("Notification send channel error: {e}"))?
        }
    }
}

#[cfg(target_os = "linux")]
mod platform {
    use super::*;

    pub fn init_delegate() {}

    pub fn send_notification(id: u32, title: &str, body: Option<&str>) -> Result<(), String> {
        let mut notification = notify_rust::Notification::new();
        notification.summary(title);
        if let Some(body_text) = body {
            notification.body(body_text);
        }
        notification.action("default", "default");

        let handle = notification
            .show()
            .map_err(|e| format!("Failed to show notification: {e}"))?;

        std::thread::spawn(move || {
            handle.wait_for_action(|action| {
                if action == "default" {
                    handle_notification_click(id);
                }
            });
        });

        Ok(())
    }
}

#[cfg(windows)]
mod platform {
    use super::*;
    use tauri_winrt_notification::Toast;

    pub fn init_delegate() {}

    pub fn send_notification(id: u32, title: &str, body: Option<&str>) -> Result<(), String> {
        Toast::new(Toast::POWERSHELL_APP_ID)
            .title(title)
            .text1(body.unwrap_or_default())
            .on_activated(move |_action| {
                handle_notification_click(id);
                Ok(())
            })
            .show()
            .map_err(|e| format!("Failed to show notification: {e}"))
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
mod platform {
    pub fn init_delegate() {}

    pub fn send_notification(_id: u32, _title: &str, _body: Option<&str>) -> Result<(), String> {
        Err("Notifications not supported on this platform".to_string())
    }
}
