module.exports = {
  dependency: {
    platforms: {
      desktop: {
        cmake: 'desktop',
        cppProvider: 'create_gpui_safe_area_context_module',
        componentCodegenPackage: 'react-native-safe-area-context',
        componentDescriptors: [
          'RNCSafeAreaProviderComponentDescriptor',
          'RNCSafeAreaViewComponentDescriptor',
        ],
        componentHeaders: [
          'react/renderer/components/safeareacontext/ComponentDescriptors.h',
          'react/renderer/components/safeareacontext/RNCSafeAreaViewComponentDescriptor.h',
        ],
      },
    },
  },
};
