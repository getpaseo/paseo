# Changelog

All notable changes to `@react-native-gpui/codegen` are listed here. Each version's section becomes the notes of its GitHub release.

## 0.87.0-alpha.2 - 2026-11-26

- The context of a component in a native tree runs `with_window` in the window the tree is shown in (the new `NativeCall::window`), so a command that needs a window works there too.
- A component in a native tree reads a scalar prop that is not set as the default its spec declares (`WithDefault<boolean, true>` reads `true`) instead of zero, as a Fabric node does.

## 0.87.0-alpha.1 - 2026-11-12

- A crate with both a module spec and a component spec generates a component that means `host_component::Value` (serde_json's): the component half of the file names it `HostValue` instead of losing it to the module runtime's `Value`, which broke `as_str`, `as_i64` and `Map::get` in the generated create, update and command code.

- A spec file set with both a Turbo Native Module and a host component generates one Rust file that compiles (the `Value` import is no longer repeated).
- An event payload field can be a union of string literals: it is an enum on the Rust side (`as_raw()` to C++, which fills the enum React Native generated; its name to a native tree).
- Every component spec is also a component of a native tree (a `NativeRoot`): the generated props view reads either the C++ props or the JSON props of a native tree instance through the same accessors (scalars, strings, enums, colors, `UnsafeMixed`, arrays, structs, arrays of structs, image sources and arrays of strings, with no accessor that can panic), the change mask can be built from prop names, events are sent to a native tree as `{ nativeEvent }` payloads, commands are called by name with JSON arguments, and the context has `children()`. The same `impl <Spec>Spec for T` serves both; register it for a native tree with `<Spec>Component::<T>::register_native_tree()`. An image prop of a native tree is an object with the fields of a resolved React Native image source (`uri`, `scale`, ...). Existing implementations compile unchanged.
- The generated host component trait has an optional `measure(props, constraint)` for `measured` components.
- An event payload field named `value` or `emitter` no longer breaks the generated C++ with a redefinition error: the shim's parameters carry a `p_` prefix and the payload local is `rn_payload`.
- The generated host component context has `window()` and `with_window()`.
- The generated host component context has `app()`, which returns the GPUI `App` of the call the component was made in.

## 0.87.0-alpha.0 - 2026-11-01

- First release.
- Generates Rust and C++ specs for Turbo Native Modules and host components, plugged into `@react-native/codegen`.
