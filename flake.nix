{
  description = "Paseo - self-hosted daemon for AI coding agents";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs =
    {
      self,
      nixpkgs,
    }:
    let
      supportedSystems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];
      forAllSystems = nixpkgs.lib.genAttrs supportedSystems;
      pkgsFor =
        system:
        import nixpkgs {
          inherit system;
          config = {
            allowUnfree = true;
            android_sdk.accept_license = true;
          };
        };
      androidFor =
        system:
        let
          pkgs = pkgsFor system;
          buildToolsVersion = "36.0.0";
          cmdLineToolsVersion = "19.0";
          ndkVersion = "27.1.12297006";
          unistylesNdkVersion = "27.0.12077973";
          androidComposition = pkgs.androidenv.composeAndroidPackages {
            inherit cmdLineToolsVersion;
            platformToolsVersion = "36.0.2";
            buildToolsVersions = [
              "35.0.0"
              buildToolsVersion
            ];
            platformVersions = [
              "35"
              "36"
            ];
            includeEmulator = false;
            includeSources = false;
            includeSystemImages = false;
            includeNDK = true;
            ndkVersions = [
              ndkVersion
              # react-native-unistyles does not inherit Expo's root NDK
              # version, so AGP resolves its own default side-by-side NDK.
              unistylesNdkVersion
            ];
            cmakeVersions = [ "3.22.1" ];
          };
          androidSdk = androidComposition.androidsdk;
          androidHome = "${androidSdk}/libexec/android-sdk";
          androidEnvironment = {
            ANDROID_HOME = androidHome;
            ANDROID_SDK_ROOT = androidHome;
            ANDROID_NDK_HOME = "${androidHome}/ndk/${ndkVersion}";
            JAVA_HOME = pkgs.jdk21_headless.home;
            GRADLE_OPTS = "-Dorg.gradle.project.android.aapt2FromMavenOverride=${androidHome}/build-tools/${buildToolsVersion}/aapt2";
          };
          releaseRunner = pkgs.writeShellApplication {
            name = "paseo-android-release";
            runtimeInputs = [
              androidSdk
              pkgs.coreutils
              pkgs.findutils
              pkgs.jdk21_headless
              pkgs.nodejs_22
              pkgs.python3
            ];
            text = ''
              export ANDROID_HOME=${androidEnvironment.ANDROID_HOME}
              export ANDROID_SDK_ROOT=${androidEnvironment.ANDROID_SDK_ROOT}
              export ANDROID_NDK_HOME=${androidEnvironment.ANDROID_NDK_HOME}
              export JAVA_HOME=${androidEnvironment.JAVA_HOME}
              export GRADLE_OPTS=${androidEnvironment.GRADLE_OPTS}
              export PATH=${androidHome}/platform-tools:${androidHome}/cmdline-tools/${cmdLineToolsVersion}/bin:$PATH

              ${builtins.readFile ./scripts/build-android-apk.sh}
            '';
          };
        in
        {
          inherit
            androidEnvironment
            androidHome
            androidSdk
            cmdLineToolsVersion
            releaseRunner
            ;
        };
    in
    {
      packages = forAllSystems (
        system:
        let
          pkgs = pkgsFor system;
          paseo = pkgs.callPackage ./nix/package.nix { };
          versionParts = pkgs.lib.splitString "." paseo.version;
          sourceRevision = if self ? revCount && self.revCount != null then self.revCount else 0;
          buildRevision = sourceRevision - (sourceRevision / 10000) * 10000;
          desktopBuildVersion = pkgs.lib.concatStringsSep "." [
            (builtins.elemAt versionParts 0)
            (builtins.elemAt versionParts 1)
            (toString buildRevision)
          ];
        in
        {
          default = paseo;
          paseo = paseo;
          desktop = pkgs.callPackage ./nix/desktop-package.nix {
            inherit paseo;
            buildVersion = desktopBuildVersion;
          };
        }
        // nixpkgs.lib.optionalAttrs (system == "x86_64-linux") {
          android-sdk = (androidFor system).androidSdk;
          android-release-runner = (androidFor system).releaseRunner;
        }
      );

      apps = forAllSystems (
        system:
        nixpkgs.lib.optionalAttrs (system == "x86_64-linux") {
          android-release = {
            type = "app";
            program = "${(androidFor system).releaseRunner}/bin/paseo-android-release";
          };
        }
      );

      nixosModules.default = self.nixosModules.paseo;
      nixosModules.paseo =
        { pkgs, lib, ... }:
        {
          imports = [ ./nix/module.nix ];
          services.paseo.package = lib.mkDefault self.packages.${pkgs.stdenv.hostPlatform.system}.default;
        };

      devShells = forAllSystems (
        system:
        let
          pkgs = pkgsFor system;
        in
        {
          default = pkgs.mkShell {
            packages = [
              pkgs.nodejs_22
              pkgs.python3
            ];
          };
        }
        // nixpkgs.lib.optionalAttrs (system == "x86_64-linux") {
          android =
            let
              android = androidFor system;
            in
            pkgs.mkShell (
              android.androidEnvironment
              // {
                packages = [
                  android.androidSdk
                  pkgs.jdk21_headless
                  pkgs.nodejs_22
                  pkgs.python3
                ];

                shellHook = ''
                  export PATH=${android.androidHome}/platform-tools:${android.androidHome}/cmdline-tools/${android.cmdLineToolsVersion}/bin:$PATH

                  echo "Paseo Android development shell"
                  echo "  Node: $(node --version)"
                  echo "  Java: $(java -version 2>&1 | head -n 1)"
                  echo "  ANDROID_HOME: $ANDROID_HOME"
                  echo
                  echo "Build a release APK with: nix run .#android-release"
                '';
              }
            );
        }
      );
    };
}
