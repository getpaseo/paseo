// The registry comes from the package root, as it does in the other modules in
// this tree (`BackHandler.desktop.js`, `TextInput.desktop.js`). A relative path would
// also work in a bundle — Metro rebases a patched module's imports onto its
// upstream location — but only there, which makes this file's own logic
// untestable outside a running app.
import { TurboModuleRegistry } from 'react-native';

function readJsEngine() {
  try {
    const constants =
      TurboModuleRegistry.get('PlatformConstants')?.getConstants?.();
    const jsEngine = constants?.jsEngine;
    if (jsEngine && typeof jsEngine.name === 'string') {
      return jsEngine;
    }
  } catch {
    // TurboModules are not installed yet; the caller retries on the next read.
  }
  return null;
}

// Native reports no `systemName`, so it comes from here, and it must not claim
// macOS on a Windows or Linux host: an app that branches on it would take the
// wrong path. The value is derived from the host when it is known, and the
// documented React Native spelling (`macOS`, `Windows`, `Linux`) otherwise.
const HOST_SYSTEM_NAMES = {
  macos: 'macOS',
  windows: 'Windows',
  linux: 'Linux',
};

const staticConstants = {
  forceTouchAvailable: false,
  interfaceIdiom: 'desktop',
  isTesting: false,
  isDisableAnimations: false,
  // The runtime reports no osVersion yet, so these are placeholders that keep
  // `Platform.Version` string-typed for version-gated callers.
  osVersion: 'unknown',
  reactNativeVersion: {
    major: 0,
    minor: 87,
    patch: 1,
    prerelease: null,
  },
};

// `Platform.OS` is the operating system the app runs on: `macos`, `windows` or
// `linux`. The same bundle loads on all three, so it comes from the desktop
// TurboModule (`std::env::consts::OS` natively).
function readOS() {
  try {
    const NativeGpuiDesktop = TurboModuleRegistry.get('GpuiDesktop');
    const reported = NativeGpuiDesktop?.platform?.();
    if (typeof reported === 'string' && reported.length > 0) {
      return reported;
    }
  } catch {
    // TurboModules are not installed yet; the caller retries on the next read.
  }
  return null;
}

const Platform = {
  __constants: null,
  __OS: null,
  get OS() {
    // Cache only a real answer, so a read before TurboModules exist is retried.
    if (this.__OS == null) this.__OS = readOS();
    return this.__OS ?? 'macos';
  },

  get Version() {
    return this.constants.osVersion;
  },

  get constants() {
    if (this.__constants == null) {
      const jsEngine = readJsEngine();
      const systemName = HOST_SYSTEM_NAMES[this.OS];
      if (jsEngine == null) {
        // Do not cache: a later read succeeds once TurboModules are installed.
        return {
          ...staticConstants,
          jsEngine: { name: 'unknown', version: '' },
          systemName,
        };
      }
      this.__constants = { ...staticConstants, jsEngine, systemName };
    }
    return this.__constants;
  },

  get isPad() {
    return false;
  },

  get isTV() {
    return false;
  },

  get isVision() {
    return false;
  },

  get isTesting() {
    return this.constants.isTesting;
  },

  get isDisableAnimations() {
    return this.constants.isDisableAnimations ?? this.isTesting;
  },

  get isMacCatalyst() {
    return false;
  },

  // `spec[OS]` wins, then this platform's own `spec.desktop`, then the
  // platform-neutral `spec.native`, then `default`.
  select: spec => {
    if (Platform.OS in spec) return spec[Platform.OS];
    if ('desktop' in spec) return spec.desktop;
    return 'native' in spec ? spec.native : spec.default;
  },
};

export default Platform;
