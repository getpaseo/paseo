/* oxlint-disable import/no-unassigned-import -- These packages install Intl and locale data by side effect. */
// Hermes' Linux build omits Intl; install real locale algorithms before app code.
import "@formatjs/intl-getcanonicallocales/polyfill-force.js";
import "@formatjs/intl-locale/polyfill-force.js";
import "@formatjs/intl-pluralrules/polyfill-force.js";
import "@formatjs/intl-pluralrules/locale-data/en.js";
import "@formatjs/intl-numberformat/polyfill-force.js";
import "@formatjs/intl-numberformat/locale-data/en.js";
import "@formatjs/intl-datetimeformat/polyfill-force.js";
import "@formatjs/intl-datetimeformat/locale-data/en.js";
import "@formatjs/intl-datetimeformat/add-all-tz.js";
import "@formatjs/intl-displaynames/polyfill-force.js";
import "@formatjs/intl-displaynames/locale-data/en.js";
import "@formatjs/intl-segmenter/polyfill-force.js";
import Desktop from "../desktop/src/NativePaseoDesktop";
Intl.DateTimeFormat.__setDefaultTimeZone(Desktop.timezone());
