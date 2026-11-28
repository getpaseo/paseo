//! Opt-in hooks a module registers from `rn_gpui_register()`.
//!
//! An app that links no module registering one sees no change: with nothing
//! registered each hook does nothing and windows open as they always did.

use crate::store::SurfaceRootView;
use gpui::{
    AnyView, AnyWindowHandle, App, AppContext, Context, Entity, Render, Subscription, Window,
    WindowOptions,
};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

type AppInit = Arc<dyn Fn(&mut App) + Send + Sync>;

pub(crate) type RootBuilder = Box<dyn FnOnce(&mut Window, &mut App) -> Entity<SurfaceRootView>>;

type RootOpener = Arc<
    dyn Fn(&mut App, WindowOptions, RootBuilder) -> anyhow::Result<AnyWindowHandle> + Send + Sync,
>;

static APP_INITS: Mutex<Vec<AppInit>> = Mutex::new(Vec::new());
static APP_INIT_DONE: AtomicBool = AtomicBool::new(false);
static ASSET_SOURCES: Mutex<Vec<Arc<dyn gpui::AssetSource>>> = Mutex::new(Vec::new());
static ROOT_OPENER: Mutex<Option<RootOpener>> = Mutex::new(None);

/// Registers `init` to run once, with the `App`, before the first window opens.
///
/// Called from a module's `rn_gpui_register()`. Several may be registered; they
/// run in registration order. Registering after the first window opened does
/// nothing.
pub fn register_app_init(init: Arc<dyn Fn(&mut App) + Send + Sync>) {
    APP_INITS
        .lock()
        .expect("app init registry poisoned")
        .push(init);
}

/// Registers a source of assets (icons, images by path) that the app loads
/// from, beside the ones registered before it: a path is loaded from the first
/// source that has it.
///
/// Called from a module's `rn_gpui_register()`. Assets are read when the
/// application starts, so a source registered later is not used.
pub fn register_asset_source(source: impl gpui::AssetSource + 'static) {
    ASSET_SOURCES
        .lock()
        .expect("asset source registry poisoned")
        .push(Arc::new(source));
}

struct CombinedAssets(Vec<Arc<dyn gpui::AssetSource>>);

impl gpui::AssetSource for CombinedAssets {
    fn load(&self, path: &str) -> anyhow::Result<Option<std::borrow::Cow<'static, [u8]>>> {
        for source in &self.0 {
            if let Some(asset) = source.load(path)? {
                return Ok(Some(asset));
            }
        }
        Ok(None)
    }

    fn list(&self, path: &str) -> anyhow::Result<Vec<gpui::SharedString>> {
        let mut all = Vec::new();
        for source in &self.0 {
            all.extend(source.list(path)?);
        }
        Ok(all)
    }
}

/// The application with the registered asset sources, when there are any.
pub(crate) fn with_registered_assets(application: gpui::Application) -> gpui::Application {
    match registered_assets() {
        Some(assets) => application.with_assets(assets),
        None => application,
    }
}

/// The registered asset sources as one, when there are any.
pub(crate) fn registered_assets() -> Option<impl gpui::AssetSource> {
    let sources = ASSET_SOURCES
        .lock()
        .expect("asset source registry poisoned")
        .clone();
    (!sources.is_empty()).then(|| CombinedAssets(sources))
}

/// Runs the registered app init hooks the first time it is called.
pub(crate) fn run_app_init(cx: &mut App) {
    if APP_INIT_DONE.swap(true, Ordering::SeqCst) {
        return;
    }
    let inits: Vec<AppInit> = APP_INITS
        .lock()
        .expect("app init registry poisoned")
        .clone();
    for init in inits {
        init(cx);
    }
}

/// Registers a wrapper for the root view of every window that hosts a React
/// tree (the main window, windows opened with `DesktopWindow.open` and tray
/// popovers).
///
/// `wrap` receives the root view that takes the React tree and returns the
/// view that becomes the window's root, typically one that holds the given
/// view as a child. Its type `V` is the window's root type, so a library that
/// looks the root up with `window.root::<V>()` finds it. A second call replaces
/// the first.
///
/// Called from a module's `rn_gpui_register()`.
pub fn register_root_wrapper<V: Render + 'static>(
    wrap: impl Fn(AnyView, &mut Window, &mut App) -> Entity<V> + Send + Sync + 'static,
) {
    let wrap = Arc::new(wrap);
    let opener: RootOpener = Arc::new(move |cx, options, build| {
        let wrap = wrap.clone();
        cx.open_window(options, move |window, cx| {
            let root = build(window, cx);
            wrap(root.into(), window, cx)
        })
        .map(Into::into)
    });
    *ROOT_OPENER.lock().expect("root wrapper registry poisoned") = Some(opener);
}

/// What window-level observers and hooks run against. Its window's root view
/// can be of any type once a root wrapper is registered, so they cannot use it.
pub(crate) struct WindowObservers;

/// Runs `f` with a context for observers that belong to a window, and returns
/// with it a subscription that keeps the context alive until it is dropped.
pub(crate) fn observer_context<R>(
    cx: &mut App,
    f: impl FnOnce(&mut Context<WindowObservers>) -> R,
) -> (R, Subscription) {
    let entity = cx.new(|_| WindowObservers);
    let result = entity.update(cx, |_, cx| f(cx));
    (result, Subscription::new(move || drop(entity)))
}

/// For one observer: its subscription, which also keeps the context alive.
pub(crate) fn observer_context_joined(
    cx: &mut App,
    f: impl FnOnce(&mut Context<WindowObservers>) -> Subscription,
) -> Subscription {
    let (subscription, keep_alive) = observer_context(cx, f);
    Subscription::new(move || {
        drop(subscription);
        drop(keep_alive);
    })
}

/// The same for observers that last as long as the app: the context is never
/// released.
pub(crate) fn observer_context_for_good<R>(
    cx: &mut App,
    f: impl FnOnce(&mut Context<WindowObservers>) -> R,
) -> R {
    let entity = cx.new(|_| WindowObservers);
    let result = entity.update(cx, |_, cx| f(cx));
    std::mem::forget(entity);
    result
}

/// Opens a window whose React root `build` makes, wrapped by the registered
/// root wrapper if there is one.
pub(crate) fn open_root_window(
    cx: &mut App,
    options: WindowOptions,
    build: impl FnOnce(&mut Window, &mut App) -> Entity<SurfaceRootView> + 'static,
) -> anyhow::Result<AnyWindowHandle> {
    let opener = ROOT_OPENER
        .lock()
        .expect("root wrapper registry poisoned")
        .clone();
    match opener {
        Some(opener) => opener(cx, options, Box::new(build)),
        None => cx.open_window(options, build).map(Into::into),
    }
}

#[cfg(test)]
pub(crate) static TEST_LOCK: Mutex<()> = Mutex::new(());

#[cfg(test)]
pub(crate) fn reset_for_test() {
    APP_INITS.lock().unwrap().clear();
    APP_INIT_DONE.store(false, Ordering::SeqCst);
    *ROOT_OPENER.lock().unwrap() = None;
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui::{div, IntoElement, ParentElement, TestAppContext};
    use std::sync::atomic::AtomicUsize;

    struct Wrapper {
        inner: AnyView,
    }

    impl Render for Wrapper {
        fn render(&mut self, _: &mut Window, _: &mut gpui::Context<Self>) -> impl IntoElement {
            div().child(self.inner.clone())
        }
    }

    fn build(window: &mut Window, cx: &mut App) -> Entity<SurfaceRootView> {
        let _ = window;
        cx.new(|_| SurfaceRootView::new(1))
    }

    #[gpui::test]
    fn without_a_wrapper_the_window_root_is_the_surface_root(cx: &mut TestAppContext) {
        let _guard = TEST_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        reset_for_test();
        let handle = cx
            .update(|cx| open_root_window(cx, WindowOptions::default(), build))
            .unwrap();
        let is_surface_root = cx
            .update(|cx| {
                handle.update(cx, |_, window, _| {
                    window.root::<SurfaceRootView>().flatten().is_some()
                })
            })
            .unwrap();
        assert!(is_surface_root);
    }

    #[gpui::test]
    fn a_registered_wrapper_becomes_the_window_root_and_holds_the_surface_root(
        cx: &mut TestAppContext,
    ) {
        let _guard = TEST_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        reset_for_test();
        let wrapped = Arc::new(AtomicUsize::new(0));
        let counter = wrapped.clone();
        register_root_wrapper(move |inner, _window, cx| {
            counter.fetch_add(1, Ordering::SeqCst);
            cx.new(|_| Wrapper { inner })
        });
        let handle = cx
            .update(|cx| open_root_window(cx, WindowOptions::default(), build))
            .unwrap();
        assert_eq!(wrapped.load(Ordering::SeqCst), 1);
        let (wrapper_is_root, surface_is_root) = cx
            .update(|cx| {
                handle.update(cx, |_, window, _| {
                    (
                        window.root::<Wrapper>().flatten().is_some(),
                        window.root::<SurfaceRootView>().flatten().is_some(),
                    )
                })
            })
            .unwrap();
        assert!(wrapper_is_root);
        assert!(!surface_is_root);
        reset_for_test();
    }

    #[gpui::test]
    fn app_init_hooks_run_once_in_order_and_nothing_registered_does_nothing(
        cx: &mut TestAppContext,
    ) {
        let _guard = TEST_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        reset_for_test();
        cx.update(run_app_init);
        let log = Arc::new(Mutex::new(Vec::new()));
        reset_for_test();
        for name in ["first", "second"] {
            let log = log.clone();
            register_app_init(Arc::new(move |_| log.lock().unwrap().push(name)));
        }
        cx.update(run_app_init);
        cx.update(run_app_init);
        assert_eq!(*log.lock().unwrap(), vec!["first", "second"]);
        reset_for_test();
    }
}
