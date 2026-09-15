const fs = require("node:fs/promises");
const path = require("node:path");
const {
  AndroidConfig,
  withAndroidManifest,
  withDangerousMod,
  withStringsXml,
} = require("expo/config-plugins");

const SHORTCUTS_META_DATA = "android.app.shortcuts";
const SHORTCUTS_RESOURCE = "@xml/paseo_shortcuts";

// Static launcher shortcuts (long-press the app icon). Each one opens a
// paseo:// link the app already handles; see docs/android-intents.md.
const STATIC_SHORTCUTS = [
  { id: "new-workspace", label: "New workspace", uri: "paseo://new" },
  { id: "open-project", label: "Open project", uri: "paseo://open-project" },
  { id: "sessions", label: "History", uri: "paseo://sessions" },
];

function shortcutStringName(shortcut) {
  return `paseo_shortcut_${shortcut.id.replace(/-/g, "_")}`;
}

function escapeXmlAttribute(value) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function buildShortcutsXml(packageName) {
  const activity = `${packageName}.MainActivity`;
  const entries = STATIC_SHORTCUTS.map((shortcut) => {
    const stringName = shortcutStringName(shortcut);
    return [
      "  <shortcut",
      `    android:shortcutId="${escapeXmlAttribute(shortcut.id)}"`,
      '    android:enabled="true"',
      '    android:icon="@mipmap/ic_launcher"',
      `    android:shortcutShortLabel="@string/${stringName}"`,
      `    android:shortcutLongLabel="@string/${stringName}">`,
      "    <intent",
      '      android:action="android.intent.action.VIEW"',
      `      android:data="${escapeXmlAttribute(shortcut.uri)}"`,
      `      android:targetPackage="${escapeXmlAttribute(packageName)}"`,
      `      android:targetClass="${escapeXmlAttribute(activity)}" />`,
      "  </shortcut>",
    ].join("\n");
  });
  return `<?xml version="1.0" encoding="utf-8"?>\n<shortcuts xmlns:android="http://schemas.android.com/apk/res/android">\n${entries.join("\n")}\n</shortcuts>\n`;
}

function addShortcutsMetaData(androidManifest) {
  const mainActivity = AndroidConfig.Manifest.getMainActivityOrThrow(androidManifest);
  const metaData = (mainActivity["meta-data"] ?? []).filter(
    (item) => item.$?.["android:name"] !== SHORTCUTS_META_DATA,
  );
  metaData.push({
    $: { "android:name": SHORTCUTS_META_DATA, "android:resource": SHORTCUTS_RESOURCE },
  });
  mainActivity["meta-data"] = metaData;
  return androidManifest;
}

function addShortcutStrings(stringsXml) {
  return AndroidConfig.Strings.setStringItem(
    STATIC_SHORTCUTS.map((shortcut) =>
      AndroidConfig.Resources.buildResourceItem({
        name: shortcutStringName(shortcut),
        value: shortcut.label,
        translatable: false,
      }),
    ),
    stringsXml,
  );
}

function withAndroidShortcuts(config) {
  config = withAndroidManifest(config, (modConfig) => {
    modConfig.modResults = addShortcutsMetaData(modConfig.modResults);
    return modConfig;
  });
  config = withStringsXml(config, (modConfig) => {
    modConfig.modResults = addShortcutStrings(modConfig.modResults);
    return modConfig;
  });
  return withDangerousMod(config, [
    "android",
    async (modConfig) => {
      const packageName = modConfig.android?.package;
      if (!packageName) {
        throw new Error("Android shortcuts require android.package");
      }
      const resourceFolder = await AndroidConfig.Paths.getResourceFolderAsync(
        modConfig.modRequest.projectRoot,
      );
      const xmlDirectory = path.join(resourceFolder, "xml");
      await fs.mkdir(xmlDirectory, { recursive: true });
      await fs.writeFile(
        path.join(xmlDirectory, "paseo_shortcuts.xml"),
        buildShortcutsXml(packageName),
      );
      return modConfig;
    },
  ]);
}

module.exports = withAndroidShortcuts;
module.exports.STATIC_SHORTCUTS = STATIC_SHORTCUTS;
module.exports.addShortcutStrings = addShortcutStrings;
module.exports.addShortcutsMetaData = addShortcutsMetaData;
module.exports.buildShortcutsXml = buildShortcutsXml;
