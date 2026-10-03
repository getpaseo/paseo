const { AndroidConfig, withAndroidManifest } = require("expo/config-plugins");

const PROVIDER_CLASS = "sh.paseo.androidintents.AssistantContentProvider";
const RELEASE_AUTHORITY = "sh.paseo.assistant";

// Assistants pin the release authority. A debug build gets its own so it can
// install beside a release build; Android refuses two apps with one authority.
function assistantProviderAuthority(packageName) {
  return packageName.endsWith(".debug") ? `${packageName}.assistant` : RELEASE_AUTHORITY;
}

function addAssistantProvider(androidManifest, packageName) {
  const application = AndroidConfig.Manifest.getMainApplicationOrThrow(androidManifest);
  const providers = (application.provider ?? []).filter(
    (item) => item.$?.["android:name"] !== PROVIDER_CLASS,
  );
  providers.push({
    $: {
      "android:name": PROVIDER_CLASS,
      "android:authorities": assistantProviderAuthority(packageName),
      "android:exported": "true",
      "android:grantUriPermissions": "false",
    },
  });
  application.provider = providers;
  return androidManifest;
}

function withAssistantProvider(config) {
  return withAndroidManifest(config, (modConfig) => {
    const packageName = modConfig.android?.package;
    if (!packageName) {
      throw new Error("The assistant provider requires android.package");
    }
    modConfig.modResults = addAssistantProvider(modConfig.modResults, packageName);
    return modConfig;
  });
}

module.exports = withAssistantProvider;
module.exports.addAssistantProvider = addAssistantProvider;
module.exports.assistantProviderAuthority = assistantProviderAuthority;
