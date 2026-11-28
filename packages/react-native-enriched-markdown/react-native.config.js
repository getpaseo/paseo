/**
 * @type {import('@react-native-community/cli-types').UserDependencyConfig}
 */
module.exports = {
  dependency: {
    platforms: {
      android: {
        cmakeListsPath: 'src/main/jni/CMakeLists.txt',
        componentDescriptors: [
          'EnrichedMarkdownTextComponentDescriptor',
          'EnrichedMarkdownComponentDescriptor',
          'EnrichedMarkdownTextInputComponentDescriptor',
        ],
      },
      desktop: {
        cmake: 'desktop',
        crate: 'rn-gpui-enriched-markdown',
        componentDescriptors: [
          'EnrichedMarkdownComponentDescriptor',
          'EnrichedMarkdownTextComponentDescriptor',
        ],
        componentHeaders: ['EnrichedMarkdownGpuiComponentDescriptors.h'],
        componentIncludeDirs: ['desktop/cpp'],
        componentSources: ['desktop/cpp/EnrichedMarkdownGpuiShadowNodes.cpp'],
      },
    },
  },
};
