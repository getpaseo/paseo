const { withMainActivity } = require("expo/config-plugins");

const ACTIVITY_CLASS = "class MainActivity : ReactActivity() {";
const SYNC = "sh.paseo.displaymetrics.PaseoDisplayMetrics.syncWithWindow(this)";
// React Native re-reads the built-in display's density when it creates the root view and on every
// configuration change, so the window's density has to be restored right after each `super` call.
const OVERRIDES = `
  override fun onContentChanged() {
    super.onContentChanged()
    ${SYNC}
  }

  override fun onConfigurationChanged(newConfig: android.content.res.Configuration) {
    super.onConfigurationChanged(newConfig)
    ${SYNC}
  }
`;

function configureDisplayMetricsActivity(contents) {
  if (contents.includes(SYNC)) return contents;
  if (
    !contents.includes(ACTIVITY_CLASS) ||
    /override fun on(ContentChanged|ConfigurationChanged)\(/.test(contents)
  ) {
    throw new Error("Could not keep React Native text at the window's density in MainActivity");
  }
  return contents.replace(ACTIVITY_CLASS, `${ACTIVITY_CLASS}${OVERRIDES}`);
}

module.exports = (config) =>
  withMainActivity(config, (mod) => {
    mod.modResults.contents = configureDisplayMetricsActivity(mod.modResults.contents);
    return mod;
  });
module.exports.configureDisplayMetricsActivity = configureDisplayMetricsActivity;
