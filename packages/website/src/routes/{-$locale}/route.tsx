import { createFileRoute, Outlet } from "@tanstack/react-router";
import { LocaleProvider, localeFromParam } from "~/i18n";

export const Route = createFileRoute("/{-$locale}")({
  params: {
    // A first segment that is not a prefixed language belongs to an English page, so the match
    // skips this route instead of rendering `/claude-code` as a language called "claude-code".
    parse: (params) =>
      (localeFromParam(params.locale) === null ? false : params) as { locale?: string },
    stringify: (params) => params,
  },
  component: LocalizedLayout,
});

function LocalizedLayout() {
  return (
    <LocaleProvider>
      <Outlet />
    </LocaleProvider>
  );
}
