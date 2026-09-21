const { withMainApplication } = require("expo/config-plugins");

const PACKAGE_LIST = "PackageList(this).packages.apply {";
const REGISTRATION = "add(0, sh.paseo.scroll.PaseoScrollPackage())";

function configureScrollPackage(contents) {
  if (contents.includes(REGISTRATION)) return contents;
  if (!contents.includes(PACKAGE_LIST)) {
    throw new Error(
      "Could not register Android scroll behavior before React Native's core package",
    );
  }
  return contents.replace(PACKAGE_LIST, `${PACKAGE_LIST}\n              ${REGISTRATION}`);
}

module.exports = (config) =>
  withMainApplication(config, (mod) => {
    mod.modResults.contents = configureScrollPackage(mod.modResults.contents);
    return mod;
  });
module.exports.configureScrollPackage = configureScrollPackage;
