# Unistyles Gotchas

This app uses [`react-native-unistyles` v3](https://www.unistyl.es/) for theme-aware styles. Unistyles is fast because most style updates do not go through React renders: the [Babel plugin](https://www.unistyl.es/v3/other/babel-plugin) rewrites React Native component imports, attaches style metadata, and lets the native ShadowRegistry update tracked views when theme or runtime dependencies change.

That model is powerful, but it has sharp edges. Use this note when adding theme-dependent styles.

## How Updates Propagate

For standard React Native components, the [Unistyles Babel plugin](https://www.unistyl.es/v3/other/babel-plugin) rewrites imports such as `View`, `Text`, `Pressable`, and `ScrollView` to Unistyles-aware component factories. On native, those factories borrow the component ref and register the `style` prop with the ShadowRegistry. The upstream ["Why my view doesn't update?"](https://www.unistyl.es/v3/guides/why-my-view-doesnt-update) guide describes this as the ShadowTree update path that avoids unnecessary React re-renders.

The important detail: the automatic native path tracks `props.style`. It does not generally track every prop that happens to carry style-like values.

[`useUnistyles()`](https://www.unistyl.es/v3/references/use-unistyles) is different. It gives React access to the current theme/runtime and can make a component re-render when those values change. Use it for values that must be rendered through React props, such as icon colors or small escape hatches. Do not expect direct reads from `UnistylesRuntime` to re-render a component; [issue #817](https://github.com/jpudysz/react-native-unistyles/issues/817) is a useful reminder of that invariant.

## Main Gotcha: `contentContainerStyle`

`ScrollView.contentContainerStyle` is the canonical trap. It looks like a style prop, but it is not the same prop that Unistyles' remapped native component registers by default. The upstream tutorial calls this out directly in its [ScrollView Background Issue](https://www.unistyl.es/v3/tutorial/settings-screen#scrollview-background-issue) section.

Avoid this pattern when the style depends on the theme:

```tsx
<ScrollView contentContainerStyle={styles.container} />

const styles = StyleSheet.create((theme) => ({
  container: {
    flexGrow: 1,
    backgroundColor: theme.colors.surface0,
  },
}));
```

On first mount this can paint with the current adaptive or initial theme. If app settings later load a persisted theme and call [`UnistylesRuntime.setTheme`](https://www.unistyl.es/v3/guides/theming#change-theme), the JS-side style proxy may report the new theme while the native content container keeps the old background. That is how the welcome screen ended up with a light background and dark foreground/buttons.

This applies broadly to non-`style` props that carry theme-dependent values, such as component props named `color`, `trackColor`, `tintColor`, `backgroundStyle`, `handleIndicatorStyle`, and other library-specific style props. The [3rd-party view decision algorithm](https://www.unistyl.es/v3/references/3rd-party-views) recommends explicit handling for these cases, and [issue #1030](https://github.com/jpudysz/react-native-unistyles/issues/1030) shows a related native-prop update edge case around `Image.tintColor`. Treat these values as React props unless wrapped with `withUnistyles`.

## Fix Patterns

Preferred pattern: put themed backgrounds on a normal wrapper view, and keep `contentContainerStyle` theme-free.

```tsx
<View style={styles.container}>
  <ScrollView contentContainerStyle={styles.contentContainer}>
    {children}
  </ScrollView>
</View>

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
  contentContainer: {
    flexGrow: 1,
    padding: theme.spacing[4],
  },
}));
```

This is the pattern used by the settings screen: the screen background lives on a normal `View style={styles.container}`, while the scroll content container only carries layout.

When the content container itself needs themed behavior, wrap the component with [`withUnistyles`](https://www.unistyl.es/v3/references/with-unistyles):

```tsx
import { ScrollView } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";

const ThemedScrollView = withUnistyles(ScrollView);

<ThemedScrollView
  style={styles.scrollView}
  contentContainerStyle={styles.contentContainer}
/>
```

`withUnistyles` extracts dependency metadata from both `style` and `contentContainerStyle`, subscribes to the relevant theme/runtime changes, and re-renders only that wrapped component when needed. Its [auto-mapping behavior for `style` and `contentContainerStyle`](https://www.unistyl.es/v3/references/with-unistyles#auto-mapping-for-style-and-contentcontainerstyle-props) is the reason it fixes themed `ScrollView` content containers. Reach for it when wrapper-view layout would be awkward or when a third-party component needs theme-aware non-`style` props mapped through Unistyles.

The smallest escape hatch is to use `useUnistyles()` and pass an inline value through React:

```tsx
const { theme } = useUnistyles();

<ScrollView
  contentContainerStyle={[
    styles.contentContainer,
    { backgroundColor: theme.colors.surface0 },
  ]}
/>
```

Use this sparingly. It works because React re-renders the prop, but it gives up the main Unistyles native-update path for that value.

## Hidden Sheet Content

`@gorhom/bottom-sheet` can keep `BottomSheetModal` content mounted while the sheet is hidden. That matters during Paseo's startup theme transition: a header node can be created under the initial adaptive theme, stay hidden, then appear later with stale native style values even though surrounding content has re-rendered correctly.

We saw this in `AdaptiveModalSheet`: the body text and buttons were dark-theme-correct, but the shared sheet title opened with the initial light-theme text color on a dark sheet background. For tiny values in a reusable sheet header, prefer the inline escape hatch:

```tsx
const { theme } = useUnistyles();

<Text style={[styles.title, { color: theme.colors.foreground }]}>
  {title}
</Text>
```

Keep layout and typography in `StyleSheet.create`; move only the stale theme-dependent value through React. If a larger subtree shows the same behavior, consider remounting the sheet on theme changes or moving the themed paint onto a wrapper that is mounted with the visible content.

The same rule applies to bottom-sheet component props such as `backgroundStyle` and `handleIndicatorStyle`: they are library props, not the direct React Native `style` prop Unistyles registers. Prefer a custom `backgroundComponent` that calls `useUnistyles()`, or pass a small inline object from the hook theme.

## Memoized Style Objects

When a third-party library receives a plain style object, it is outside Unistyles' native tracking path. Make sure any memo that builds that style object depends on the actual theme values it reads.

Avoid indirect keys like this:

```tsx
const { theme, rt } = useUnistyles();
const markdownStyles = useMemo(() => createMarkdownStyles(theme), [rt.themeName]);
```

On adaptive system-theme changes, the hook can provide a light/dark theme update while an indirect runtime key is not the value that invalidates the memo. That leaves the library rendering stale colors. Assistant markdown hit this exact failure: the workspace shell switched to light, but assistant text and code spans kept the old dark-theme markdown style object.

Prefer the hook theme itself, or explicit theme tokens, as the dependency:

```tsx
const { theme } = useUnistyles();
const markdownStyles = useMemo(() => createMarkdownStyles(theme), [theme]);
```

If a style factory is cheap, skipping `useMemo` entirely is also fine.

## Static Theme Imports

Do not import `theme` from `@/styles/theme` for live UI colors. That export is a dark-theme compatibility default, so using it in render code leaves icons, placeholders, or third-party props pinned to dark colors in light mode.

Use `useUnistyles()` inside the component instead:

```tsx
const { theme } = useUnistyles();

<ChevronDown size={theme.iconSize.md} color={theme.colors.foregroundMuted} />
```

Importing `baseColors`, theme-name constants, or `type Theme` is fine when the value is intentionally static or type-only.

## Adaptive Themes And Persisted Settings

Unistyles [`initialTheme`](https://www.unistyl.es/v3/guides/theming#select-theme) and [`adaptiveThemes`](https://www.unistyl.es/v3/guides/theming#adaptive-themes) are mutually exclusive. `initialTheme` can be a string or a synchronous function, but it cannot wait on async storage.

Paseo currently stores app settings in AsyncStorage and loads them through react-query. That means the app can mount under adaptive/system theme first, then switch after settings load:

1. Unistyles config starts with `adaptiveThemes: true`.
2. The device may report system light.
3. Settings load a persisted non-auto preference, such as dark.
4. The app calls `setAdaptiveThemes(false)` and `setTheme("dark")`.

That brief transition is expected with the current storage model. It makes tracking-compatible styles important: anything mounted during the initial adaptive theme must update correctly after the persisted preference applies. [Issue #550](https://github.com/jpudysz/react-native-unistyles/issues/550) was a separate ScrollView sticky-header bug, but it is still useful context for why ScrollView theme updates deserve extra suspicion.

If we ever need to avoid the transition entirely, store at least the theme preference in synchronous storage and configure Unistyles with `initialTheme`.

## Debugging

To inspect what the Babel plugin sees, temporarily enable [`debug: true`](https://www.unistyl.es/v3/other/babel-plugin#debug) in `packages/app/babel.config.js`:

```js
[
  "react-native-unistyles/plugin",
  {
    root: "src",
    debug: true,
  },
],
```

Then rebuild the bundle and look for lines such as:

```text
src/components/welcome-screen.tsx: styles.container: [Theme]
```

This only confirms that the stylesheet dependency was detected. The upstream debugging guide makes the same distinction: dependency detection is only one failure mode. It does not prove the style prop is registered on the native view you care about.

For paint-layer bugs, use high-contrast probes:

1. Paint each candidate layer a distinct color, such as root wrapper cyan, `ScrollView.style` yellow, and `contentContainerStyle` magenta.
2. Cold-restart the app, not just Fast Refresh.
3. Screenshot the simulator and sample pixels to see which color fills the area.
4. Remove the probes before committing.

The welcome-screen investigation used this approach to prove the white layer was the `ScrollView` content container. Deep-dive evidence is in [welcome-theme-split-research.md](/Users/moboudra/.paseo/notes/welcome-theme-split-research.md).

## References

- [Unistyles v3 documentation](https://www.unistyl.es/)
- [Theming: initial theme, adaptive themes, and runtime theme changes](https://www.unistyl.es/v3/guides/theming)
- [ScrollView Background Issue](https://www.unistyl.es/v3/tutorial/settings-screen#scrollview-background-issue)
- [withUnistyles reference](https://www.unistyl.es/v3/references/with-unistyles)
- [3rd-party view decision algorithm](https://www.unistyl.es/v3/references/3rd-party-views)
- [Babel plugin debug option](https://www.unistyl.es/v3/other/babel-plugin#debug)
- [Why my view doesn't update?](https://www.unistyl.es/v3/guides/why-my-view-doesnt-update)
- [GitHub issue #550: ScrollView sticky-header theme updates](https://github.com/jpudysz/react-native-unistyles/issues/550)
- [GitHub issue #817: `UnistylesRuntime.themeName` does not re-render](https://github.com/jpudysz/react-native-unistyles/issues/817)
- [GitHub issue #1030: `Image.tintColor` and native style update edge case](https://github.com/jpudysz/react-native-unistyles/issues/1030)
- [Local research note: welcome theme split](</Users/moboudra/.paseo/notes/welcome-theme-split-research.md>)
