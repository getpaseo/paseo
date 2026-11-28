//! Native trees: components that exist only as GPUI instances.
//!
//! A host component made of other host components of the same family (a dialog
//! of buttons, a tab bar of tabs) would pay a Fabric node, a Yoga node, a mount
//! operation and a props handle for every nested component. A native tree
//! holds them instead as instances, created and updated by a batch of
//! operations, and builds the whole subtree as one GPUI element tree. The
//! operations come from a reconciler that runs next to React Native's; this
//! module is the half that lives in the runtime.
//!
//! Instances are identified by the `NativeId` the reconciler gave them, so a
//! reorder is a move and an event names its sender. Each instance is a
//! [`NativeComponent`]: it is created from its props, told which of them
//! changed, and renders the element for its node from the elements of its
//! children, which it places itself.

use gpui::{
    AnyElement, AnyWindowHandle, App, Bounds, Element, ElementId, GlobalElementId,
    InspectorElementId, IntoElement, LayoutId, Pixels, Role, Window,
};
use serde_json::{Map, Value};
use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;
use std::sync::{Arc, Mutex};

pub type NativeId = u64;

/// Something an instance tells JavaScript: `name` is the prop that holds the
/// handler (`onPress`), `payload` what it is called with.
#[derive(Clone, Debug, PartialEq)]
pub struct NativeEvent {
    pub id: NativeId,
    pub name: String,
    pub payload: Value,
}

/// Sends events from an instance to JavaScript. Cloneable, so a GPUI listener
/// can keep one.
#[derive(Clone)]
pub struct NativeEmitter {
    id: NativeId,
    sink: Rc<dyn Fn(NativeEvent)>,
}

impl NativeEmitter {
    pub fn emit(&self, name: &str, payload: Value) {
        (self.sink)(NativeEvent {
            id: self.id,
            name: name.to_string(),
            payload,
        });
    }
}

/// What a component is given besides its props.
pub struct NativeContext<'a> {
    pub id: NativeId,
    /// The `App` of the call, for creating entities and reading globals.
    pub app: &'a mut App,
    emitter: NativeEmitter,
    window: Option<AnyWindowHandle>,
}

impl NativeContext<'_> {
    /// The window the tree is shown in, when its owner knows it.
    pub fn window(&self) -> Option<AnyWindowHandle> {
        self.window
    }

    /// A sender for this instance's events that outlives the call.
    pub fn emitter(&self) -> NativeEmitter {
        self.emitter.clone()
    }

    pub fn emit(&self, name: &str, payload: Value) {
        self.emitter.emit(name, payload);
    }
}

/// What generated host component code is given when its component runs in a
/// native tree instead of as a Fabric node.
pub struct NativeCall {
    pub id: NativeId,
    pub emitter: NativeEmitter,
    /// The `App` of the call, valid until the call returns.
    pub app: *mut App,
    /// The window the tree is shown in, for a call made outside any window
    /// (a command); `None` in `render`, which has its window.
    pub window: Option<AnyWindowHandle>,
    /// The elements of the instance's children, taken by `children()`.
    pub children: Vec<AnyElement>,
}

/// A component that lives in a native tree.
pub trait NativeComponent: 'static {
    /// Created from its full props when its `create` operation arrives.
    fn create(props: &Map<String, Value>, cx: &mut NativeContext) -> Self
    where
        Self: Sized;

    /// Some props changed; `props` holds all of them now and `changed` names
    /// the ones that did, set or removed. Never called with nothing changed.
    fn update(&mut self, props: &Map<String, Value>, changed: &[String], cx: &mut NativeContext);

    /// A command JavaScript sent to this instance, by name. Unknown names are
    /// ignored.
    fn command(
        &mut self,
        _props: &Map<String, Value>,
        _name: &str,
        _args: &[Value],
        _cx: &mut NativeContext,
    ) {
    }

    /// Whether this component can be reused for another instance of its type
    /// once it is removed. A component that holds state a new instance must not
    /// see (focus, an in-progress gesture, a pending timer) says no, which is
    /// the default.
    fn recyclable(&self) -> bool {
        false
    }

    /// Makes this removed component the instance `cx.id` with `props`, as
    /// `create` would have. Whatever it kept from `cx` (its emitter) must be
    /// taken again. Returning false discards it and `create` is called instead.
    fn recycle(&mut self, _props: &Map<String, Value>, _cx: &mut NativeContext) -> bool {
        false
    }

    /// The element for this node. `children` are the elements of its child
    /// instances in order, ready to place wherever the component wants.
    fn render(
        &mut self,
        props: &Map<String, Value>,
        children: Vec<AnyElement>,
        window: &mut Window,
        cx: &mut App,
    ) -> AnyElement;
}

type Factory =
    Arc<dyn Fn(&Map<String, Value>, &mut NativeContext) -> Box<dyn ErasedComponent> + Send + Sync>;

/// `NativeComponent` with the type erased, which a trait object needs because
/// `create` returns `Self`.
trait ErasedComponent {
    fn update(&mut self, props: &Map<String, Value>, changed: &[String], cx: &mut NativeContext);
    fn command(
        &mut self,
        props: &Map<String, Value>,
        name: &str,
        args: &[Value],
        cx: &mut NativeContext,
    );
    fn recyclable(&self) -> bool;
    fn recycle(&mut self, props: &Map<String, Value>, cx: &mut NativeContext) -> bool;
    fn render(
        &mut self,
        props: &Map<String, Value>,
        children: Vec<AnyElement>,
        window: &mut Window,
        cx: &mut App,
    ) -> AnyElement;
}

impl<T: NativeComponent> ErasedComponent for T {
    fn update(&mut self, props: &Map<String, Value>, changed: &[String], cx: &mut NativeContext) {
        NativeComponent::update(self, props, changed, cx);
    }

    fn command(
        &mut self,
        props: &Map<String, Value>,
        name: &str,
        args: &[Value],
        cx: &mut NativeContext,
    ) {
        NativeComponent::command(self, props, name, args, cx);
    }

    fn recyclable(&self) -> bool {
        NativeComponent::recyclable(self)
    }

    fn recycle(&mut self, props: &Map<String, Value>, cx: &mut NativeContext) -> bool {
        NativeComponent::recycle(self, props, cx)
    }

    fn render(
        &mut self,
        props: &Map<String, Value>,
        children: Vec<AnyElement>,
        window: &mut Window,
        cx: &mut App,
    ) -> AnyElement {
        NativeComponent::render(self, props, children, window, cx)
    }
}

fn registry() -> &'static Mutex<HashMap<String, Factory>> {
    static MAP: std::sync::OnceLock<Mutex<HashMap<String, Factory>>> = std::sync::OnceLock::new();
    MAP.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Registers the component a `create` operation of type `name` makes. Called
/// from a module's `rn_gpui_register()`.
pub fn register_native_component<T: NativeComponent>(name: &str) {
    let factory: Factory = Arc::new(|props, cx| Box::new(T::create(props, cx)));
    registry()
        .lock()
        .expect("native component registry poisoned")
        .insert(name.to_string(), factory);
}

/// One change to a native tree.
#[derive(Clone, Debug, PartialEq)]
pub enum NativeOp {
    Create {
        id: NativeId,
        type_name: String,
        props: Map<String, Value>,
    },
    /// Appends `child` to `parent`, moving it if it has a parent already.
    Append { parent: NativeId, child: NativeId },
    /// Puts `child` in `parent` before `before`, moving it if it has a parent.
    Insert {
        parent: NativeId,
        child: NativeId,
        before: NativeId,
    },
    /// Takes `child` out of `parent` and drops it with everything under it.
    Remove { parent: NativeId, child: NativeId },
    Update {
        id: NativeId,
        set: Map<String, Value>,
        unset: Vec<String>,
    },
    /// Calls the command `name` of an instance, with `args`.
    Command {
        id: NativeId,
        name: String,
        args: Vec<Value>,
    },
}

impl NativeOp {
    /// Reads a batch: an array of arrays, `["create", id, type, props]`,
    /// `["append", parent, child]`, `["insert", parent, child, before]`,
    /// `["remove", parent, child]`, `["update", id, set, unset]` and
    /// `["command", id, name, args]`.
    pub fn parse_batch(batch: &Value) -> Result<Vec<NativeOp>, String> {
        let entries = batch.as_array().ok_or("a batch is an array")?;
        entries.iter().map(Self::parse).collect()
    }

    fn parse(entry: &Value) -> Result<NativeOp, String> {
        let parts = entry.as_array().ok_or("an operation is an array")?;
        let id = |position: usize| {
            parts
                .get(position)
                .and_then(Value::as_u64)
                .ok_or_else(|| format!("operation {entry} needs an id at {position}"))
        };
        let object = |position: usize| {
            parts
                .get(position)
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default()
        };
        match parts.first().and_then(Value::as_str) {
            Some("create") => Ok(NativeOp::Create {
                id: id(1)?,
                type_name: parts
                    .get(2)
                    .and_then(Value::as_str)
                    .ok_or("create needs a type")?
                    .to_string(),
                props: object(3),
            }),
            Some("append") => Ok(NativeOp::Append {
                parent: id(1)?,
                child: id(2)?,
            }),
            Some("insert") => Ok(NativeOp::Insert {
                parent: id(1)?,
                child: id(2)?,
                before: id(3)?,
            }),
            Some("remove") => Ok(NativeOp::Remove {
                parent: id(1)?,
                child: id(2)?,
            }),
            Some("update") => Ok(NativeOp::Update {
                id: id(1)?,
                set: object(2),
                unset: parts
                    .get(3)
                    .and_then(Value::as_array)
                    .map(|names| {
                        names
                            .iter()
                            .filter_map(Value::as_str)
                            .map(str::to_string)
                            .collect()
                    })
                    .unwrap_or_default(),
            }),
            Some("command") => Ok(NativeOp::Command {
                id: id(1)?,
                name: parts
                    .get(2)
                    .and_then(Value::as_str)
                    .ok_or("command needs a name")?
                    .to_string(),
                args: parts
                    .get(3)
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default(),
            }),
            other => Err(format!("unknown operation {other:?}")),
        }
    }
}

struct Instance {
    type_name: String,
    props: Map<String, Value>,
    parent: Option<NativeId>,
    children: Vec<NativeId>,
    component: Box<dyn ErasedComponent>,
}

type BoundsMap = Rc<RefCell<HashMap<NativeId, Bounds<Pixels>>>>;

/// Wraps an instance's element without changing its layout: it puts the element
/// in a scope of its own, so two instances may use the same element id for
/// their state (a `div().id("button")` in every button) without sharing it; it
/// records where the element was put, and gives the accessibility tree the role and label the
/// instance's props name (`accessibilityRole`, `accessibilityLabel`, `testID`).
struct Tracked {
    inner: AnyElement,
    id: NativeId,
    bounds: BoundsMap,
    role: Option<Role>,
    label: Option<String>,
    test_id: Option<String>,
}

impl IntoElement for Tracked {
    type Element = Self;

    fn into_element(self) -> Self {
        self
    }
}

impl Element for Tracked {
    type RequestLayoutState = ();
    type PrepaintState = ();

    fn id(&self) -> Option<ElementId> {
        self.role.map(|_| ElementId::Integer(self.id))
    }

    fn source_location(&self) -> Option<&'static std::panic::Location<'static>> {
        None
    }

    fn request_layout(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        window: &mut Window,
        cx: &mut App,
    ) -> (LayoutId, ()) {
        let scope = ElementId::Integer(self.id);
        (
            window.with_id(scope, |window| self.inner.request_layout(window, cx)),
            (),
        )
    }

    fn prepaint(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        _request_layout: &mut (),
        window: &mut Window,
        cx: &mut App,
    ) {
        self.bounds.borrow_mut().insert(self.id, bounds);
        let scope = ElementId::Integer(self.id);
        window.with_id(scope, |window| self.inner.prepaint(window, cx));
    }

    fn paint(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        _bounds: Bounds<Pixels>,
        _request_layout: &mut (),
        _prepaint: &mut (),
        window: &mut Window,
        cx: &mut App,
    ) {
        let scope = ElementId::Integer(self.id);
        window.with_id(scope, |window| self.inner.paint(window, cx));
    }

    fn a11y_role(&self) -> Option<Role> {
        self.role
    }

    fn write_a11y_info(&self, node: &mut gpui::accesskit::Node) {
        if let Some(label) = &self.label {
            node.set_label(label.clone());
        }
        if let Some(test_id) = &self.test_id {
            node.set_author_id(test_id.clone());
        }
    }
}

/// The instances of one native root, and the operations that change them.
pub struct NativeTree {
    instances: HashMap<NativeId, Instance>,
    /// Where each instance was put the last time it painted.
    bounds: BoundsMap,
    /// The instances with no parent, in the order they were made: the roots a
    /// host attaches to its own node.
    roots: Vec<NativeId>,
    sink: Rc<dyn Fn(NativeEvent)>,
    /// Components of removed instances that said they can be reused, by type.
    pool: HashMap<String, Vec<Box<dyn ErasedComponent>>>,
    renderer: Option<InstanceRenderer>,
    window: Option<AnyWindowHandle>,
}

/// Renders one child instance again, on demand: for a component whose content
/// is built by a closure that GPUI calls on every frame (a dialog, a popover, a
/// table cell), where a child's element, which can be used once, is not enough.
pub type ChildRenderer = Rc<dyn Fn(&mut Window, &mut App) -> AnyElement>;

/// Renders an instance of a tree by id, for the tree's owner to provide.
pub type InstanceRenderer = Rc<dyn Fn(NativeId, &mut Window, &mut App) -> AnyElement>;

thread_local! {
    static CHILD_RENDERERS: RefCell<Vec<ChildRenderer>> = const { RefCell::new(Vec::new()) };
}

/// A renderer for each child of the instance that is rendering, in order. Valid
/// during `NativeComponent::render` (and the render of a generated `Spec`) in a
/// native tree, and empty anywhere else.
pub fn child_renderers() -> Vec<ChildRenderer> {
    CHILD_RENDERERS.with(|renderers| renderers.borrow().clone())
}

/// The most removed components kept per type.
const POOL_LIMIT: usize = 256;

impl NativeTree {
    pub fn new(sink: impl Fn(NativeEvent) + 'static) -> Self {
        Self {
            instances: HashMap::new(),
            bounds: Rc::new(RefCell::new(HashMap::new())),
            roots: Vec::new(),
            sink: Rc::new(sink),
            pool: HashMap::new(),
            renderer: None,
            window: None,
        }
    }

    /// How the tree's owner renders one of its instances by id, which makes
    /// [`child_renderers`] available to components.
    pub fn set_instance_renderer(&mut self, renderer: InstanceRenderer) {
        self.renderer = Some(renderer);
    }

    /// The window the tree is shown in, which commands of its instances run in.
    pub fn set_window(&mut self, window: Option<AnyWindowHandle>) {
        self.window = window;
    }

    /// The top-level instances, in order.
    pub fn roots(&self) -> &[NativeId] {
        &self.roots
    }

    pub fn contains(&self, id: NativeId) -> bool {
        self.instances.contains_key(&id)
    }

    /// The children of `id`, in order.
    pub fn children(&self, id: NativeId) -> &[NativeId] {
        self.instances
            .get(&id)
            .map_or(&[], |instance| instance.children.as_slice())
    }

    pub fn type_of(&self, id: NativeId) -> Option<&str> {
        self.instances
            .get(&id)
            .map(|instance| instance.type_name.as_str())
    }

    pub fn len(&self) -> usize {
        self.instances.len()
    }

    pub fn is_empty(&self) -> bool {
        self.instances.is_empty()
    }

    /// Applies a batch in order. An operation naming an instance that does not
    /// exist, or a type nobody registered, is logged and skipped, and the rest
    /// of the batch still applies.
    pub fn apply(&mut self, ops: Vec<NativeOp>, app: &mut App) {
        for op in ops {
            if let Err(error) = self.apply_one(op, app) {
                log::error!("[native-tree] {error}");
            }
        }
    }

    fn context<'a>(&self, id: NativeId, app: &'a mut App) -> NativeContext<'a> {
        NativeContext {
            id,
            app,
            emitter: NativeEmitter {
                id,
                sink: self.sink.clone(),
            },
            window: self.window,
        }
    }

    fn apply_one(&mut self, op: NativeOp, app: &mut App) -> Result<(), String> {
        match op {
            NativeOp::Create {
                id,
                type_name,
                props,
            } => {
                if self.instances.contains_key(&id) {
                    return Err(format!("instance {id} already exists"));
                }
                let factory = registry()
                    .lock()
                    .expect("native component registry poisoned")
                    .get(&type_name)
                    .cloned()
                    .ok_or_else(|| format!("no native component {type_name:?} is registered"))?;
                let mut cx = self.context(id, app);
                let recycled =
                    self.pool
                        .get_mut(&type_name)
                        .and_then(Vec::pop)
                        .and_then(|mut component| {
                            component.recycle(&props, &mut cx).then_some(component)
                        });
                let component = match recycled {
                    Some(component) => {
                        crate::counters::bump(crate::counters::Counter::NativeInstancesRecycled);
                        component
                    }
                    None => {
                        crate::counters::bump(crate::counters::Counter::NativeInstancesCreated);
                        factory(&props, &mut cx)
                    }
                };
                self.instances.insert(
                    id,
                    Instance {
                        type_name,
                        props,
                        parent: None,
                        children: Vec::new(),
                        component,
                    },
                );
                self.roots.push(id);
                Ok(())
            }
            NativeOp::Append { parent, child } => {
                self.require(parent)?;
                self.require(child)?;
                self.reject_cycle(parent, child)?;
                self.detach(child)?;
                self.attach(parent, child, None)
            }
            NativeOp::Insert {
                parent,
                child,
                before,
            } => {
                self.require(parent)?;
                self.require(child)?;
                self.reject_cycle(parent, child)?;
                self.detach(child)?;
                self.attach(parent, child, Some(before))
            }
            NativeOp::Remove { parent, child } => {
                if self
                    .instances
                    .get(&child)
                    .and_then(|instance| instance.parent)
                    != Some(parent)
                {
                    return Err(format!("{child} is not a child of {parent}"));
                }
                self.detach(child)?;
                self.drop_subtree(child);
                Ok(())
            }
            NativeOp::Command { id, name, args } => {
                let mut cx = self.context(id, app);
                let instance = self
                    .instances
                    .get_mut(&id)
                    .ok_or_else(|| format!("command for unknown instance {id}"))?;
                instance
                    .component
                    .command(&instance.props, &name, &args, &mut cx);
                Ok(())
            }
            NativeOp::Update { id, set, unset } => {
                let mut changed: Vec<String> = Vec::new();
                {
                    let instance = self
                        .instances
                        .get_mut(&id)
                        .ok_or_else(|| format!("update of unknown instance {id}"))?;
                    for (name, value) in set {
                        if instance.props.get(&name) != Some(&value) {
                            changed.push(name.clone());
                            instance.props.insert(name, value);
                        }
                    }
                    for name in unset {
                        if instance.props.remove(&name).is_some() {
                            changed.push(name);
                        }
                    }
                }
                if changed.is_empty() {
                    return Ok(());
                }
                let mut cx = self.context(id, app);
                let instance = self.instances.get_mut(&id).expect("checked above");
                instance
                    .component
                    .update(&instance.props, &changed, &mut cx);
                Ok(())
            }
        }
    }

    fn require(&self, id: NativeId) -> Result<(), String> {
        self.instances
            .contains_key(&id)
            .then_some(())
            .ok_or_else(|| format!("unknown instance {id}"))
    }

    /// Takes `id` out of its parent, or out of the roots.
    fn detach(&mut self, id: NativeId) -> Result<(), String> {
        let parent = self
            .instances
            .get(&id)
            .ok_or_else(|| format!("unknown instance {id}"))?
            .parent;
        match parent {
            Some(parent) => {
                if let Some(instance) = self.instances.get_mut(&parent) {
                    instance.children.retain(|child| *child != id);
                }
            }
            None => self.roots.retain(|root| *root != id),
        }
        if let Some(instance) = self.instances.get_mut(&id) {
            instance.parent = None;
        }
        Ok(())
    }

    fn attach(
        &mut self,
        parent: NativeId,
        child: NativeId,
        before: Option<NativeId>,
    ) -> Result<(), String> {
        let instance = self.instances.get_mut(&parent).expect("parent was checked");
        let at = before
            .and_then(|before| instance.children.iter().position(|id| *id == before))
            .unwrap_or(instance.children.len());
        instance.children.insert(at, child);
        if let Some(instance) = self.instances.get_mut(&child) {
            instance.parent = Some(parent);
        }
        Ok(())
    }

    fn reject_cycle(&self, parent: NativeId, child: NativeId) -> Result<(), String> {
        if self.is_inside(parent, child) {
            return Err(format!("{child} cannot go inside itself through {parent}"));
        }
        Ok(())
    }

    /// Whether `descendant` is `ancestor` or lies under it.
    fn is_inside(&self, mut descendant: NativeId, ancestor: NativeId) -> bool {
        loop {
            if descendant == ancestor {
                return true;
            }
            match self.instances.get(&descendant).and_then(|i| i.parent) {
                Some(parent) => descendant = parent,
                None => return false,
            }
        }
    }

    fn drop_subtree(&mut self, id: NativeId) {
        if let Some(instance) = self.instances.remove(&id) {
            for child in instance.children {
                self.drop_subtree(child);
            }
            if instance.component.recyclable() {
                let pooled = self.pool.entry(instance.type_name).or_default();
                if pooled.len() < POOL_LIMIT {
                    pooled.push(instance.component);
                }
            }
        }
    }

    /// The element for `id`: its children render first, then it places them.
    pub fn render(&mut self, id: NativeId, window: &mut Window, app: &mut App) -> AnyElement {
        let children: Vec<NativeId> = self.children(id).to_vec();
        let elements: Vec<AnyElement> = children
            .clone()
            .into_iter()
            .map(|child| self.render(child, window, app))
            .collect();
        let bounds = self.bounds.clone();
        let renderers: Vec<ChildRenderer> = match &self.renderer {
            Some(renderer) => children
                .iter()
                .map(|&child| {
                    let renderer = renderer.clone();
                    Rc::new(move |window: &mut Window, app: &mut App| renderer(child, window, app))
                        as ChildRenderer
                })
                .collect(),
            None => Vec::new(),
        };
        match self.instances.get_mut(&id) {
            Some(instance) => {
                CHILD_RENDERERS.with(|current| *current.borrow_mut() = renderers);
                let inner = instance
                    .component
                    .render(&instance.props, elements, window, app);
                CHILD_RENDERERS.with(|current| current.borrow_mut().clear());
                let text = |name: &str| {
                    instance
                        .props
                        .get(name)
                        .and_then(Value::as_str)
                        .filter(|text| !text.is_empty())
                        .map(str::to_string)
                };
                Tracked {
                    inner,
                    id,
                    bounds,
                    role: text("accessibilityRole").and_then(|role| {
                        crate::node_view::role_for_accessibility_role(&role, true)
                    }),
                    label: text("accessibilityLabel"),
                    test_id: text("testID"),
                }
                .into_any_element()
            }
            None => gpui::div().into_any_element(),
        }
    }

    /// Where `id` was put the last time it painted, in window coordinates.
    pub fn bounds_of(&self, id: NativeId) -> Option<Bounds<Pixels>> {
        self.bounds.borrow().get(&id).copied()
    }

    /// The props of `id`.
    pub fn props_of(&self, id: NativeId) -> Option<&Map<String, Value>> {
        self.instances.get(&id).map(|instance| &instance.props)
    }

    /// Every instance, parents before their children.
    pub fn ids(&self) -> Vec<NativeId> {
        let mut ids = Vec::with_capacity(self.instances.len());
        let mut pending: Vec<NativeId> = self.roots.iter().rev().copied().collect();
        while let Some(id) = pending.pop() {
            ids.push(id);
            pending.extend(self.children(id).iter().rev().copied());
        }
        ids
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui::{div, ParentElement, TestAppContext};
    use serde_json::json;
    use std::cell::RefCell;

    thread_local! {
        static LOG: RefCell<Vec<String>> = const { RefCell::new(Vec::new()) };
    }

    fn log() -> Vec<String> {
        LOG.with(|log| std::mem::take(&mut *log.borrow_mut()))
    }

    fn note(line: String) {
        LOG.with(|log| log.borrow_mut().push(line));
    }

    struct Panel {
        id: NativeId,
    }

    impl NativeComponent for Panel {
        fn create(_props: &Map<String, Value>, cx: &mut NativeContext) -> Self {
            cx.emit("onCreated", json!({}));
            Self { id: cx.id }
        }

        fn update(
            &mut self,
            _props: &Map<String, Value>,
            changed: &[String],
            cx: &mut NativeContext,
        ) {
            cx.emit("onUpdated", json!(changed));
        }

        fn render(
            &mut self,
            _props: &Map<String, Value>,
            children: Vec<AnyElement>,
            _window: &mut Window,
            _cx: &mut App,
        ) -> AnyElement {
            note(format!("panel {} with {}", self.id, children.len()));
            div().children(children).into_any_element()
        }
    }

    impl Drop for Panel {
        fn drop(&mut self) {
            note(format!("dropped panel {}", self.id));
        }
    }

    struct Text;

    impl NativeComponent for Text {
        fn create(_props: &Map<String, Value>, _cx: &mut NativeContext) -> Self {
            Text
        }

        fn update(
            &mut self,
            _props: &Map<String, Value>,
            _changed: &[String],
            _cx: &mut NativeContext,
        ) {
        }

        fn render(
            &mut self,
            props: &Map<String, Value>,
            _children: Vec<AnyElement>,
            _window: &mut Window,
            _cx: &mut App,
        ) -> AnyElement {
            let text = props.get("text").and_then(Value::as_str).unwrap_or("");
            note(format!("text {text}"));
            div().child(text.to_string()).into_any_element()
        }
    }

    fn tree() -> (NativeTree, Rc<RefCell<Vec<NativeEvent>>>) {
        register_native_component::<Panel>("TestPanel");
        register_native_component::<Text>("TestText");
        let events = Rc::new(RefCell::new(Vec::new()));
        let sink = events.clone();
        (
            NativeTree::new(move |event| sink.borrow_mut().push(event)),
            events,
        )
    }

    fn create(id: NativeId, type_name: &str, props: Value) -> NativeOp {
        NativeOp::Create {
            id,
            type_name: type_name.to_string(),
            props: props.as_object().cloned().unwrap_or_default(),
        }
    }

    fn render_all(cx: &mut TestAppContext, tree: &mut NativeTree, id: NativeId) {
        let window = cx.add_window(|_, _| gpui::Empty);
        cx.update(|app| {
            window
                .update(app, |_, window, app| {
                    let _ = tree.render(id, window, app);
                })
                .unwrap();
        });
    }

    #[gpui::test]
    fn a_tree_renders_children_before_the_parent_places_them(cx: &mut TestAppContext) {
        let (mut tree, _events) = tree();
        log();
        cx.update(|app| {
            tree.apply(
                vec![
                    create(1, "TestPanel", json!({})),
                    create(2, "TestText", json!({"text": "a"})),
                    create(3, "TestText", json!({"text": "b"})),
                    NativeOp::Append {
                        parent: 1,
                        child: 2,
                    },
                    NativeOp::Append {
                        parent: 1,
                        child: 3,
                    },
                ],
                app,
            );
        });
        assert_eq!(tree.roots(), &[1]);
        assert_eq!(tree.children(1), &[2, 3]);
        render_all(cx, &mut tree, 1);
        assert_eq!(log(), vec!["text a", "text b", "panel 1 with 2"]);
    }

    #[gpui::test]
    fn an_update_reaches_the_component_with_only_what_changed(cx: &mut TestAppContext) {
        let (mut tree, events) = tree();
        cx.update(|app| {
            tree.apply(
                vec![
                    create(1, "TestPanel", json!({"a": 1, "b": 2})),
                    NativeOp::Update {
                        id: 1,
                        set: json!({"a": 1, "b": 3, "c": 4})
                            .as_object()
                            .cloned()
                            .unwrap(),
                        unset: vec![],
                    },
                    NativeOp::Update {
                        id: 1,
                        set: Map::new(),
                        unset: vec!["a".to_string(), "missing".to_string()],
                    },
                    NativeOp::Update {
                        id: 1,
                        set: json!({"b": 3}).as_object().cloned().unwrap(),
                        unset: vec![],
                    },
                ],
                app,
            );
        });
        let seen: Vec<(NativeId, String, Value)> = events
            .borrow()
            .iter()
            .map(|event| (event.id, event.name.clone(), event.payload.clone()))
            .collect();
        assert_eq!(
            seen,
            vec![
                (1, "onCreated".to_string(), json!({})),
                (1, "onUpdated".to_string(), json!(["b", "c"])),
                (1, "onUpdated".to_string(), json!(["a"])),
            ]
        );
    }

    #[gpui::test]
    fn a_keyed_reorder_is_a_move_and_a_removal_drops_the_subtree(cx: &mut TestAppContext) {
        let (mut tree, _events) = tree();
        log();
        cx.update(|app| {
            tree.apply(
                vec![
                    create(1, "TestPanel", json!({})),
                    create(2, "TestText", json!({"text": "a"})),
                    create(3, "TestText", json!({"text": "b"})),
                    create(4, "TestText", json!({"text": "c"})),
                    NativeOp::Append {
                        parent: 1,
                        child: 2,
                    },
                    NativeOp::Append {
                        parent: 1,
                        child: 3,
                    },
                    NativeOp::Append {
                        parent: 1,
                        child: 4,
                    },
                    NativeOp::Insert {
                        parent: 1,
                        child: 4,
                        before: 2,
                    },
                ],
                app,
            );
        });
        assert_eq!(tree.children(1), &[4, 2, 3]);
        assert_eq!(tree.len(), 4);
        render_all(cx, &mut tree, 1);
        assert_eq!(log(), vec!["text c", "text a", "text b", "panel 1 with 3"]);

        cx.update(|app| {
            tree.apply(
                vec![
                    create(5, "TestPanel", json!({})),
                    NativeOp::Append {
                        parent: 1,
                        child: 5,
                    },
                    create(6, "TestPanel", json!({})),
                    NativeOp::Append {
                        parent: 5,
                        child: 6,
                    },
                    NativeOp::Remove {
                        parent: 1,
                        child: 5,
                    },
                ],
                app,
            );
        });
        assert!(!tree.contains(5) && !tree.contains(6));
        let dropped = log();
        assert!(dropped.contains(&"dropped panel 5".to_string()));
        assert!(dropped.contains(&"dropped panel 6".to_string()));
        assert_eq!(tree.children(1), &[4, 2, 3]);
    }

    #[gpui::test]
    fn a_bad_operation_is_skipped_and_the_rest_of_the_batch_applies(cx: &mut TestAppContext) {
        let (mut tree, _events) = tree();
        cx.update(|app| {
            tree.apply(
                vec![
                    create(1, "TestPanel", json!({})),
                    create(2, "NoSuchComponent", json!({})),
                    NativeOp::Append {
                        parent: 1,
                        child: 99,
                    },
                    create(1, "TestPanel", json!({})),
                    create(3, "TestPanel", json!({})),
                    NativeOp::Append {
                        parent: 1,
                        child: 3,
                    },
                    NativeOp::Append {
                        parent: 3,
                        child: 1,
                    },
                ],
                app,
            );
        });
        assert_eq!(tree.len(), 2);
        assert_eq!(tree.roots(), &[1]);
        assert_eq!(tree.children(1), &[3]);
        assert!(tree.children(3).is_empty());
    }

    #[test]
    fn a_batch_of_arrays_parses_into_operations() {
        let batch = json!([
            ["create", 1, "TestPanel", {"x": 1}],
            ["append", 0, 1],
            ["insert", 0, 2, 1],
            ["remove", 0, 1],
            ["update", 2, {"y": 2}, ["x"]],
        ]);
        let ops = NativeOp::parse_batch(&batch).unwrap();
        assert_eq!(ops.len(), 5);
        assert_eq!(
            ops[4],
            NativeOp::Update {
                id: 2,
                set: json!({"y": 2}).as_object().cloned().unwrap(),
                unset: vec!["x".to_string()],
            }
        );
        assert!(NativeOp::parse_batch(&json!([["explode", 1]])).is_err());
        assert!(NativeOp::parse_batch(&json!([["append", 1]])).is_err());
    }
}
