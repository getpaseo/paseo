# Mobile Testing

## Maestro

Maestro flows live in `packages/app/maestro/`. Reusable sub-flows live in `packages/app/maestro/flows/`.

Run a flow:

```bash
maestro test packages/app/maestro/my-flow.yaml
```

### Screenshots

`takeScreenshot` writes to the **current working directory** — there's no way to configure the output path in the YAML. To keep screenshots out of the checkout, `cd` into a temp directory and use an absolute path for the flow:

```bash
FLOW="$(pwd)/packages/app/maestro/my-flow.yaml"
mkdir -p /tmp/maestro-out
cd /tmp/maestro-out && maestro test "$FLOW"
```

`packages/app/maestro/.gitignore` excludes `*.png` as a safety net.

### Element targeting

Use `testID` or `nativeID` on components, then target with `id:` in flows. Prefer this over text matching — text breaks on copy changes.

```tsx
// Component
<Pressable testID="sidebar-sessions" onPress={onPress}>
```

```yaml
# Flow
- tapOn:
    id: "sidebar-sessions"
- assertVisible:
    id: "sidebar-sessions"
```

### Conditional steps

Use `runFlow:when:visible` for steps that should only execute when a specific element is on screen:

```yaml
- runFlow:
    when:
      visible:
        id: "sidebar-sessions"
    commands:
      - swipe:
          direction: LEFT
          duration: 300
```

This is how `flows/dev-client.yaml` handles Expo dev client screens that only appear in dev builds.

### Don't use launchApp against a running dev app

`launchApp` kills and restarts the app, disrupting Expo dev client state and host connections. For flows that test against an already-running dev app, **omit launchApp entirely** — just interact with whatever is on screen.

Use `launchApp` only in flows that need a clean start (e.g., onboarding tests).

### Swipe gestures

Use `start`/`end` with percentage coordinates for precise control:

```yaml
# Edge swipe from left to open sidebar
- swipe:
    start: "5%,50%"
    end: "80%,50%"
    duration: 300
```

`direction: RIGHT` is simpler but less precise — use it for generic swipes, use coordinates when the start position matters (edge gestures, avoiding specific UI regions).

### Assertions

`assertVisible` checks **actual screen visibility**, not just view tree presence. An element that exists in the tree but is off-screen (e.g., `translateX: -400`) will correctly fail `assertVisible`. This makes it reliable for catching animation bugs where state says "open" but the view is visually hidden.

For async elements, use `extendedWaitUntil`:

```yaml
- extendedWaitUntil:
    visible: ".*Online.*"
    timeout: 90000
```

### Dev client handling

Two reusable flows handle Expo dev client screens after launch:

- `flows/launch.yaml` — handles dev launcher, dismisses dev menu, asserts "Welcome to Paseo"
- `flows/dev-client.yaml` — same but without asserting a particular app route

## Self-verification loops

Maestro can only interact with the app UI — it can't toggle iOS appearance, change locale, or simulate network conditions. For bugs that depend on system-level state, wrap Maestro in a bash script that handles the system changes between Maestro runs.

This pattern also lets agents self-verify fixes without manual user testing.

### Pattern

1. Run baseline Maestro flow (confirm feature works)
2. Make system-level change via `xcrun simctl` (toggle appearance, etc.)
3. Re-run Maestro flow (confirm feature still works)
4. Repeat N iterations to catch intermittent failures

Scripts run `maestro test` from inside a temp directory so screenshots don't dirty the checkout.

See `packages/app/maestro/test-sidebar-theme.sh` for the canonical example:

```bash
bash packages/app/maestro/test-sidebar-theme.sh 6 1
# Args: iterations=6, wait_seconds=1 between toggle and test
```

Key elements of the script pattern:

```bash
set -euo pipefail
ITERATIONS="${1:-3}"

for i in $(seq 1 "$ITERATIONS"); do
  # Toggle system state
  xcrun simctl ui booted appearance light

  # Wait for change to propagate
  sleep 1

  # Run Maestro flow and capture result
  if maestro test "$FLOW" 2>&1 | tee "$ITER_DIR/test.log"; then
    echo "PASS"
  else
    echo "FAIL"
    xcrun simctl io booted screenshot "$ITER_DIR/failure-state.png"
  fi
done
```

## Unistyles + Reanimated

### The crash

Applying Unistyles theme-reactive styles (`StyleSheet.create((theme) => ...)`) directly to `Animated.View` causes **"Unable to find node on an unmounted component"** on theme change.

Unistyles wraps styled components in `<UnistylesComponent>` and patches native view properties via C++. Reanimated also manages the same native node for animated transforms. When the theme changes, both systems try to update the node simultaneously and the view crashes.

### The fix

Use plain React Native `StyleSheet.create` for static positioning on `Animated.View`. Pass theme-dependent values as inline styles from `useUnistyles()`:

```tsx
// BAD: Unistyles dynamic style on Animated.View
const styles = StyleSheet.create((theme) => ({
  sidebar: {
    position: "absolute",
    top: 0,
    left: 0,
    bottom: 0,
    backgroundColor: theme.colors.surfaceSidebar, // theme-reactive
    overflow: "hidden",
  },
}));

<Animated.View style={[styles.sidebar, animatedStyle]} />
```

```tsx
// GOOD: static stylesheet + inline theme values
import { StyleSheet as RNStyleSheet } from "react-native";

const staticStyles = RNStyleSheet.create({
  sidebar: {
    position: "absolute",
    top: 0,
    left: 0,
    bottom: 0,
    overflow: "hidden",
  },
});

const { theme } = useUnistyles();

<Animated.View
  style={[staticStyles.sidebar, animatedStyle, { backgroundColor: theme.colors.surfaceSidebar }]}
/>
```

Regular `View` components can safely use Unistyles dynamic styles — the conflict is specific to `Animated.View`.

## iOS Simulator

```bash
# Screenshot
xcrun simctl io booted screenshot /tmp/screenshot.png

# Dark/light mode
xcrun simctl ui booted appearance          # check current
xcrun simctl ui booted appearance dark     # set dark
xcrun simctl ui booted appearance light    # set light
```

Expo dev server logs are in the tmux pane running `npm run dev`. Daemon logs are at `$PASEO_HOME/daemon.log` (see [DEVELOPMENT.md](DEVELOPMENT.md)).
