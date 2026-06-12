# Unistyles Gotchas

This app uses [`react-native-unistyles` v3](https://www.unistyl.es/) for theme-aware styles. Unistyles is fast because most style updates do not go through React renders: the [Babel plugin](https://www.unistyl.es/v3/other/babel-plugin) rewrites React Native component imports, attaches style metadata, and lets the native ShadowRegistry update tracked views when theme or runtime dependencies change.

That model is powerful, but it has sharp edges. Use this note when adding theme-dependent styles.

## STOP — `useUnistyles()` Is Banned

**Do not call `useUnistyles()`. Anywhere. New code MUST NOT add a call; existing call sites are tolerated only because nobody has rewritten them yet and will be converted as they are touched.** The library authors themselves [strongly advise against it](https://www.unistyl.es/v3/references/use-unistyles):

> We strongly recommend **not using** this hook, as it will re-render your component on every change. This hook was created to simplify the migration process and should only be used when other methods fail.

We have hit this gotcha repeatedly in Paseo. The hook subscribes the component to **every** Unistyles runtime change (theme, breakpoint, insets, color scheme, scale) and returns a fresh object reference each call. That means a periodic lockstep re-render of warm subtrees (agent streams, panels, sidebars) even when nothing the user can see has changed — confirmed in profiling, with `theme` as the only changed input every cycle. It also breaks every downstream `useMemo`/`memo` boundary that includes a derived theme value.

Reviewers MUST reject PRs that introduce a new `useUnistyles()` call. There is no last-resort carveout. If you cannot solve a case with the alternatives below, file an issue and stop — do not paper over it with the hook.

Use these alternatives in order:

### 1. `StyleSheet.create((theme) => ...)` — default

Most theme-aware styling needs nothing else. The Babel plugin tracks theme dependencies inside the factory and updates the native ShadowTree without any React re-render.

```tsx
const styles = StyleSheet.create((theme) => ({
  container: {
    backgroundColor: theme.colors.surface0,
    padding: theme.spacing[4],
  },
}));

<View style={styles.container} />;
```

If you are reading a theme value just to feed it back into a `style` prop, you almost certainly want this and not the hook.

### 2. Hard-coded constants for genuinely static values

If you only need a number that happens to live on the theme (e.g. a fixed spacing value used to compute a gap or animation distance), use a literal constant or import a static module. Static reads do not need a subscription. See the "Static Theme Imports" section below — importing `baseColors`, theme-name constants, or `type Theme` is fine when the value is intentionally static.

### 3. `withUnistyles(Component)` for third-party props

When a third-party component takes a non-`style` prop that must be theme-reactive (e.g. `BlurView.tint`, `Image.tintColor`, navigator option props, bottom-sheet `backgroundStyle`), wrap that single component with `withUnistyles`. Only the wrapper re-renders, not the surrounding tree.

```tsx
const ThemedBlur = withUnistyles(BlurView);
<ThemedBlur tint={theme.colors.surface0} />;
```

(Mind the `> *` child-selector leak documented further down.)

### 4. There is no "last resort"

There is no escape hatch. If none of (1)–(3) fit, the problem is upstream — fix it there or file an issue. The hook is not on the table.

## How Updates Propagate

For standard React Native components, the [Unistyles Babel plugin](https://www.unistyl.es/v3/other/babel-plugin) rewrites imports such as `View`, `Text`, `Pressable`, and `ScrollView` to Unistyles-aware component factories. On native, those factories borrow the component ref and register the `style` prop with the ShadowRegistry. The upstream ["Why my view doesn't update?"](https://www.unistyl.es/v3/guides/why-my-view-doesnt-update) guide describes this as the ShadowTree update path that avoids unnecessary React re-renders.

The important detail: the automatic native path tracks `props.style`. It does not generally track every prop that happens to carry style-like values.

[`useUnistyles()`](https://www.unistyl.es/v3/references/use-unistyles) is different. It gives React access to the current theme/runtime and can make a component re-render when those values change. Use it for values that must be rendered through React props, such as icon colors or small escape hatches. Do not expect direct reads from `UnistylesRuntime` to re-render a component; [issue #817](https://github.com/jpudysz/react-native-unistyles/issues/817) is a useful reminder of that invariant.

## Dynamic Pixel Styles On Web

Avoid feeding changing pixel values such as `{ top, left }`, `{ maxHeight }`, or `{ minWidth }` into the `style` prop of Unistyles-managed React Native components on web. The web runtime hashes each distinct style object by value and appends a CSS rule to `#unistyles-web`; those rules are not reclaimed during the page lifetime, so pointer-driven positioning can turn into steady stylesheet growth.

Use the inline style escape hatch below for high-churn values. Do not split a component into plain/web/native variants just to keep one measured value out of the CSS registry. Raw DOM wrappers are reserved for real DOM infrastructure, such as terminal hosts, virtualized web rows, or third-party drag wrappers.

## Inline Style Escape Hatch

When a style value is high-churn and must bypass Unistyles' CSS registry, keep the component on the normal Unistyles path and mark only that style object with `inlineUnistylesStyle`.

```tsx
import { inlineUnistylesStyle } from "@/styles/unistyles-inline-style";

const styles = StyleSheet.create({
  thumb: {
    position: "absolute",
  },
});

<View style={[styles.thumb, inlineUnistylesStyle({ height, transform: [{ translateY }] })]} />;
```

This uses Unistyles' own animated-style lane: ordinary styles still become Unistyles classes, while the marked style object stays in React Native's inline style array. Use it for measured geometry, scroll or drag transforms, and pressed/hovered/open state where generating CSS classes is the wrong ownership boundary.

Do not split a component into plain and Unistyles variants just to handle one high-churn value. The component remains a normal Unistyles component; only the specific style object escapes.

When a reusable component has a prop whose whole job is dynamic geometry, make that prop the seam. For example, `FloatingSurface.frameStyle` and `FloatingScrollView.style` own their own escape hatch so menu, tooltip, hover-card, and combobox callers can stay declarative instead of knowing about Unistyles internals.

Do not flatten a caller-provided style array and pass the flattened object back to a React Native component. Unistyles style entries carry `unistyles_*` metadata; flattening two entries produces one object with multiple metadata keys and triggers the runtime warning: "use array syntax instead of object syntax." Preserve caller styles as arrays, and only flatten the dynamic geometry value you explicitly own. If that owned value was flattened from a mixed style prop, strip `unistyles_*` metadata before sending it through `inlineUnistylesStyle`.

## Main Gotcha: `contentContainerStyle`

`ScrollView.contentContainerStyle` is the canonical trap. It looks like a style prop, but it is not the same prop that Unistyles' remapped native component registers by default. The upstream tutorial calls this out directly in its [ScrollView Background Issue](https://www.unistyl.es/v3/tutorial/settings-screen#scrollview-background-issue) section.

Avoid this pattern when the style depends on the theme:

```tsx
<ScrollView contentContainerStyle={styles.container} />;

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
  <ScrollView contentContainerStyle={styles.contentContainer}>{children}</ScrollView>
</View>;

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

In practice the wrapper-`View` pattern is the one we use. Across the app, `withUnistyles` is now reserved for wrapping leaf components — mostly lucide icons (`ThemedActivityIndicator`, `ThemedChevronDown`, …) and small third-party components like `MarkdownWithStableRenderer` — so they pick up theme-reactive `color`/`tintColor` props without re-rendering their parent.

In principle, [`withUnistyles`](https://www.unistyl.es/v3/references/with-unistyles) can also wrap a `ScrollView` to make `contentContainerStyle` theme-reactive via its [auto-mapping behavior for `style` and `contentContainerStyle`](https://www.unistyl.es/v3/references/with-unistyles#auto-mapping-for-style-and-contentcontainerstyle-props). We previously did this on the welcome screen and hit the `> *` child-selector leak documented below; we have since moved the welcome screen to the wrapper-`View` pattern. If you find yourself reaching for `withUnistyles(ScrollView)`, treat it as a smell and check whether a wrapper view works first.

The smallest escape hatch is to use `useUnistyles()` and pass an inline value through React:

```tsx
const { theme } = useUnistyles();

<ScrollView
  contentContainerStyle={[styles.contentContainer, { backgroundColor: theme.colors.surface0 }]}
/>;
```

Use this sparingly. It works because React re-renders the prop, but it gives up the main Unistyles native-update path for that value.

## `withUnistyles` And The `> *` Child-Selector Leak

`withUnistyles` on a component with a theme-dependent `style` prop works by wrapping the component in a `<div style={{display: 'contents'}} className={hash}>` and emitting the style under a `.hash > *` child selector so the styles cascade onto the wrapped component. This is how auto-mapping for `style` and `contentContainerStyle` works on web.

The sharp edge: Unistyles hashes styles by value. If `withUnistyles` receives a style whose value is **identical** to a style used elsewhere in the app on a plain `View`, both usages get the same hash — and both CSS rules (the element rule and the `> *` child rule) are emitted under the same class name. The `> *` rule then leaks onto the direct children of every `View` that shares the hash.

Concrete regression we hit: `welcome-screen.tsx` had `const ThemedScrollView = withUnistyles(ScrollView)` with `style={{ flex: 1, backgroundColor: theme.colors.surface0 }}`. `panels/agent-panel.tsx` had `root` and `container` styles with the exact same value. All three collided on class `unistyles_j2k2iilhfz`, so the browser stylesheet contained:

```css
.unistyles_j2k2iilhfz {
  flex: 1 1 0%;
  background-color: var(--colors-surface0);
}
.unistyles_j2k2iilhfz > * {
  flex: 1 1 0%;
  background-color: var(--colors-surface0);
}
```

The child-selector rule forced `flex:1` and `background-color: surface0` onto the Composer's outer `Animated.View` (a direct child of `container`), stretching it to fill remaining space and leaving a large empty gap between the composer UI and the bottom of the screen. It also painted a `surface0` band behind the scroll-to-bottom button. The bug only appeared in the browser — Electron skips `WelcomeScreen` after pairing, so the `> *` rule was never injected there.

Symptoms to watch for:

- A sibling of a themed panel-background `View` stretches unexpectedly on web only.
- Random direct children of a `{ flex: 1, backgroundColor: surface0 }` `View` pick up an unexpected background.
- DevTools shows a `.unistyles_xxx > *` rule you did not write.

Quick confirmation in DevTools console:

```js
[...document.styleSheets]
  .flatMap((s) => [...(s.cssRules || [])])
  .map((r) => r.cssText)
  .filter((t) => t.includes("unistyles") && t.includes("> *"));
```

Any match beyond benign `r-pointerEvents-* > *` rules from react-native-web is a leak.

Avoid the bug by preferring the wrapper-`View` pattern from the previous section whenever possible: put `{ flex: 1, backgroundColor: surface0 }` on a plain `View` and give the `ScrollView` a theme-free `style`/`contentContainerStyle`. That keeps `withUnistyles` off the hot path and avoids the hash collision. Only reach for `withUnistyles(ScrollView)` when a wrapper view is genuinely awkward, and when you do, give the wrapped style a distinctive shape (extra key, different layout) so it does not hash-collide with a common panel background used elsewhere.

## Hidden Sheet Content

`@gorhom/bottom-sheet` can keep `BottomSheetModal` content mounted while the sheet is hidden. That matters during Paseo's startup theme transition: a header node can be created under the initial adaptive theme, stay hidden, then appear later with stale native style values even though surrounding content has re-rendered correctly.

We saw this in `AdaptiveModalSheet`: the body text and buttons were dark-theme-correct, but the shared sheet title opened with the initial light-theme text color on a dark sheet background. For tiny values in a reusable sheet header, prefer the inline escape hatch:

```tsx
const { theme } = useUnistyles();

<Text style={[styles.title, { color: theme.colors.foreground }]}>{title}</Text>;
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

Wrap the icon (or other leaf component) with `withUnistyles` instead, so only that node re-renders when the theme changes:

```tsx
import { ChevronDown } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";

const ThemedChevronDown = withUnistyles(ChevronDown);

const styles = StyleSheet.create((theme) => ({
  icon: { color: theme.colors.foregroundMuted },
}));

<ThemedChevronDown size={theme.iconSize.md} style={styles.icon} />;
```

This is the dominant pattern in the app today (see `sidebar-workspace-list.tsx`, `message.tsx`, the workspace screens). Reserve `useUnistyles()` for the last-resort cases described at the top of this file. Importing `baseColors`, theme-name constants, or `type Theme` is fine when the value is intentionally static or type-only.

## Reanimated `Animated.View` + Dynamic Styles Crashes

Do not apply `StyleSheet.create((theme) => ...)` styles to a Reanimated `Animated.View`. Unistyles wraps styled components in a `<UnistylesComponent>` and patches native view props from C++ via the ShadowRegistry. Reanimated also reaches into the same native node from its worklet runtime. When a theme change fires, both systems try to mutate the same node and the app crashes with `Unable to find node on an unmounted component.` This was a real iOS sidebar crash on theme toggle (commit `4896cfe9`).

Fix: keep static positioning on the `Animated.View` in plain React Native `StyleSheet`, and pass theme-dependent values (e.g. `backgroundColor`) as inline style from `useUnistyles()` — the inline path is acceptable here because no other escape works:

```tsx
import { StyleSheet as RNStyleSheet } from "react-native";
import Animated from "react-native-reanimated";
import { useUnistyles } from "react-native-unistyles";

const positionStyles = RNStyleSheet.create({
  sidebar: { position: "absolute", inset: 0, width: 280 },
});

function Sidebar() {
  const { theme } = useUnistyles();
  return (
    <Animated.View
      style={[positionStyles.sidebar, animatedStyle, { backgroundColor: theme.colors.surface1 }]}
    />
  );
}
```

This is one of the rare places `useUnistyles()` is the right tool: there is no `withUnistyles(Animated.View)` equivalent, the affected component is small, and the alternative is a crash.

## Adaptive Themes And Persisted Settings

Unistyles [`initialTheme`](https://www.unistyl.es/v3/guides/theming#select-theme) and [`adaptiveThemes`](https://www.unistyl.es/v3/guides/theming#adaptive-themes) are mutually exclusive. `initialTheme` can be a string or a synchronous function, but it cannot wait on async storage.

Paseo currently stores app settings in AsyncStorage and loads them through react-query. That means the app can mount under adaptive/system theme first, then switch after settings load:

1. Unistyles config starts with `adaptiveThemes: true`.
2. The device may report system light.
3. Settings load a persisted non-auto preference, such as dark.
4. The app calls `setAdaptiveThemes(false)` and `setTheme("dark")`.

That brief transition is expected with the current storage model. It makes tracking-compatible styles important: anything mounted during the initial adaptive theme must update correctly after the persisted preference applies. [Issue #550](https://github.com/jpudysz/react-native-unistyles/issues/550) was a separate ScrollView sticky-header bug, but it is still useful context for why ScrollView theme updates deserve extra suspicion.

If we ever need to avoid the transition entirely, store at least the theme preference in synchronous storage and configure Unistyles with `initialTheme`.

## Runtime Theme Patching For User Preferences

Appearance settings (UI/mono font family, font sizes, syntax-highlight theme) are applied by patching every registered theme at runtime with `UnistylesRuntime.updateTheme(name, updater)` — not by threading preference reads through components. `applyAppearance` in `packages/app/src/screens/settings/appearance/apply-appearance.ts` runs from a `ProvidersWrapper` effect on settings load/change and loops all six theme keys, returning `{ ...theme, fontFamily, fontSize, lineHeight, colors.syntax }`.

This works without `useUnistyles()` because every consumer already reads these tokens through `StyleSheet.create((theme) => …)` (or the `withUnistyles`/`uniProps` path for the markdown renderer), so patching the theme repaints tracked views through the native ShadowRegistry with no React re-render.

Gotchas:

- **Patch all themes, not just the active one.** The active theme can change and adaptive mode can flip light/dark; patching every key keeps the active key current and makes ordering vs `setTheme`/`setAdaptiveThemes` irrelevant. The effect depends on the settings values (not on `theme`), so it cannot loop.
- **Narrow the discriminated union before spreading.** `updateTheme`'s updater returns the theme union; spreading the union widens `colorScheme` to `"light" | "dark"`, which is assignable to neither concrete member. Branch on `t.colorScheme` so each branch spreads a single narrowed theme type (no `as`).
- **`lineHeight.diff` is the code/diff line-height axis** — it is coupled to the code-font-size control (≈ `codeFontSize * 1.5`). Do NOT use it for prose. Markdown body line-height scales with the UI ramp (`Math.round(theme.fontSize.base * 1.4)`); routing prose through `lineHeight.diff` clips text at small code sizes.
- **High-churn draft values** (live-while-typing in the appearance preview) bypass the theme: apply them as inline styles marked with `inlineUnistylesStyle` so per-keystroke values don't grow the `#unistyles-web` CSS registry.
- **Mounted parsed content uses `AppearanceStyleBoundary`.** Markdown, syntax-highlighted code, and tool-call detail bodies can contain memoized/custom renderer trees that do not naturally re-run when runtime-patched appearance tokens change. Wrap the parsed surface once with `packages/app/src/components/appearance-style-boundary.tsx`; do not add local "appearance key" props at each callsite.
- **Dynamic font tokens stay widened.** `fontFamily`, `fontSize`, and `lineHeight` on `commonTheme` are annotated `string`/`number` (not narrowed by `as const`) so the updater's return assigns; the platform default stacks live in `DEFAULT_UI_FONT_STACK` / `DEFAULT_MONO_FONT_STACK`.

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

The welcome-screen investigation used this approach to prove the white layer was the `ScrollView` content container.

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
