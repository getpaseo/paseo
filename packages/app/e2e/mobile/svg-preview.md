# Native SVG preview regression

Copy `fixtures/native-preview.svg`, `fixtures/native-preview-viewbox.svg`, and
`../../assets/images/icon.png` into a workspace on a test daemon. In the Android
or iOS app, connect to that daemon, open the workspace's Files tab, and tap
`native-preview.svg`. The SVG should show a yellow circle on a green rectangle.

With that preview open, run:

```sh
node packages/app/e2e/mobile/svg-preview.mjs <agent-device-session>
```

Run it again with `native-preview-viewbox.svg` open to cover SVG dimensions
inferred from `viewBox`, then with the PNG open to check raster images. Close and
reopen the SVG and rerun to cover cached file previews. Use English app language
for the zoom button selectors. The script drives the existing native session;
it does not launch an app or daemon or change its connection.

Before the fix the SVG remains blank and the canvas wait fails. The PNG passes.
The script checks successful native dimension decoding and zoom/reset controls;
visually verify the circle and rectangle as well.
