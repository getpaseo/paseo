module.exports = {
  dependency: {
    platforms: {
      desktop: {
        cmake: 'desktop',
        jsEngine: {
          name: 'hermes',
          register: 'rn_gpui_register_js_engine_hermes',
          bundle: './desktop/bundle.js',
          runtimeFiles: './desktop/runtime-files.js',
          // Windows has no global symbol lookup: an addon's import names both the
          // function and the DLL it lives in, and node-gyp and napi-rs addons
          // alike end at the host executable. So the app's executable re-exports
          // every Node-API name, forwarded to this library. The engine package
          // owns both facts, so a different engine can supply its own list or
          // none at all.
          nodeApiExports: './desktop/node-api-exports.txt',
          nodeApiLibrary: 'hermesvm',
        },
      },
    },
  },
};
