/**
 * A read-only layer of app preferences that sits *under* everything the settings UI writes.
 * `path` is the absolute file the values came from, used verbatim in error messages so the
 * user knows which file to edit.
 */
export interface SettingsSeed {
  path: string;
  app: Record<string, unknown>;
}
