const { withGradleProperties } = require("expo/config-plugins");

const ASYNC_STORAGE_SIZE_PROPERTY = "AsyncStorage_db_size_in_MB";

function withAndroidAsyncStorageSize(config, sizeInMegabytes) {
  return withGradleProperties(config, (modConfig) => {
    const existingProperty = modConfig.modResults.find(
      (property) => property.type === "property" && property.key === ASYNC_STORAGE_SIZE_PROPERTY,
    );
    if (existingProperty?.type === "property") {
      existingProperty.value = String(sizeInMegabytes);
      return modConfig;
    }

    modConfig.modResults.push({
      type: "property",
      key: ASYNC_STORAGE_SIZE_PROPERTY,
      value: String(sizeInMegabytes),
    });
    return modConfig;
  });
}

module.exports = withAndroidAsyncStorageSize;
