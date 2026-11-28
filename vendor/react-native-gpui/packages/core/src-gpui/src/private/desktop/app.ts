/**
 * `App`: the running application as a whole.
 *
 * ```ts
 * const [command, what] = App.launchArgs();
 * App.onSecondInstance(args => open(args));
 * ```
 *
 * @format
 */

import { DeviceEventEmitter } from 'react-native';
import NativeGpuiApp from '../specs/NativeGpuiApp';
import { nativeRequest } from './index';

const SECOND_INSTANCE = 'gpuiDesktop:secondInstance';

function request<T>(
  run: (native: NonNullable<typeof NativeGpuiApp>) => Promise<T>,
): Promise<T> {
  return nativeRequest('GpuiApp', check => run(check(NativeGpuiApp)));
}

export const App = {
  /** The command line arguments this process was started with, without the executable. */
  launchArgs(): string[] {
    return NativeGpuiApp?.launchArgs() ?? [];
  },

  /** Quits the application, closing its windows as usual. */
  quit(): Promise<void> {
    return request(native => native.quit());
  },

  /** Ends the process at once with `code`, without closing windows. */
  exit(code = 0): Promise<void> {
    return request(native => native.exit(code));
  },

  /** Starts the application again with the same arguments, then quits this one. */
  relaunch(): Promise<void> {
    return request(native => native.relaunch());
  },

  /** Plays the system alert sound. On Linux it rings the terminal bell the app was started from, if any. */
  beep(): Promise<void> {
    return request(native => native.beep());
  },

  /**
   * Calls `handler` with the arguments of another launch that was handed to
   * this process because the app is a single instance. The main window is
   * shown and focused before it runs.
   */
  onSecondInstance(handler: (args: string[]) => void): { remove: () => void } {
    const subscription = DeviceEventEmitter.addListener(
      SECOND_INSTANCE,
      (event: { args?: string[] } | undefined) => handler(event?.args ?? []),
    );
    return { remove: () => subscription.remove() };
  },
};
