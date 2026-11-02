module.exports = {
  presets: ['module:@react-native/babel-preset'],
  plugins: [
    // Rewrites `require` of a `.node` file (directly, or through a loader such
    // as `node-gyp-build`, `bindings` or a napi-rs generated file) into the
    // path the desktop runtime opens. A no-op on other platforms, so the same
    // config still builds for iOS and Android.
    'module:@react-native-gpui/core/babel-plugin-node-addons',
  ],
};
