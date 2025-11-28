const { withAppBuildGradle } = require("expo/config-plugins");

/**
 * Expo config plugin to add Android product flavors (dev/production)
 * This allows building both dev and production variants without re-running prebuild
 *
 * Variants created:
 * - devDebug: Development build with dev tools
 * - devRelease: Development build optimized
 * - productionDebug: Production build with dev tools
 * - productionRelease: Production build optimized (for app store)
 */
function withAndroidProductFlavors(config) {
  return withAppBuildGradle(config, (config) => {
    let buildGradle = config.modResults.contents;

    // Add debuggableVariants to the react block
    buildGradle = buildGradle.replace(
      '// debuggableVariants = ["liteDebug", "prodDebug"]',
      'debuggableVariants = ["devDebug", "productionDebug"]'
    );

    // Add product flavors after signingConfigs block
    const signingConfigsEnd = buildGradle.indexOf(
      "    }\n    buildTypes {",
      buildGradle.indexOf("signingConfigs {")
    );

    if (signingConfigsEnd === -1) {
      console.warn(
        "Could not find signingConfigs end in build.gradle, skipping product flavors"
      );
      return config;
    }

    const productFlavorsBlock = `    }
    flavorDimensions "environment"
    productFlavors {
        dev {
            dimension "environment"
            applicationId "com.moboudra.paseo.dev"
            resValue "string", "app_name", "Paseo (Dev)"
        }
        production {
            dimension "environment"
            applicationId "com.moboudra.paseo"
            resValue "string", "app_name", "Paseo"
        }
    }
    buildTypes {`;

    buildGradle = buildGradle.replace(
      "    }\n    buildTypes {",
      productFlavorsBlock
    );

    // Remove applicationId from defaultConfig since flavors handle it
    buildGradle = buildGradle.replace(
      /applicationId ['"]com\.moboudra\.paseo['"]\n\s*/,
      ""
    );

    config.modResults.contents = buildGradle;
    return config;
  });
}

module.exports = withAndroidProductFlavors;
