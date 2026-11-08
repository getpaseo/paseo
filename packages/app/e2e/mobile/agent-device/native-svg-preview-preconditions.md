# Native SVG preview regression

Copy `../fixtures/native-preview.svg`, `../fixtures/native-preview-viewbox.svg`, and
`../../../assets/images/icon.png` into a workspace on a test daemon. In the Android
or iOS app, connect to that daemon, open the workspace's Files tab, and tap
`native-preview.svg`. The SVG should show a yellow circle on a green rectangle.

With that preview open, run:

```sh
agent-device test packages/app/e2e/mobile/agent-device/native-svg-preview.android.ad \
  --metro-port <port> --artifacts-dir .artifacts/svg-preview
```

Run it again with `native-preview-viewbox.svg` open to cover SVG dimensions
inferred from `viewBox`, then with the PNG open to check raster images. Close and
reopen the SVG and rerun to cover cached file previews. Use English app language
for the zoom button selectors. The scripts are discovered by `npm run test:e2e:mobile`; the iOS counterpart is
`native-svg-preview.ios.ad`. They reopen the installed app with its current
preview and leave the daemon connection unchanged.

Before the fix the SVG remains blank and the canvas wait fails. The PNG passes.
The replay checks successful native dimension decoding and zoom/reset controls;
visually verify the circle and rectangle as well.
