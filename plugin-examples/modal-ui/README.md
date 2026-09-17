# Modal UI example

Install on a Paseo host with npm source installation support and npm available:

```sh
paseo plugin install npm:@getpaseo/plugin-example-modal-ui@0.1.1
```

In host **Settings → Plugins**, paste the same `npm:` identifier into **Plugin source**.
Enable plugins, then open **Modal examples** from the sidebar or a workspace tab.
Choose **Open Form**, type into **Paste here**, and watch the **Input:** text update.
The installed plugin ID is `modal-ui-example`. Host Settings shows the package identity and
installed version. With reviewed-update support, run `paseo plugin update modal-ui-example --check`
to check for a newer version, then `paseo plugin update modal-ui-example` to review and approve it.
An explicit install version selects the initial content; later updates still check the latest release.

The package ships the existing TypeScript entry and client sources. Paseo compiles them through
its directory plugin loader; no package build or preparation command is required. React,
React Native, and `@getpaseo/plugin` are peer contracts supplied by the host. npm is needed for
installation, not loading or reloading. You can also install this directory while developing.
See the [source reference](https://paseo.sh/docs/plugins/reference#plugin-sources)
for supported identifiers and preparation rules.

The examples demonstrate default and custom padding, a full-width body, author-owned ScrollView and
FlatList scrolling, horizontal tabs, and clipboard actions with a keyboard-aware input. See the
[host UI reference](https://paseo.sh/docs/plugins/reference#host-ui) for the API contract.

The browser regression installs this exact example in an isolated daemon:

```sh
cd packages/app
npx playwright test e2e/browser/plugin-modal-body.spec.ts --project=browser --workers=1
```

On Android, open each example and drag up on its content to expand the sheet, then scroll the list.
In FlatList, expand before using **Jump to last row**; row 100 should be visible. At the top of either
list, drag down on a row to dismiss the sheet. In Form,
press **Copy text**, long-press the input, and choose **Paste**. The input should contain
“Copied from Paseo”. With the system keyboard enabled, focusing the input should keep it visible.

Run the [native sheet regression](https://github.com/getpaseo/paseo/blob/main/packages/app/e2e/mobile/modal-sheet/README.md) to check body
dismissal, list scrolling and horizontal tabs together.

These captures show Android copy/paste and custom padding on browser and wide native layouts.
Android API 35 and Chromium were exercised; iOS and Electron were not tested.

| Android copy/paste                                               | Browser custom padding                                      | Wide Android custom padding                                               |
| ---------------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------- |
| ![Android copy and OS paste](screenshots/android-copy-paste.png) | ![Browser custom padding](screenshots/web-custom-inset.png) | ![Wide Android custom padding](screenshots/android-wide-custom-inset.png) |
