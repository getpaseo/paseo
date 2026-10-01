{
  lib,
  stdenv,
  buildNpmPackage,
  nodejs_22,
  python3,
  makeWrapper,
  autoPatchelfHook,
  copyDesktopItems,
  makeDesktopItem,
  electron,
  libuv,
  buildVersion,
  paseo,
}:
buildNpmPackage {
  pname = "paseo-desktop";
  version = (builtins.fromJSON (builtins.readFile ../package.json)).version;

  src = lib.cleanSourceWith {
    src = ./..;
    filter = path: type: let
      baseName = builtins.baseNameOf path;
      relPath = lib.removePrefix (toString ./..) path;
    in
      !(lib.hasPrefix "/packages/app/android" relPath)
      && !(lib.hasPrefix "/packages/app/ios" relPath)
      && !(lib.hasPrefix "/packages/website" relPath)
      && !(lib.hasPrefix "/docs" relPath)
      && !(lib.hasPrefix "/.github" relPath)
      && !(lib.hasPrefix "/.agents" relPath)
      && !(lib.hasPrefix "/.claude" relPath)
      && !(lib.hasPrefix "/.codex" relPath)
      && !(lib.hasPrefix "/docker" relPath)
      && builtins.match "/[^/]+\\.md" relPath == null
      && !(lib.hasSuffix ".test.ts" baseName)
      && !(lib.hasSuffix ".e2e.test.ts" baseName)
      && baseName != "node_modules"
      && baseName != ".git"
      && baseName != ".paseo"
      && baseName != ".DS_Store"
      && baseName != "release";
  };

  nodejs = nodejs_22;
  inherit (paseo) npmDeps;

  npmRebuildFlags = ["--ignore-scripts"];

  nativeBuildInputs =
    [
      python3
    ]
    ++ lib.optionals stdenv.hostPlatform.isLinux [
      autoPatchelfHook
      makeWrapper
      copyDesktopItems
    ];

  buildInputs = lib.optionals stdenv.hostPlatform.isLinux [
    libuv
    stdenv.cc.cc.lib
  ];

  autoPatchelfIgnoreMissingDeps =
    lib.optionals (stdenv.hostPlatform.isLinux && !stdenv.hostPlatform.isMusl) [
      "libc.musl-*.so.*"
    ];

  dontNpmBuild = true;

  env = {
    EXPO_NO_TELEMETRY = "1";
    NODE_OPTIONS = "--max-old-space-size=4096";
    CI = "1";
  };

  buildPhase = ''
    runHook preBuild

    npm rebuild node-pty

    npm run build:server

    npm run build --workspace=@getpaseo/expo-two-way-audio

    ( cd packages/app && PASEO_WEB_PLATFORM=electron npx expo export --platform web )

    npm run build:main --workspace=@getpaseo/desktop

    ${lib.optionalString stdenv.hostPlatform.isDarwin ''
      substituteInPlace packages/desktop/electron-builder.yml \
        --replace-fail 'afterSign: ./scripts/after-sign.js' 'afterSign: null'
      electron_dist="$NIX_BUILD_TOP/electron-dist"
      mkdir -p "$electron_dist"
      cp -R ${electron}/Applications/Electron.app "$electron_dist/"
      chmod -R u+w "$electron_dist/Electron.app"
      (
        cd packages/desktop
        CSC_IDENTITY_AUTO_DISCOVERY=false \
          ../../node_modules/.bin/electron-builder \
            --config electron-builder.yml \
            --dir \
            --mac \
            --publish never \
            --config.electronDist="$electron_dist" \
            --config.buildVersion=${lib.escapeShellArg buildVersion} \
            --config.mac.identity=null \
            --config.mac.hardenedRuntime=false \
            --config.mac.notarize=false
      )
    ''}

    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall

    mkdir -p $out/bin

    ${lib.optionalString stdenv.hostPlatform.isLinux ''
      mkdir -p $out/share/paseo-desktop

      PASEO_TRACE_DESKTOP=1 node scripts/trace-daemon.mjs > desktop-files.txt

      while IFS= read -r path; do
        [ -z "$path" ] && continue
        mkdir -p "$out/share/paseo-desktop/$(dirname "$path")"
        cp -a "$path" "$out/share/paseo-desktop/$path"
      done < desktop-files.txt

      cp package.json $out/share/paseo-desktop/
      mkdir -p $out/share/paseo-desktop/packages/app
      cp -a packages/app/dist $out/share/paseo-desktop/packages/app/

      for runtime_path in \
        packages/desktop/dist/main.js \
        packages/desktop/dist/preload.js \
        packages/desktop/dist/features/browser-keyboard/guest-preload.js \
        packages/desktop/package.json; do
        if [ ! -e "$out/share/paseo-desktop/$runtime_path" ]; then
          echo "desktop runtime trace omitted $runtime_path" >&2
          exit 1
        fi
      done

      if [ -e $out/share/paseo-desktop/node_modules/electron ]; then
        echo "desktop runtime trace included npm Electron" >&2
        exit 1
      fi

      install -Dm644 packages/desktop/assets/icon.png \
        $out/share/icons/hicolor/512x512/apps/paseo-desktop.png

      mkdir -p $out/share/paseo-desktop/electron-app
      printf '%s\n' "{ \"name\": \"paseo-desktop\", \"version\": \"$version\", \"main\": \"index.js\" }" \
        > $out/share/paseo-desktop/electron-app/package.json
      printf '%s\n' 'require("../packages/desktop/dist/main.js");' \
        > $out/share/paseo-desktop/electron-app/index.js

      makeWrapper ${electron}/bin/electron $out/bin/paseo-desktop \
        --add-flags "$out/share/paseo-desktop/electron-app" \
        --add-flags "--no-sandbox" \
        --add-flags "--class=paseo-desktop" \
        --set EXPO_DEV_URL "paseo://app/" \
        --set CHROME_DESKTOP "paseo-desktop.desktop"

      copyDesktopItems
    ''}

    ${lib.optionalString stdenv.hostPlatform.isDarwin ''
      app="$(find packages/desktop/release -maxdepth 3 -type d -name PandaOS.app -print -quit)"
      if [ -z "$app" ]; then
        echo "electron-builder did not produce PandaOS.app" >&2
        exit 1
      fi
      mkdir -p "$out/Applications"
      cp -R "$app" "$out/Applications/PandaOS.app"
      ln -s ../Applications/PandaOS.app/Contents/MacOS/PandaOS "$out/bin/paseo-desktop"
    ''}

    runHook postInstall
  '';

  desktopItems = lib.optionals stdenv.hostPlatform.isLinux [
    (makeDesktopItem {
      name = "paseo-desktop";
      desktopName = "PandaOS";
      genericName = "AI Coding Agents";
      comment = "Self-hosted daemon for AI coding agents";
      exec = "paseo-desktop";
      icon = "paseo-desktop";
      categories = ["Development"];
      startupWMClass = "paseo-desktop";
    })
    (makeDesktopItem {
      name = "PandaOS";
      desktopName = "PandaOS";
      genericName = "AI Coding Agents";
      comment = "Self-hosted daemon for AI coding agents";
      exec = "paseo-desktop";
      icon = "paseo-desktop";
      categories = [ "Development" ];
      startupWMClass = "PandaOS";
      noDisplay = true;
    })
  ];

  meta = {
    description = "PandaOS desktop app (Electron wrapper)";
    homepage = "https://github.com/getpaseo/paseo";
    license = lib.licenses.agpl3Plus;
    mainProgram = "paseo-desktop";
    platforms = lib.platforms.linux ++ lib.platforms.darwin;
  };
}
