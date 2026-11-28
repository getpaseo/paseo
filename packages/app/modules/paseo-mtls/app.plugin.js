const { withMainApplication } = require("expo/config-plugins");

const INSTALL = "sh.paseo.mtls.PaseoMtls.install(this)";

function configureClientCertificates(contents) {
  if (contents.includes(INSTALL)) return contents;
  if (!contents.includes("super.onCreate()")) {
    throw new Error("Could not install Android client certificates before React Native starts");
  }
  return contents.replace("super.onCreate()", `super.onCreate()\n    ${INSTALL}`);
}

module.exports = (config) =>
  withMainApplication(config, (mod) => {
    mod.modResults.contents = configureClientCertificates(mod.modResults.contents);
    return mod;
  });
module.exports.configureClientCertificates = configureClientCertificates;
