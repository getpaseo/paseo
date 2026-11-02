//! Host components: a Rust type that renders one Fabric node's content.
//!
//! A package writes a codegen spec and implements the trait
//! `@react-native-gpui/codegen` generates from it:
//!
//! ```ignore
//! rn_gpui_module::include_specs!();
//!
//! impl FixtureChartSpec for Chart {
//!     fn create(props: &FixtureChartProps, cx: &mut FixtureChartContext) -> Self { .. }
//!     fn update(&mut self, props: &FixtureChartProps, changed: FixtureChartChanged,
//!               cx: &mut FixtureChartContext) { .. }
//!     fn render(&mut self, props: &FixtureChartProps, window: &mut Window,
//!               cx: &mut FixtureChartContext) -> AnyElement { .. }
//! }
//!
//! pub fn rn_gpui_register() {
//!     react_native_gpui::host_component::register_component(fixture_chart_component::<Chart>());
//! }
//! ```
//!
//! This module holds the machinery every component shares: the props and
//! emitter handles, the registry, the report queue and command arguments.

use crate::extensions::StoreHandle;
use gpui::{AnyElement, Window};
pub use serde_json::Value;
use std::cell::{Cell, RefCell};
use std::marker::PhantomData;
use std::rc::Rc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};

/// The padding a container's chrome needs around React's children.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct EdgeInsets {
    pub top: f32,
    pub right: f32,
    pub bottom: f32,
    pub left: f32,
}

impl EdgeInsets {
    /// No chrome: React's children fill the node.
    pub const ZERO: Self = Self {
        top: 0.0,
        right: 0.0,
        bottom: 0.0,
        left: 0.0,
    };
}

/// One thing a host component reported from a method, waiting to be applied.
pub(crate) enum HostReport {
    /// The size a measured component wants, in DIPs.
    Size { tag: i32, width: f32, height: f32 },
    /// The padding a container's chrome needs around React's children.
    Insets {
        tag: i32,
        top: f32,
        right: f32,
        bottom: f32,
        left: f32,
    },
    /// A typed event for the node's JS emitter. The closure owns the payload and
    /// calls the generated shim, so nothing is built as JSON on the way.
    Event { tag: i32, send: Box<dyn FnOnce()> },
}

impl std::fmt::Debug for HostReport {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Size { tag, width, height } => f
                .debug_struct("Size")
                .field("tag", tag)
                .field("width", width)
                .field("height", height)
                .finish(),
            Self::Insets {
                tag,
                top,
                right,
                bottom,
                left,
            } => f
                .debug_struct("Insets")
                .field("tag", tag)
                .field("top", top)
                .field("right", right)
                .field("bottom", bottom)
                .field("left", left)
                .finish(),
            Self::Event { tag, .. } => f.debug_struct("Event").field("tag", tag).finish(),
        }
    }
}

/// The reports every host component method produced since the last delivery.
#[derive(Default)]
pub(crate) struct HostReports {
    reports: RefCell<Vec<HostReport>>,
    flush_scheduled: Cell<bool>,
}

impl HostReports {
    pub(crate) fn push(&self, report: HostReport) {
        self.reports.borrow_mut().push(report);
    }

    /// Every report queued so far, oldest first.
    pub(crate) fn take(&self) -> Vec<HostReport> {
        std::mem::take(&mut self.reports.borrow_mut())
    }

    /// Whether there is nothing to deliver.
    pub(crate) fn is_empty(&self) -> bool {
        self.reports.borrow().is_empty()
    }

    /// Claims the frame's delivery, returning whether one was already claimed.
    pub(crate) fn claim_flush(&self) -> bool {
        self.flush_scheduled.replace(true)
    }

    /// Allows the next report to schedule a delivery again.
    pub(crate) fn release_flush(&self) {
        self.flush_scheduled.set(false);
    }
}

impl std::fmt::Debug for HostReports {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HostReports")
            .field("reports", &self.reports.borrow().len())
            .field("flush_scheduled", &self.flush_scheduled.get())
            .finish()
    }
}

/// The store's report queue, shared by every node it owns.
pub(crate) type HostReportQueue = Rc<HostReports>;

/// An owned reference to a node's Fabric props: a C++ `shared_ptr<const Props>`
/// behind an opaque address.
pub struct PropsHandle {
    raw: usize,
    /// Props are read on the main thread only. A handle is not `Send`, so a
    /// borrow of its fields cannot outlive the thread that may free them.
    _main_thread: PhantomData<*const ()>,
}

impl PropsHandle {
    /// Takes ownership of the handle a mount op carried.
    ///
    /// # Safety
    ///
    /// `raw` must be a non-zero handle C++ created for this op and that nothing
    /// else owns.
    pub(crate) unsafe fn from_raw(raw: usize) -> Self {
        Self {
            raw,
            _main_thread: PhantomData,
        }
    }

    /// The address the generated accessors take.
    pub fn as_ptr(&self) -> *const core::ffi::c_void {
        self.raw as *const core::ffi::c_void
    }

    /// A handle that owns nothing, for a unit test that drives a component
    /// without Fabric behind it. Reading a prop through it is a test bug.
    pub fn for_test() -> Self {
        Self {
            raw: 0,
            _main_thread: PhantomData,
        }
    }
}

/// A handle value a unit test puts on a mount op. It points at nothing, so
/// dropping a handle that holds it must not release anything. Real handles are
/// heap addresses, which are never odd.
#[cfg(test)]
pub(crate) const TEST_HANDLE: usize = 1;

fn releases(raw: usize) -> bool {
    #[cfg(test)]
    if raw == TEST_HANDLE {
        return false;
    }
    raw != 0
}

impl Drop for PropsHandle {
    fn drop(&mut self) {
        if releases(self.raw) {
            rn_gpui_sys::ffi::releaseHostPropsHandle(self.raw);
        }
    }
}

impl std::fmt::Debug for PropsHandle {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "PropsHandle({:#x})", self.raw)
    }
}

struct EmitterOwner(usize);

impl Drop for EmitterOwner {
    fn drop(&mut self) {
        if releases(self.0) {
            rn_gpui_sys::ffi::releaseHostEmitterHandle(self.0);
        }
    }
}

/// A shared reference to a node's Fabric event emitter.
#[derive(Clone)]
pub struct EmitterHandle(Rc<EmitterOwner>);

impl EmitterHandle {
    /// Takes ownership of the handle a `Create` op carried.
    ///
    /// # Safety
    ///
    /// `raw` must be a handle C++ created for this op, or zero, and nothing else
    /// may own it.
    pub(crate) unsafe fn from_raw(raw: usize) -> Self {
        Self(Rc::new(EmitterOwner(raw)))
    }

    /// The address the generated event shims take.
    pub fn as_ptr(&self) -> *const core::ffi::c_void {
        self.0 .0 as *const core::ffi::c_void
    }

    /// An emitter that owns nothing, for a unit test.
    pub fn for_test() -> Self {
        Self(Rc::new(EmitterOwner(0)))
    }
}

impl std::fmt::Debug for EmitterHandle {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "EmitterHandle({:#x})", self.0 .0)
    }
}

/// One argument of a command, already validated against the spec by the
/// generated C++ dispatcher.
#[derive(Clone, Debug, PartialEq)]
pub enum HostArg {
    Number(f64),
    Bool(bool),
    String(String),
    Numbers(Vec<f64>),
    Bools(Vec<bool>),
    Strings(Vec<String>),
}

impl HostArg {
    /// Converts the argument the generated C++ dispatcher built. `kind` says
    /// which field of the bridge struct holds it.
    pub(crate) fn from_ffi(arg: rn_gpui_sys::ffi::HostCommandArg) -> Self {
        match arg.kind {
            0 => Self::Number(arg.number),
            1 => Self::Bool(arg.number != 0.0),
            2 => Self::String(arg.text),
            3 => Self::Numbers(arg.numbers),
            4 => Self::Bools(arg.numbers.iter().map(|value| *value != 0.0).collect()),
            5 => Self::Strings(arg.texts),
            other => {
                log::error!("[host-component] unknown command argument kind {other}");
                Self::Number(0.0)
            }
        }
    }

    pub fn to_i32(&self) -> i32 {
        match self {
            Self::Number(value) => *value as i32,
            Self::Bool(value) => i32::from(*value),
            _ => 0,
        }
    }

    pub fn to_f32(&self) -> f32 {
        self.to_f64() as f32
    }

    pub fn to_f64(&self) -> f64 {
        match self {
            Self::Number(value) => *value,
            Self::Bool(value) => f64::from(u8::from(*value)),
            _ => 0.0,
        }
    }

    pub fn to_bool(&self) -> bool {
        match self {
            Self::Bool(value) => *value,
            Self::Number(value) => *value != 0.0,
            _ => false,
        }
    }

    pub fn to_string_value(&self) -> String {
        match self {
            Self::String(value) => value.clone(),
            _ => String::new(),
        }
    }

    pub fn to_i32_vec(&self) -> Vec<i32> {
        match self {
            Self::Numbers(values) => values.iter().map(|value| *value as i32).collect(),
            _ => Vec::new(),
        }
    }

    pub fn to_f32_vec(&self) -> Vec<f32> {
        match self {
            Self::Numbers(values) => values.iter().map(|value| *value as f32).collect(),
            _ => Vec::new(),
        }
    }

    pub fn to_f64_vec(&self) -> Vec<f64> {
        match self {
            Self::Numbers(values) => values.clone(),
            _ => Vec::new(),
        }
    }

    pub fn to_bool_vec(&self) -> Vec<bool> {
        match self {
            Self::Bools(values) => values.clone(),
            _ => Vec::new(),
        }
    }

    pub fn to_string_vec(&self) -> Vec<String> {
        match self {
            Self::Strings(values) => values.clone(),
            _ => Vec::new(),
        }
    }
}

/// What a host component is given besides its props.
pub struct HostContext {
    /// The Fabric tag of the node. A command, an event or a measurement is
    /// always about this node.
    pub tag: i32,
    /// Core's handle to the store, for waking Fabric from a command.
    handle: Option<StoreHandle>,
    /// The size this call reported, if any, for a caller that reads it back.
    pending_size: Option<(f32, f32)>,
    /// The insets this call reported, if any: the padding a container's chrome
    /// needs around React's children.
    pending_insets: Option<EdgeInsets>,
    queue: HostReportQueue,
}

impl HostContext {
    /// A context for a component core is driving: `queue` is the store's report
    /// queue.
    pub(crate) fn queued(tag: i32, queue: HostReportQueue) -> Self {
        Self {
            tag,
            handle: None,
            pending_size: None,
            pending_insets: None,
            queue,
        }
    }

    /// The same, with the store handle a command can act through.
    pub(crate) fn queued_with_handle(
        tag: i32,
        queue: HostReportQueue,
        handle: StoreHandle,
    ) -> Self {
        Self {
            handle: Some(handle),
            ..Self::queued(tag, queue)
        }
    }

    /// Reports the size this component wants, in DIPs.
    pub fn set_intrinsic_size(&mut self, width: f32, height: f32) {
        let (width, height) = (width.max(0.0), height.max(0.0));
        self.queue.push(HostReport::Size {
            tag: self.tag,
            width,
            height,
        });
        self.pending_size = Some((width, height));
    }

    /// The size last reported, if this call reported one.
    pub fn intrinsic_size(&self) -> Option<(f32, f32)> {
        self.pending_size
    }

    /// Reports the padding this container's chrome needs around React's
    /// children, in DIPs.
    pub fn set_insets(&mut self, top: f32, right: f32, bottom: f32, left: f32) {
        let insets = EdgeInsets {
            top: top.max(0.0),
            right: right.max(0.0),
            bottom: bottom.max(0.0),
            left: left.max(0.0),
        };
        self.queue.push(HostReport::Insets {
            tag: self.tag,
            top: insets.top,
            right: insets.right,
            bottom: insets.bottom,
            left: insets.left,
        });
        self.pending_insets = Some(insets);
    }

    /// The insets last reported, if this call reported any.
    pub fn insets(&self) -> Option<EdgeInsets> {
        self.pending_insets
    }

    /// Queues a typed event. `send` owns the payload and calls the generated
    /// shim; it runs when the store delivers the queue, in order with every
    /// other report, never mid-call.
    pub fn queue_event(&mut self, send: impl FnOnce() + 'static) {
        self.queue.push(HostReport::Event {
            tag: self.tag,
            send: Box::new(send),
        });
    }

    /// Core's store handle, for a component that needs to run a deferred
    /// command against the store.
    pub fn store(&self) -> Option<&StoreHandle> {
        self.handle.as_ref()
    }

    /// Whether anything is queued that the store still has to deliver.
    pub(crate) fn has_reports(&self) -> bool {
        !self.queue.is_empty()
    }

    /// A context for a component's own unit tests, with a private queue.
    pub fn for_test(tag: i32) -> Self {
        Self::queued(tag, Rc::new(HostReports::default()))
    }

    /// For a test: the queue this context reports into.
    pub fn test_reports(&self) -> TestReports {
        TestReports(self.queue.clone())
    }
}

/// What a test context's queue holds, for a package's tests.
pub struct TestReports(HostReportQueue);

impl TestReports {
    /// Takes the reports, running each queued event, and returns what was
    /// reported: sizes, insets, and how many events fired.
    pub fn drain(&self) -> DrainedReports {
        let mut drained = DrainedReports::default();
        for report in self.0.take() {
            match report {
                HostReport::Size { width, height, .. } => drained.sizes.push((width, height)),
                HostReport::Insets {
                    top,
                    right,
                    bottom,
                    left,
                    ..
                } => drained.insets.push(EdgeInsets {
                    top,
                    right,
                    bottom,
                    left,
                }),
                HostReport::Event { send, .. } => {
                    drained.events += 1;
                    send();
                }
            }
        }
        drained
    }
}

/// The result of [`TestReports::drain`].
#[derive(Debug, Default, PartialEq)]
pub struct DrainedReports {
    pub sizes: Vec<(f32, f32)>,
    pub insets: Vec<EdgeInsets>,
    pub events: usize,
}

/// What a host component asks of Fabric beyond rendering. Declared in
/// `react-native.config.js` (`hostComponents`), because it decides how the
/// shadow node lays out before any Rust runs.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct HostComponentOptions {
    /// The component measures itself and reports through
    /// [`HostContext::set_intrinsic_size`]. Its shadow node is a leaf with a Yoga
    /// measure function.
    pub measured: bool,
    /// The component's content is composited by the OS (a native view, a GPU
    /// surface) rather than painted by GPUI. A `ScrollView` holding one stays
    /// off the scroll-layer path, because a scroll-only composite frame skips
    /// the prepaint that sets a native surface's bounds.
    pub native_surface: bool,
    /// The component is a container that draws chrome around React children.
    /// Core paints the children; the component paints only its chrome.
    pub container: bool,
}

/// How a host component object is driven. Generated code implements it for each
/// component's instance (a user type plus the props view built once per props
/// version); core stores a `Box<dyn HostObject>` on the node.
pub trait HostObject: 'static {
    /// The node's props changed. `props` replaces the previous version; `changed`
    /// is the mask C++ computed against what this object last saw, one bit per
    /// prop, and is never empty.
    fn update(&mut self, props: PropsHandle, changed: &[u64], cx: HostContext);

    /// The GPUI content, painted beneath the React children and laid out inside
    /// the node's Yoga frame.
    fn render(&mut self, window: &mut Window, cx: HostContext) -> AnyElement;

    /// Content painted above a container's React children (a focus ring, a
    /// badge), if the component has any.
    fn render_overlay(&mut self, window: &mut Window, cx: HostContext) -> Option<AnyElement>;

    /// A command from JS, by its index in the spec's `COMMANDS`.
    fn command(&mut self, index: u32, args: &[HostArg], cx: HostContext);
}

/// A generated registration value: a component's name and how to create it.
pub trait HostComponentSpec: 'static {
    /// The Fabric component name the spec declares.
    const NAME: &'static str;

    /// Creates the component for a node that just mounted.
    fn create(props: PropsHandle, emitter: EmitterHandle, cx: HostContext) -> Box<dyn HostObject>;
}

type CreateFn = fn(PropsHandle, EmitterHandle, HostContext) -> Box<dyn HostObject>;

/// One registry slot: what autolink declared, and what the package registered.
#[derive(Clone)]
pub struct HostEntry {
    pub name: String,
    pub options: HostComponentOptions,
    create: Option<CreateFn>,
}

impl HostEntry {
    /// Whether a package registered code for this declaration.
    pub fn is_registered(&self) -> bool {
        self.create.is_some()
    }

    /// Creates the component's object, or `None` when the package never
    /// registered one for this declaration.
    pub(crate) fn create(
        &self,
        props: PropsHandle,
        emitter: EmitterHandle,
        cx: HostContext,
    ) -> Option<Box<dyn HostObject>> {
        self.create.map(|create| create(props, emitter, cx))
    }
}

impl std::fmt::Debug for HostEntry {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HostEntry")
            .field("name", &self.name)
            .field("options", &self.options)
            .field("registered", &self.create.is_some())
            .finish()
    }
}

/// Whether any host component was ever declared, as a relaxed load. Every
/// per-op and per-node check goes through this first, so an app with no host
/// components pays one predictable branch.
fn any_declared_flag() -> &'static AtomicBool {
    static FLAG: AtomicBool = AtomicBool::new(false);
    &FLAG
}

/// Whether any host component was ever declared.
pub fn any_host_components() -> bool {
    any_declared_flag().load(Ordering::Relaxed)
}

fn pending() -> &'static Mutex<Vec<Option<HostEntry>>> {
    static PENDING: Mutex<Vec<Option<HostEntry>>> = Mutex::new(Vec::new());
    &PENDING
}

fn frozen() -> &'static OnceLock<Box<[Option<HostEntry>]>> {
    static FROZEN: OnceLock<Box<[Option<HostEntry>]>> = OnceLock::new();
    &FROZEN
}

/// Declares the component at `index`. Autolink calls this for every
/// `hostComponents` entry before any package registers, so the registry has its
/// shape from `react-native.config.js` and a package's registration only has to
/// supply the code.
pub fn declare_host_component(index: u32, name: &str, options: HostComponentOptions) {
    if frozen().get().is_some() {
        log::error!("[host-component] {name} declared after the registry froze; ignored");
        debug_assert!(
            false,
            "{name} declared after the host component registry froze"
        );
        return;
    }
    let mut slots = pending().lock().expect("host component registry poisoned");
    let index = index as usize;
    if slots.len() <= index {
        slots.resize(index + 1, None);
    }
    slots[index] = Some(HostEntry {
        name: name.to_string(),
        options,
        create: None,
    });
    any_declared_flag().store(true, Ordering::Relaxed);
}

/// Registers the code for a declared component. `spec` is the value the
/// generated `<name>_component::<T>()` returns.
pub fn register_component<C: HostComponentSpec>(spec: C) {
    let _ = spec;
    if frozen().get().is_some() {
        log::error!(
            "[host-component] {} registered after the registry froze; ignored",
            C::NAME
        );
        debug_assert!(
            false,
            "{} registered after the host component registry froze",
            C::NAME
        );
        return;
    }
    let mut slots = pending().lock().expect("host component registry poisoned");
    match slots
        .iter_mut()
        .flatten()
        .find(|entry| entry.name == C::NAME)
    {
        Some(entry) => entry.create = Some(C::create as CreateFn),
        None => {
            log::error!(
                "[host-component] {} is registered but not declared under platforms.desktop.hostComponents",
                C::NAME
            );
            debug_assert!(false, "{} is not declared in hostComponents", C::NAME);
        }
    }
}

/// Freezes the registry. Called once, before the first surface starts; every
/// later read is lock-free.
pub fn freeze() {
    frozen().get_or_init(|| {
        let slots = std::mem::take(&mut *pending().lock().expect("host component registry poisoned"));
        for entry in slots.iter().flatten() {
            if entry.create.is_none() {
                log::error!(
                    "[host-component] {} is declared in hostComponents but no package registered it",
                    entry.name
                );
            }
        }
        slots.into_boxed_slice()
    });
}

/// The entry at `index`, if there is one.
pub fn entry(index: u32) -> Option<HostEntry> {
    crate::counters::bump(crate::counters::Counter::HostRegistryLookups);
    if let Some(slots) = frozen().get() {
        return slots.get(index as usize).cloned().flatten();
    }
    if !any_host_components() {
        return None;
    }
    pending()
        .lock()
        .expect("host component registry poisoned")
        .get(index as usize)
        .cloned()
        .flatten()
}

/// Whether a package registered code for the component declared at `index`.
pub fn is_registered(index: u32) -> bool {
    let check = |slots: &[Option<HostEntry>]| {
        slots
            .get(index as usize)
            .and_then(Option::as_ref)
            .is_some_and(HostEntry::is_registered)
    };
    match frozen().get() {
        Some(slots) => check(slots),
        None => check(&pending().lock().expect("host component registry poisoned")),
    }
}

/// Whether the component at `index` renders content the OS composites (so a
/// `ScrollView` holding it must stay off the scroll-layer path).
pub fn renders_native_surface(index: u32) -> bool {
    entry(index).is_some_and(|entry| entry.options.native_surface)
}

/// Every declared host component with its index, for tests.
pub fn host_components() -> Vec<(u32, String, HostComponentOptions)> {
    let collect = |slots: &[Option<HostEntry>]| {
        slots
            .iter()
            .enumerate()
            .filter_map(|(index, entry)| {
                entry
                    .as_ref()
                    .map(|entry| (index as u32, entry.name.clone(), entry.options))
            })
            .collect()
    };
    match frozen().get() {
        Some(slots) => collect(slots),
        None => collect(&pending().lock().expect("host component registry poisoned")),
    }
}

#[doc(hidden)]
pub use crate::counters::note_props_bytes_copied;

/// Parses the JSON text of an `UnsafeMixed` prop into a [`Value`]. Generated
/// accessors call it once per props version, on the first read; text that is not
/// JSON reads as `null`, as an unset prop does.
pub fn parse_value(text: &str) -> Value {
    serde_json::from_str(text).unwrap_or(Value::Null)
}

/// Pushes a reported size into the node's shadow-node state, so Yoga uses it on
/// the next commit.
pub(crate) fn apply_size(tag: i32, width: f32, height: f32) {
    rn_gpui_sys::ffi::reportHostComponentSize(tag, width, height);
}

/// Pushes reported insets into the node's shadow-node state, where the container
/// descriptor applies them as Yoga padding around the children.
pub(crate) fn apply_insets(tag: i32, top: f32, right: f32, bottom: f32, left: f32) {
    rn_gpui_sys::ffi::reportHostComponentInsets(tag, top, right, bottom, left);
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui::{div, prelude::*};

    /// A stand-in for a generated instance: it records what it was driven with.
    struct Fake {
        log: Rc<RefCell<Vec<String>>>,
    }

    impl HostObject for Fake {
        fn update(&mut self, _props: PropsHandle, changed: &[u64], mut cx: HostContext) {
            self.log.borrow_mut().push(format!("update {changed:?}"));
            cx.set_intrinsic_size(30.0, 40.0);
        }

        fn render(&mut self, _window: &mut Window, _cx: HostContext) -> AnyElement {
            div().into_any_element()
        }

        fn render_overlay(&mut self, _window: &mut Window, _cx: HostContext) -> Option<AnyElement> {
            None
        }

        fn command(&mut self, index: u32, args: &[HostArg], mut cx: HostContext) {
            self.log
                .borrow_mut()
                .push(format!("command {index} {args:?}"));
            cx.queue_event(|| {});
        }
    }

    struct FakeSpec;

    thread_local! {
        static LOG: Rc<RefCell<Vec<String>>> = Rc::new(RefCell::new(Vec::new()));
    }

    impl HostComponentSpec for FakeSpec {
        const NAME: &'static str = "TestHostComponentFake";

        fn create(
            _props: PropsHandle,
            _emitter: EmitterHandle,
            mut cx: HostContext,
        ) -> Box<dyn HostObject> {
            cx.set_intrinsic_size(10.0, 20.0);
            Box::new(Fake {
                log: LOG.with(Rc::clone),
            })
        }
    }

    fn queue() -> HostReportQueue {
        Rc::new(HostReports::default())
    }

    #[test]
    fn a_context_records_every_report_in_order() {
        let shared = queue();
        let mut cx = HostContext::queued(7, shared.clone());
        cx.set_intrinsic_size(40.0, 20.0);
        cx.set_insets(1.0, 2.0, 3.0, 4.0);
        cx.queue_event(|| {});
        let reports = shared.take();
        assert_eq!(reports.len(), 3);
        assert!(matches!(
            reports[0],
            HostReport::Size {
                tag: 7,
                width,
                height
            } if width == 40.0 && height == 20.0
        ));
        assert!(matches!(
            reports[1],
            HostReport::Insets {
                tag: 7,
                top,
                right,
                bottom,
                left
            } if (top, right, bottom, left) == (1.0, 2.0, 3.0, 4.0)
        ));
        assert!(matches!(reports[2], HostReport::Event { tag: 7, .. }));
    }

    #[test]
    fn a_queued_event_runs_only_when_it_is_delivered() {
        let shared = queue();
        let mut cx = HostContext::queued(1, shared.clone());
        let fired = Rc::new(Cell::new(0));
        let counter = fired.clone();
        cx.queue_event(move || counter.set(counter.get() + 1));
        assert_eq!(fired.get(), 0, "queueing must not dispatch mid-call");
        for report in shared.take() {
            if let HostReport::Event { send, .. } = report {
                send();
            }
        }
        assert_eq!(fired.get(), 1);
    }

    #[test]
    fn two_reports_of_the_same_kind_both_survive() {
        let shared = queue();
        let mut cx = HostContext::queued(1, shared.clone());
        cx.set_intrinsic_size(1.0, 1.0);
        cx.set_intrinsic_size(2.0, 2.0);
        assert_eq!(
            shared.take().len(),
            2,
            "the queue appends, never overwrites"
        );
    }

    #[test]
    fn a_negative_reported_size_is_clamped_to_zero() {
        let mut cx = HostContext::for_test(1);
        cx.set_intrinsic_size(-5.0, -1.0);
        assert_eq!(cx.intrinsic_size(), Some((0.0, 0.0)));
    }

    #[test]
    fn insets_are_clamped_and_read_back() {
        let mut cx = HostContext::for_test(1);
        assert_eq!(cx.insets(), None);
        cx.set_insets(20.0, -4.0, 8.0, 12.0);
        assert_eq!(
            cx.insets(),
            Some(EdgeInsets {
                top: 20.0,
                right: 0.0,
                bottom: 8.0,
                left: 12.0,
            }),
            "a negative inset is a mistake, not an outward push"
        );
        assert_eq!(EdgeInsets::ZERO.top, 0.0);
    }

    #[test]
    fn a_test_context_drains_what_it_was_given() {
        let mut cx = HostContext::for_test(2);
        cx.set_intrinsic_size(3.0, 4.0);
        cx.set_insets(1.0, 1.0, 1.0, 1.0);
        cx.queue_event(|| {});
        let drained = cx.test_reports().drain();
        assert_eq!(drained.sizes, vec![(3.0, 4.0)]);
        assert_eq!(drained.insets.len(), 1);
        assert_eq!(drained.events, 1);
        assert_eq!(cx.test_reports().drain(), DrainedReports::default());
    }

    /// A frame in which several nodes report claims one delivery, not one each.
    #[test]
    fn a_report_queue_claims_a_single_frame_flush() {
        let shared = queue();
        let mut first = HostContext::queued(1, shared.clone());
        let mut second = HostContext::queued(2, shared.clone());
        first.set_intrinsic_size(1.0, 1.0);
        second.set_intrinsic_size(2.0, 2.0);
        assert!(!shared.claim_flush(), "the first report schedules");
        assert!(shared.claim_flush(), "the second joins it");
        assert_eq!(shared.take().len(), 2, "and both are still queued");
    }

    #[test]
    fn command_arguments_narrow_to_the_declared_type() {
        assert_eq!(HostArg::Number(2.9).to_i32(), 2);
        assert_eq!(HostArg::Number(1.5).to_f32(), 1.5);
        assert!(HostArg::Bool(true).to_bool());
        assert_eq!(HostArg::String("a".into()).to_string_value(), "a");
        assert_eq!(HostArg::Numbers(vec![1.0, 2.0]).to_i32_vec(), vec![1, 2]);
        assert_eq!(
            HostArg::Strings(vec!["x".into()]).to_string_vec(),
            vec!["x".to_string()]
        );
        assert_eq!(HostArg::String("a".into()).to_i32(), 0);
    }

    #[test]
    fn a_declared_component_is_created_by_its_registration() {
        declare_host_component(
            900,
            FakeSpec::NAME,
            HostComponentOptions {
                measured: true,
                ..Default::default()
            },
        );
        register_component(FakeSpec);
        let entry = entry(900).expect("declared");
        assert_eq!(entry.name, FakeSpec::NAME);
        assert!(entry.options.measured);

        let shared = queue();
        let mut object = entry
            .create(
                PropsHandle::for_test(),
                EmitterHandle::for_test(),
                HostContext::queued(3, shared.clone()),
            )
            .expect("registered");
        assert!(matches!(
            shared.take()[0],
            HostReport::Size { width, height, .. } if (width, height) == (10.0, 20.0)
        ));

        object.update(
            PropsHandle::for_test(),
            &[0b101],
            HostContext::queued(3, shared.clone()),
        );
        object.command(
            1,
            &[HostArg::Number(5.0)],
            HostContext::queued(3, shared.clone()),
        );
        LOG.with(|log| {
            assert_eq!(
                *log.borrow(),
                vec![
                    "update [5]".to_string(),
                    "command 1 [Number(5.0)]".to_string()
                ]
            );
        });
        assert_eq!(
            shared.take().len(),
            2,
            "the update's size and the command's event"
        );
    }

    #[test]
    fn a_declaration_nobody_registered_has_no_code() {
        declare_host_component(
            901,
            "TestHostComponentUnregistered",
            HostComponentOptions::default(),
        );
        let entry = entry(901).expect("declared");
        assert!(entry
            .create(
                PropsHandle::for_test(),
                EmitterHandle::for_test(),
                HostContext::for_test(1)
            )
            .is_none());
    }

    #[test]
    fn the_registry_reports_what_each_component_declared() {
        declare_host_component(
            902,
            "TestHostComponentNative",
            HostComponentOptions {
                native_surface: true,
                container: true,
                ..Default::default()
            },
        );
        assert!(renders_native_surface(902));
        let found = host_components()
            .into_iter()
            .find(|(index, _, _)| *index == 902)
            .expect("listed");
        assert_eq!(found.1, "TestHostComponentNative");
        assert!(found.2.container);
        assert!(!found.2.measured);
        assert!(!renders_native_surface(901));
        assert!(
            !renders_native_surface(12345),
            "an unknown index renders nothing"
        );
    }
}
