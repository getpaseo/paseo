# Share intake

Paseo is a share target on iOS and Android. A share from another app opens a picker, and the files,
text and links go into the chosen agent's composer or into a new agent draft in a workspace. Nothing
is sent until the user sends it. The code lives in `packages/app/src/share-intake/`.

## Native entry

The `expo-sharing` config plugin in `packages/app/app.config.js` sets up both platforms. Both end up
opening `paseo://expo-sharing`:

- iOS adds a share extension target, `expo-sharing-extension`. It copies the shared items into the
  app group and opens the app with that URL.
- Android adds `SEND` and `SEND_MULTIPLE` filters for `*/*` to the main activity, then rewrites the
  intent to that URL. The activity is `singleTask`, so a share to a running app arrives as a URL
  event.

`packages/app/src/app/+native-intent.tsx` keeps that URL out of the router. A cold start opens `/`
and the normal workspace restore. A warm start does not navigate. Any other `Linking` listener must
ignore the URL.

## iOS provisioning

Each app variant gets its own extension bundle ID (`<bundle id>.expo-sharing-extension`) and app
group (`group.<bundle id>`), for `sh.paseo` and `sh.paseo.debug`. EAS registers both. For a local
Xcode build, register them in the Apple team first. Without the app group, the extension cannot hand
anything to the app.

## Patched expo-sharing

Receiving shares is experimental in expo-sharing 57. `patches/expo-sharing+57.0.23.patch` keeps
documents, text files and same-named files from being dropped or overwritten on both platforms. The
entry in `scripts/postinstall-patches.mjs` lists each fix. The Android half only applies because
expo-sharing builds from source; see [dependency patches](development.md#dependency-patches).
