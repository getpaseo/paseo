import React, { forwardRef, useSyncExternalStore } from "react";
import * as Native from "react-native";

// GPUI has Fabric but no Nitro/Unistyles shadow-tree bindings. Keep the app's
// style factories and theme API; this backend updates subscribed React views.
const listeners = new Set();
const resolveStyle = Symbol("paseo.gpui.style");
let revision = 0;
let themes = {};
let themeName = "dark";
let adaptive = true;
let breakpoints = {};
const emit = () => {
  revision += 1;
  for (const listener of listeners) listener();
};
const subscribe = (listener) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
const snapshot = () => revision;
const theme = () => themes[themeName];
const runtime = () => ({
  themeName,
  colorScheme: Native.Appearance.getColorScheme() ?? "light",
  screen: Native.Dimensions.get("window"),
  insets: { top: 0, bottom: 0, left: 0, right: 0, ime: 0 },
  pixelRatio: Native.PixelRatio.get(),
  fontScale: Native.PixelRatio.getFontScale(),
  breakpoint: Object.keys(breakpoints).findLast(
    (key) => breakpoints[key] <= Native.Dimensions.get("window").width,
  ),
});
Native.Dimensions.addEventListener("change", emit);
Native.Appearance.addChangeListener(({ colorScheme }) => {
  if (adaptive && themes[colorScheme]) themeName = colorScheme;
  emit();
});
function responsive(value) {
  if (Array.isArray(value)) return value.map(responsive);
  if (!value || typeof value !== "object") return value;
  if (Object.getPrototypeOf(value) !== Object.prototype) return value;
  const keys = Object.keys(value);
  if (keys.length && keys.every((key) => key in breakpoints)) {
    const width = Native.Dimensions.get("window").width;
    const key = keys
      .sort((a, b) => breakpoints[a] - breakpoints[b])
      .findLast((candidate) => breakpoints[candidate] <= width);
    return key === undefined ? undefined : responsive(value[key]);
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, responsive(item)]));
}
function materialize(style) {
  if (Array.isArray(style)) return style.map(materialize);
  if (style && typeof style === "object" && style[resolveStyle]) return style[resolveStyle]();
  return style;
}
function styledProps(props) {
  const result = { ...props };
  for (const key of ["style", "contentContainerStyle"]) {
    if (typeof props[key] === "function")
      result[key] = (...args) => materialize(props[key](...args));
    else if (props[key]) result[key] = materialize(props[key]);
  }
  return result;
}
export const UnistylesRuntime = {
  get themeName() {
    return themeName;
  },
  get breakpoint() {
    return runtime().breakpoint;
  },
  get colorScheme() {
    return runtime().colorScheme;
  },
  getTheme: theme,
  setTheme(name) {
    if (!themes[name]) throw new Error(`Unknown GPUI theme: ${name}`);
    themeName = name;
    emit();
  },
  updateTheme(name, update) {
    themes[name] = update(themes[name]);
    emit();
  },
  setAdaptiveThemes(value) {
    adaptive = value;
    if (value && themes[runtime().colorScheme]) themeName = runtime().colorScheme;
    emit();
  },
};
export const StyleSheet = {
  ...Native.StyleSheet,
  configure(config) {
    themes = config.themes;
    breakpoints = config.breakpoints;
    adaptive = config.settings?.adaptiveThemes ?? false;
    themeName =
      config.settings?.initialTheme ?? (adaptive ? runtime().colorScheme : Object.keys(themes)[0]);
    emit();
  },
  create(factory) {
    const evaluate = () => (typeof factory === "function" ? factory(theme(), runtime()) : factory);
    const initial = evaluate();
    const sheet = {};
    for (const key of Object.keys(initial)) {
      const wrap = (args) => {
        const resolve = () => {
          const value = evaluate()[key];
          return responsive(typeof value === "function" ? value(...args) : value);
        };
        return Object.defineProperty({ ...resolve() }, resolveStyle, { value: resolve });
      };
      sheet[key] = typeof initial[key] === "function" ? (...args) => wrap(args) : wrap([]);
    }
    return sheet;
  },
};
// Existing consumers retain this API; new app code should use style factories.
export function useUnistyles() {
  useSyncExternalStore(subscribe, snapshot, snapshot);
  return { theme: theme(), rt: runtime() };
}
export function withUnistyles(Component, mappings) {
  const Wrapped = forwardRef(function GpuiThemed(props, ref) {
    useSyncExternalStore(subscribe, snapshot, snapshot);
    const { uniProps, ...rest } = props;
    return React.createElement(Component, {
      ...styledProps({
        ...mappings?.(theme(), runtime()),
        ...uniProps?.(theme(), runtime()),
        ...rest,
      }),
      ref,
    });
  });
  return Wrapped;
}
export const createUnistylesElement = withUnistyles;
