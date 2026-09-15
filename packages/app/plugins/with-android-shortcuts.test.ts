import { describe, expect, it } from "vitest";

const {
  STATIC_SHORTCUTS,
  addShortcutStrings,
  addShortcutsMetaData,
  buildShortcutsXml,
} = require("./with-android-shortcuts");

describe("withAndroidShortcuts", () => {
  it("targets the variant's own MainActivity with paseo:// links", () => {
    const xml = buildShortcutsXml("sh.paseo.debug");

    expect(xml).toContain('android:targetPackage="sh.paseo.debug"');
    expect(xml).toContain('android:targetClass="sh.paseo.debug.MainActivity"');
    expect(xml).toContain('android:data="paseo://new"');
    expect(xml).toContain('android:action="android.intent.action.VIEW"');
    expect(xml.match(/<shortcut\b/g)).toHaveLength(STATIC_SHORTCUTS.length);
    expect(xml).not.toContain('android:data="http');
  });

  it("registers the shortcuts resource on the main activity exactly once", () => {
    const manifest = {
      manifest: {
        application: [
          {
            $: { "android:name": ".MainApplication" },
            activity: [
              {
                $: { "android:name": ".MainActivity" },
                "intent-filter": [
                  {
                    action: [{ $: { "android:name": "android.intent.action.MAIN" } }],
                    category: [{ $: { "android:name": "android.intent.category.LAUNCHER" } }],
                  },
                ],
              },
            ],
          },
        ],
      },
    };

    const once = addShortcutsMetaData(manifest);
    const twice = addShortcutsMetaData(once);
    const metaData = twice.manifest.application[0].activity[0]["meta-data"];

    expect(metaData).toEqual([
      {
        $: { "android:name": "android.app.shortcuts", "android:resource": "@xml/paseo_shortcuts" },
      },
    ]);
  });

  it("adds one untranslatable label string per shortcut", () => {
    const strings = addShortcutStrings({ resources: { string: [] } });
    const names = strings.resources.string.map((item: { $: { name: string } }) => item.$.name);

    expect(names).toEqual([
      "paseo_shortcut_new_workspace",
      "paseo_shortcut_open_project",
      "paseo_shortcut_sessions",
    ]);
    expect(addShortcutStrings(strings).resources.string).toHaveLength(STATIC_SHORTCUTS.length);
  });
});
