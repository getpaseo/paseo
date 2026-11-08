export function setDefaultTimeZone(timeZone) {
  // macOS uses the IANA alias GMT. FormatJS's timezone data omits that alias;
  // normalize it at the polyfill boundary while preserving other system zones.
  Intl.DateTimeFormat.__setDefaultTimeZone(timeZone.toUpperCase() === "GMT" ? "UTC" : timeZone);
}
