const path = require("node:path");

const { smokePackagedDesktopApp } = require("./smoke-packaged-desktop-app.js");

exports.default = async function afterSign(context) {
  if (process.env.PASEO_DESKTOP_SMOKE !== "1") {
    return;
  }

  if (context.electronPlatformName !== "darwin") {
    return;
  }

  const executableName = context.packager?.appInfo?.productFilename || "Paseo";
  await smokePackagedDesktopApp({
    appPath: path.join(context.appOutDir, `${executableName}.app`),
  });
};
