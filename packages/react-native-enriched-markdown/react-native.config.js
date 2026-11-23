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
    },
  },
};
