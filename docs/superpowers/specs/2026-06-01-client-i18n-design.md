# Client I18n Design

## Goal

Add internationalization infrastructure to the Paseo client so the Expo app can render UI in English or Simplified Chinese, with a persisted language preference exposed in Settings.

## Scope

The first release supports:

- English (`en`)
- Simplified Chinese (`zh-CN`)
- A `System` preference that follows the device/browser language when it maps to a supported locale
- Client UI static and semi-static copy: settings labels, navigation labels, buttons, empty states, confirmation dialogs, recoverable errors, and local status text

The first release does not translate:

- Agent or daemon output
- Terminal contents
- File paths
- Provider names, model names, and command names
- User-authored text
- Code blocks, logs, or raw protocol/server error text

This keeps the feature limited to UI copy owned by the client.

## Architecture

Use `i18next` and `react-i18next` in `packages/app`.

The app will keep translation resources in source-controlled TypeScript files and initialize one i18next instance for the client runtime. The provider will live under `QueryClientProvider` because it reads `useAppSettings()`, and above the app chrome that renders translated text.

Files:

- `packages/app/src/i18n/locales.ts`
  - Defines `SupportedLocale = "en" | "zh-CN"`.
  - Defines `AppLanguage = "system" | SupportedLocale`.
  - Exports supported language metadata for Settings.
  - Exports parsing helpers for persisted values and system locales.
- `packages/app/src/i18n/resources/en.ts`
  - English resources and source copy.
- `packages/app/src/i18n/resources/zh-CN.ts`
  - Simplified Chinese resources.
- `packages/app/src/i18n/i18next.ts`
  - Creates and initializes the i18next instance.
  - Configures `fallbackLng: "en"`.
  - Configures `react.useSuspense: false`.
- `packages/app/src/i18n/provider.tsx`
  - Reads `settings.language` from `useAppSettings()`.
  - Resolves the active locale.
  - Calls `i18n.changeLanguage(activeLocale)` when the setting or system locale changes.
  - Wraps children with `I18nextProvider`.

Components and screens use `useTranslation()` for UI copy. UI components receive already-translated labels through existing props or children; low-level primitives such as `<Button>` do not import translation state unless they own copy themselves.

## Language Preference

Extend `AppSettings` with:

```ts
language: "system" | "en" | "zh-CN";
```

Default:

```ts
language: "system";
```

Storage behavior:

- Existing settings blobs that omit `language` use the default.
- Persisted `system`, `en`, and `zh-CN` values are accepted.
- Unknown persisted language values are ignored and fall back to `system`.
- Resetting app settings restores `language: "system"`.

The setting belongs in `AppSettings` because language is a client-wide UI preference like theme, font family, and font size. The current settings storage path already handles AsyncStorage persistence, React Query caching, and root-level UI consumers.

## System Locale Resolution

Add `expo-localization` to read native locale information. For web and Electron, use `navigator.languages` when available.

Resolution rules:

- `system` maps `zh`, `zh-CN`, and `zh-Hans` locale tags to `zh-CN`.
- Any other locale maps to `en`.
- Explicit `en` and `zh-CN` preferences always win over system locale.

The active locale set is intentionally small. Unsupported locales never produce partial or guessed translations.

## Settings UI

Add a Language row to Settings -> General.

Use existing settings patterns:

- `SettingsSection`
- `settingsStyles.card`
- `settingsStyles.row`
- `DropdownMenu`

Options:

- System
- English
- Simplified Chinese

Selecting an option saves `AppSettings.language` immediately. The `I18nProvider` observes the settings query, changes i18next language, and React re-renders translated surfaces.

## Translation Resource Shape

Resources are grouped by product surface rather than by component mechanics. Example namespaces under the default i18next namespace:

```ts
export const en = {
  common: {
    cancel: "Cancel",
    save: "Save",
    loading: "Loading...",
  },
  settings: {
    title: "Settings",
    sections: {
      general: "General",
      appearance: "Appearance",
    },
    general: {
      title: "General",
      language: {
        label: "Language",
        description: "App language",
        options: {
          system: "System",
          en: "English",
          zhCN: "Simplified Chinese",
        },
      },
    },
  },
} as const;
```

The implementation resource includes only copy migrated in the current implementation slice. Later UI areas add keys when they are migrated.

Use interpolation for dynamic local UI strings:

```ts
t("settings.hosts.count", { count: hosts.length })
```

Do not translate raw server strings by passing them through `t()`.

## Migration Strategy

Use a vertical slice instead of translating the whole app in one pass.

Initial slice:

- i18n infrastructure
- `AppSettings.language`
- root provider
- Settings -> General language selector
- Settings sidebar labels
- General settings copy
- Copy needed by the language selector itself

After that, migrate surfaces incrementally when they are touched or when a dedicated translation pass is scheduled. Each migrated surface moves complete local copy clusters together so mixed-language fragments do not appear inside the same small UI region.

## Error Handling

- i18next fallback language is English.
- The app does not block rendering while i18n initializes.
- Invalid persisted language values fall back to `system`.
- Unsupported system locales fall back to English.
- Missing translation keys are caught by tests for key parity between `en` and `zh-CN`.

Raw service, daemon, and agent messages remain unmodified. User-facing local wrapper text may be translated, but the raw detail remains as received.

## Testing

Add focused tests only:

- `packages/app/src/hooks/use-settings/storage.test.ts`
  - Defaults `language` to `system`.
  - Accepts `en` and `zh-CN`.
  - Ignores unknown persisted language values.
  - `DEFAULT_CLIENT_SETTINGS` includes `language: "system"`, which covers reset behavior because reset writes that object.
- `packages/app/src/i18n/locales.test.ts`
  - Resolves `zh`, `zh-CN`, and `zh-Hans` to `zh-CN`.
  - Resolves unsupported locales to `en`.
  - Respects explicit language choices.
- `packages/app/src/i18n/resources.test.ts`
  - Verifies English and Chinese resource trees have identical keys.
- `packages/app/e2e/settings-i18n.spec.ts`
  - Verifies that Settings -> General exposes the language menu.
  - Verifies that choosing Simplified Chinese changes a visible Settings label.
  - Verifies that choosing English changes the same label back.

Verification commands:

```bash
npm run format
npx vitest run packages/app/src/hooks/use-settings/storage.test.ts --bail=1
npx vitest run packages/app/src/i18n/locales.test.ts --bail=1
npx vitest run packages/app/src/i18n/resources.test.ts --bail=1
npm run typecheck
npm run lint
```

Follow the repository rule to avoid the full local test suite.

## Documentation

Add `docs/i18n.md` during implementation with these conventions:

- English source strings live in `packages/app/src/i18n/resources/en.ts`.
- New UI copy in migrated surfaces uses `useTranslation()`.
- Server, agent, terminal, path, and user text are not translated.

The permanent doc keeps these conventions visible after the implementation plan is complete.
