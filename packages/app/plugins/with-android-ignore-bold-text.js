const { withMainActivity } = require("expo/config-plugins");

// Android 12+ "Bold text" sets Configuration.fontWeightAdjustment, and TextView
// applies it when drawing text that has no explicit fontWeight or fontFamily.
// React Native's TextLayoutManager measures that text without the adjustment, so
// the wider glyphs overflow the measured box and trailing words or lines are
// clipped (#4057, #10152, #10850).
//
// Override only fontWeightAdjustment on an empty sparse Configuration() so
// unrelated configuration fields (uiMode, densityDpi, orientation,
// screenWidthDp, fontScale, locales) keep flowing through onConfigurationChanged.
//
// Remove this plugin once upstream React Native's TextLayoutManager measures
// with Configuration.fontWeightAdjustment.
const IMPORTS = [
  "android.content.Context",
  "android.content.res.Configuration",
  "android.os.Build",
];

const MARKER = "// paseo-ignore-bold-text";

const ATTACH_BASE_CONTEXT = `  ${MARKER}
  override fun attachBaseContext(newBase: Context) {
    val configuration = newBase.resources.configuration
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && configuration.fontWeightAdjustment != 0) {
      val override = Configuration()
      override.fontWeightAdjustment = 0
      super.attachBaseContext(newBase.createConfigurationContext(override))
      return
    }
    super.attachBaseContext(newBase)
  }
`;

const CLASS_DECLARATION = /class MainActivity : ReactActivity\(\) \{\n/;

function configureIgnoreBoldTextMainActivity(source) {
  if (source.includes(MARKER)) {
    return source;
  }
  if (!CLASS_DECLARATION.test(source)) {
    throw new Error("withAndroidIgnoreBoldText could not find the MainActivity class declaration");
  }
  if (/override fun attachBaseContext\(/.test(source)) {
    throw new Error("withAndroidIgnoreBoldText found an existing attachBaseContext override");
  }
  let contents = source;
  for (const name of IMPORTS) {
    if (!contents.includes(`import ${name}\n`)) {
      contents = contents.replace(/^package .*\n/m, (line) => `${line}import ${name}\n`);
    }
  }
  return contents.replace(CLASS_DECLARATION, (line) => `${line}${ATTACH_BASE_CONTEXT}\n`);
}

function withAndroidIgnoreBoldText(config) {
  return withMainActivity(config, (modConfig) => {
    if (modConfig.modResults.language !== "kt") {
      throw new Error("withAndroidIgnoreBoldText expects a Kotlin MainActivity");
    }
    modConfig.modResults.contents = configureIgnoreBoldTextMainActivity(
      modConfig.modResults.contents,
    );
    return modConfig;
  });
}

module.exports = withAndroidIgnoreBoldText;
module.exports.configureIgnoreBoldTextMainActivity = configureIgnoreBoldTextMainActivity;
