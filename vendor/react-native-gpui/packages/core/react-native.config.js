module.exports = {
  platforms: {
    desktop: {
      npmPackageName: '@react-native-gpui/core',
      // The Rust crate builds the platform; there is no Gradle/Xcode project to
      // configure or to autolink dependencies against. `project.desktop` only
      // carries build options, which autolink validates.
      projectConfig: (_root, project) => project ?? {},
      dependencyConfig: (_root, dependencyConfig) => dependencyConfig ?? null,
    },
  },
};
