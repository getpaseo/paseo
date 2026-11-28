//! Files dragged onto the window from the operating system.
//!
//! gpui turns such a drag into a stream of pressed mouse moves and a mouse up,
//! with the paths attached to the active drag. The window's root reads the
//! paths in the capture phase, the node under the pointer says which view that
//! is, and the nearest view that takes files (`acceptsFiles`) gets the
//! `onDragEnter`, `onDragOver`, `onDragLeave` and `onDrop` events.

use crate::events::Target;
use crate::store::StoreGlobal;
use gpui::{App, Pixels, Point, Window};
use serde_json::{json, Value};
use std::cell::RefCell;
use std::path::Path;

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct DroppedFile {
    pub path: String,
    pub name: String,
    pub size: u64,
    pub mime: String,
    pub is_directory: bool,
}

impl DroppedFile {
    pub(crate) fn from_path(path: &Path) -> Self {
        let metadata = std::fs::metadata(path).ok();
        let is_directory = metadata.as_ref().is_some_and(|metadata| metadata.is_dir());
        Self {
            path: path.to_string_lossy().into_owned(),
            name: path
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_default(),
            size: metadata
                .filter(|metadata| metadata.is_file())
                .map_or(0, |metadata| metadata.len()),
            mime: if is_directory {
                String::new()
            } else {
                mime_type(path).to_owned()
            },
            is_directory,
        }
    }

    fn json(&self) -> Value {
        json!({
            "path": self.path,
            "name": self.name,
            "size": self.size,
            "type": self.mime,
            "isDirectory": self.is_directory,
        })
    }
}

/// The media type for a file's extension, or an empty string when it has none
/// or is not a common one.
pub(crate) fn mime_type(path: &Path) -> &'static str {
    let extension = path
        .extension()
        .map(|extension| extension.to_string_lossy().to_ascii_lowercase());
    match extension.as_deref() {
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("svg") => "image/svg+xml",
        Some("bmp") => "image/bmp",
        Some("ico") => "image/x-icon",
        Some("avif") => "image/avif",
        Some("pdf") => "application/pdf",
        Some("zip") => "application/zip",
        Some("json") => "application/json",
        Some("txt") => "text/plain",
        Some("md" | "markdown") => "text/markdown",
        Some("csv") => "text/csv",
        Some("html" | "htm") => "text/html",
        Some("css") => "text/css",
        Some("js" | "mjs") => "text/javascript",
        Some("xml") => "application/xml",
        Some("mp3") => "audio/mpeg",
        Some("wav") => "audio/wav",
        Some("ogg") => "audio/ogg",
        Some("mp4") => "video/mp4",
        Some("webm") => "video/webm",
        Some("mov") => "video/quicktime",
        Some("doc") => "application/msword",
        Some("docx") => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        Some("xlsx") => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        Some("pptx") => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        _ => "",
    }
}

#[derive(Default)]
struct Drag {
    files: Vec<DroppedFile>,
    /// Whether the node under the pointer has reported for the move in progress.
    answered: bool,
    /// The view that takes the files the pointer is over.
    target: Option<i32>,
    /// The last node the pointer was over, for a leave sent after it moved off.
    last_target: Option<Target>,
    /// Where a drop landed, as the node under the pointer saw it.
    landing: Option<(Option<Target>, Point<Pixels>)>,
}

thread_local! {
    static DRAG: RefCell<Option<Drag>> = const { RefCell::new(None) };
}

/// Whether files from outside are being dragged over the window.
pub(crate) fn active() -> bool {
    DRAG.with_borrow(Option::is_some)
}

/// The window's root saw a move of the drag, ahead of every node.
pub(crate) fn moved(paths: &[std::path::PathBuf]) {
    DRAG.with_borrow_mut(|drag| {
        let drag = drag.get_or_insert_with(|| Drag {
            files: paths
                .iter()
                .map(|path| DroppedFile::from_path(path))
                .collect(),
            ..Drag::default()
        });
        drag.answered = false;
    });
}

/// The node under the pointer, if any, says which views the pointer is over.
pub(crate) fn over(
    window: &mut Window,
    cx: &mut App,
    target: Option<&Target>,
    position: Point<Pixels>,
) {
    DRAG.with_borrow_mut(|drag| {
        if let Some(drag) = drag {
            drag.answered = true;
        }
    });
    retarget(window, cx, target, position, true);
}

/// The press ended over `target`; the root delivers the drop once gpui does.
/// The node under the pointer reports first, and the views around it after it,
/// so the first report is the one that counts.
pub(crate) fn landing(target: Option<Target>, position: Point<Pixels>) {
    DRAG.with_borrow_mut(|drag| {
        if let Some(drag) = drag {
            if drag.landing.is_none() {
                drag.landing = Some((target, position));
            }
        }
    });
}

/// A move that no node answered: the pointer is over nothing that takes files.
pub(crate) fn left_unanswered(window: &mut Window, cx: &mut App, position: Point<Pixels>) {
    let unanswered = DRAG.with_borrow(|drag| drag.as_ref().is_some_and(|drag| !drag.answered));
    if unanswered {
        retarget(window, cx, None, position, false);
    }
}

/// The drag left the window or was cancelled.
pub(crate) fn exited(window: &mut Window, cx: &mut App) {
    if !active() {
        return;
    }
    retarget(
        window,
        cx,
        None,
        gpui::point(gpui::px(0.0), gpui::px(0.0)),
        false,
    );
    DRAG.with_borrow_mut(|drag| *drag = None);
}

/// The files were dropped: gpui delivered them to the root.
pub(crate) fn dropped(window: &mut Window, cx: &mut App) {
    let Some(drag) = DRAG.with_borrow_mut(Option::take) else {
        return;
    };
    let (target, position) = drag
        .landing
        .unwrap_or((None, gpui::point(gpui::px(0.0), gpui::px(0.0))));
    let accepting = target
        .as_ref()
        .and_then(|target| accepting_view(cx, target));
    if let (Some(target), Some(tag)) = (&target, accepting) {
        send(window, cx, "topDrop", tag, target, position, &drag.files);
    }
    if drag.target.is_some() {
        crate::interaction::set_drag(None, cx);
    }
}

fn retarget(
    window: &mut Window,
    cx: &mut App,
    target: Option<&Target>,
    position: Point<Pixels>,
    over: bool,
) {
    let accepting = target.and_then(|target| accepting_view(cx, target));
    let (previous, files, last) = DRAG.with_borrow_mut(|drag| {
        let Some(drag) = drag else {
            return (None, Vec::new(), None);
        };
        let previous = std::mem::replace(&mut drag.target, accepting);
        let last = drag.last_target.clone();
        if let Some(target) = target {
            drag.last_target = Some(target.clone());
        }
        (previous, drag.files.clone(), last)
    });
    if previous != accepting {
        if let (Some(tag), Some(target)) = (previous, target.or(last.as_ref())) {
            send(window, cx, "topDragLeave", tag, target, position, &files);
        }
        if let (Some(tag), Some(target)) = (accepting, target) {
            send(window, cx, "topDragEnter", tag, target, position, &files);
        }
        crate::interaction::set_drag(accepting, cx);
    }
    if let (true, Some(tag), Some(target)) = (over, accepting, target) {
        send(window, cx, "topDragOver", tag, target, position, &files);
    }
}

/// The nearest view on the path, the hit view first, that takes files.
fn accepting_view(cx: &App, target: &Target) -> Option<i32> {
    let store = cx.try_global::<StoreGlobal>()?.0.read(cx);
    target.chain.iter().copied().find(|tag| {
        store
            .nodes
            .get(tag)
            .is_some_and(|node| node.read(cx).accepts_files())
    })
}

fn send(
    window: &mut Window,
    cx: &mut App,
    name: &str,
    tag: i32,
    target: &Target,
    position: Point<Pixels>,
    files: &[DroppedFile],
) {
    let Some(store) = cx.try_global::<StoreGlobal>().map(|store| store.0.clone()) else {
        return;
    };
    let page = target.page(position);
    let local = target.local_position(page);
    let payload = json!({
        "target": tag,
        "x": f32::from(local.x),
        "y": f32::from(local.y),
        "pageX": f32::from(page.x),
        "pageY": f32::from(page.y),
        "files": files.iter().map(DroppedFile::json).collect::<Vec<_>>(),
    });
    let store = store.read(cx);
    store.host.dispatch_event(tag, name, &payload);
    store.frame_hook.arm(window);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_common_extension_has_a_media_type() {
        assert_eq!(mime_type(Path::new("/a/photo.JPG")), "image/jpeg");
        assert_eq!(mime_type(Path::new("notes.md")), "text/markdown");
        assert_eq!(mime_type(Path::new("archive")), "");
        assert_eq!(mime_type(Path::new("a.unknownext")), "");
    }

    #[test]
    fn a_file_reports_its_name_size_and_type() {
        let dir = std::env::temp_dir().join(format!("rn-gpui-drop-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("hello.txt");
        std::fs::write(&file, b"hello").unwrap();
        let info = DroppedFile::from_path(&file);
        assert_eq!(info.name, "hello.txt");
        assert_eq!(info.size, 5);
        assert_eq!(info.mime, "text/plain");
        assert!(!info.is_directory);
        let folder = DroppedFile::from_path(&dir);
        assert!(folder.is_directory);
        assert_eq!(folder.size, 0);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
