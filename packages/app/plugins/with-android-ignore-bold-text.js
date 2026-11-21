const { withMainActivity } = require("expo/config-plugins");

// Android 12+ "Bold text" sets Configuration.fontWeightAdjustment, and TextView
// applies it when drawing text that has no explicit fontWeight or fontFamily.
// React Native measures that same text without the adjustment, so the bolder,
// wider glyphs overflow the measured box and trailing words are clipped (#4057).
// Zeroing the adjustment for the activity keeps measurement and drawing in sync.
const IMPORTS = ["android.content.Context", "android.content.res.Configuration"];

const MARKER = "// paseo-ignore-bold-text";

const ATTACH_BASE_CONTEXT = `  ${MARKER}
  override fun attachBaseContext(newBase: Context) {
    val configuration = newBase.resources.configuration
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && configuration.fontWeightAdjustment != 0) {
      val override = Configuration(configuration)
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
