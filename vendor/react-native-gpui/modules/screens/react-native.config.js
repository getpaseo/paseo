module.exports = {
  dependency: {
    platforms: {
      desktop: {
        cmake: 'desktop',
        crate: 'rn-gpui-screens',
        componentCodegenPackage: 'react-native-screens',
        componentDescriptors: [
          'RNSScreenComponentDescriptor',
          'RNSScreenContainerComponentDescriptor',
          'RNSScreenContentWrapperComponentDescriptor',
          'RNSScreenNavigationContainerComponentDescriptor',
          'RNSScreenStackComponentDescriptor',
          'RNSScreenStackHeaderConfigComponentDescriptor',
          'RNSScreenStackHeaderSubviewComponentDescriptor',
          'RNSModalScreenComponentDescriptor',
          'RNSFullWindowOverlayComponentDescriptor',
        ],
        componentHeaders: [
          'react/renderer/components/rnscreens/ComponentDescriptors.h',
          'react/renderer/components/rnscreens/RNSScreenComponentDescriptor.h',
          'react/renderer/components/rnscreens/RNSScreenStackHeaderConfigComponentDescriptor.h',
          'react/renderer/components/rnscreens/RNSScreenStackHeaderSubviewComponentDescriptor.h',
          'react/renderer/components/rnscreens/RNSModalScreenComponentDescriptor.h',
          'react/renderer/components/rnscreens/RNSFullWindowOverlayComponentDescriptor.h',
        ],
        // Metro: replace these files of installed packages for gpui.
        sourceOverrides: {
          'react-native-screens/src/core.ts': './src/core.desktop.ts',
          'react-native-screens/src/components/FullWindowOverlay.tsx':
            './src/FullWindowOverlay.desktop.tsx',
        },
      },
    },
  },
};
