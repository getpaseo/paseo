// Side-effect module imported first by index.ts. Babel hoists imports above
// statements, so polyfill calls written in index.ts would run only after every
// imported module had evaluated. Modules that read these globals at load time,
// such as @xterm/headless reading navigator.userAgent, need them installed here.
import { polyfillCrypto } from "./crypto";
import { polyfillNavigator } from "./navigator";
import { polyfillScreenOrientation } from "./screen-orientation";

polyfillCrypto();
polyfillNavigator();
// Polyfill screen.orientation for WebKitGTK desktop runtimes that lack the API.
polyfillScreenOrientation();
