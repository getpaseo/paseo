const { copyFile, mkdir } = require("node:fs/promises");
const path = require("node:path");
const { withDangerousMod } = require("expo/config-plugins");

const FONT_ASSETS = [
  ["RobotoMono-Regular.ttf", "monospace.ttf"],
  ["RobotoMono-Bold.ttf", "monospace_bold.ttf"],
  ["RobotoMono-Italic.ttf", "monospace_italic.ttf"],
  ["RobotoMono-BoldItalic.ttf", "monospace_bold_italic.ttf"],
  ["OFL.txt", "RobotoMono-OFL.txt"],
];

async function copyAndroidMonospaceFonts({ projectRoot, platformProjectRoot }) {
  const source = path.join(projectRoot, "assets/fonts/roboto-mono");
  const destination = path.join(platformProjectRoot, "app/src/main/assets/fonts");
  await mkdir(destination, { recursive: true });
  for (const [font, asset] of FONT_ASSETS) {
    await copyFile(path.join(source, font), path.join(destination, asset));
  }
}

function withAndroidMonospace(config) {
  // ReactFontManager loads these assets before resolving system font aliases.
  // Some Android firmware replaces even "monospace" with a proportional font.
  return withDangerousMod(config, [
    "android",
    async (modConfig) => {
      await copyAndroidMonospaceFonts(modConfig.modRequest);
      return modConfig;
    },
  ]);
}

module.exports = withAndroidMonospace;
module.exports.copyAndroidMonospaceFonts = copyAndroidMonospaceFonts;
