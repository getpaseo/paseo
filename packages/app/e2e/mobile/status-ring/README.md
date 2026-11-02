# Native retained status-ring regression

This runs the production native ring and clock inside real retained panels with
Reanimated on Android. A probe consumes the same public rotation hook and counts
UI-runtime value changes. No Reanimated mocks or provider processes are used.

Use an Android development client compatible with the checkout's native dependencies.
In a disposable checkout, temporarily replace `packages/app/index.ts` with:

```tsx
import "./src/polyfills/install-early";
import "./src/styles/unistyles";
import { registerRootComponent } from "expo";
import NativeRingRegression from "./e2e/mobile/status-ring/native";
registerRootComponent(NativeRingRegression);
```

Start Metro in `packages/app`:

```sh
APP_VARIANT=development npx expo start --localhost --port 8096
```

With one Android emulator running, open that bundle:

```sh
agent-device open sh.paseo.debug 'exp+voice-mobile://expo-development-client/?url=http%3A%2F%2F10.0.2.2%3A8096' --platform android --session status-ring --metro-port 8096
```

From the repository root:

```sh
node packages/app/e2e/mobile/status-ring/android.mjs status-ring http://127.0.0.1:8096
```

The test checks visible rotation, hidden-panel inactivity while another ring is
visible, inactivity with both panels hidden, and synchronized resumption. Each
sample reads counters on the UI runtime; elapsed time includes device-command
latency. The baseline fails at the first hidden-panel assertion.

Restore the original `packages/app/index.ts`, close the agent-device session,
and stop Metro afterward. The fixture substitutes running rings for a live agent
and toggles retained panels directly; it does not exercise workspace navigation
or measure whole-app CPU usage. It is excluded from routine unit tests because
it requires a native runtime.
