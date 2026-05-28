{
  lib,
  stdenv,
  buildNpmPackage,
  nodejs_22,
  python3,
  makeWrapper,
  copyDesktopItems,
  makeDesktopItem,
  electron,
  libuv,
  # Reuse the daemon's prebuilt npm-deps FOD. Same lockfile, same content —
  # without this, the desktop drv produces a separately-named store path
  # (`paseo-desktop-<v>-npm-deps`) and refetches the entire registry. Override
  # the upstream hash via `paseo.override { npmDepsHash = "..."; }`.
  paseo,
}:

buildNpmPackage rec {
  pname = "paseo-desktop";
  version = (builtins.fromJSON (builtins.readFile ../package.json)).version;

  src = lib.cleanSourceWith {
    src = ./..;
    filter =
      path: type:
      let
        baseName = builtins.baseNameOf path;
        relPath = lib.removePrefix (toString ./..) path;
      in
      # Exclude mobile-only platform code (we only need the web/electron build)
      !(lib.hasPrefix "/packages/app/android" relPath)
      && !(lib.hasPrefix "/packages/app/ios" relPath)
      # Website is unrelated to the desktop app
      && !(lib.hasPrefix "/packages/website" relPath)
      # Test fixtures and build artifacts
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

  # Prevent onnxruntime-node's install script from running during automatic
  # npm rebuild. We manually rebuild only node-pty in buildPhase.
  npmRebuildFlags = [ "--ignore-scripts" ];

  nativeBuildInputs = [
    python3 # for node-gyp (node-pty)
    makeWrapper
    copyDesktopItems
  ];

  buildInputs = lib.optionals stdenv.hostPlatform.isLinux [ libuv ];

  dontNpmBuild = true;

  env = {
    EXPO_NO_TELEMETRY = "1";
    # Expo's web build pulls in some pre-bundled assets; ensure it doesn't try
    # to phone home during the build.
    CI = "1";
  };

  buildPhase = ''
    runHook preBuild

    # Native deps (terminal emulation; libuv-linked on Linux)
    npm rebuild node-pty

    # Server workspaces (highlight + relay + protocol + client + server + cli)
    npm run build:server

    # App workspace deps not covered by build:server
    npm run build --workspace=@getpaseo/expo-two-way-audio

    # Expo web export for the Electron renderer
    ( cd packages/app && PASEO_WEB_PLATFORM=electron npx expo export --platform web )

    # Desktop main process (tsc only — NOT electron-builder)
    npm run build:main --workspace=@getpaseo/desktop

    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall

    mkdir -p $out/share/paseo-desktop $out/bin

    # Preserve the monorepo layout so main.js's dev-mode path resolution
    # (`__dirname/../../app/dist`, `__dirname/../assets/icon.png`) works
    # without patching: invoked unpackaged via `electron path/to/main.js`,
    # `app.isPackaged` is false, so these relative paths are used.
    #
    # Copy the entire packages/ tree (not just built artifacts) because npm
    # creates workspace symlinks from node_modules/@getpaseo/* into packages/*.
    # Missing any workspace package leaves dangling symlinks and fails the
    # noBrokenSymlinks output check. The cleanSourceWith filter above already
    # drops the big platform-specific things (android/ios, website, tests).
    cp package.json $out/share/paseo-desktop/
    cp -a packages $out/share/paseo-desktop/
    cp -a node_modules $out/share/paseo-desktop/

    # Skills directory referenced at runtime by some agents
    if [ -d skills ]; then
      cp -a skills $out/share/paseo-desktop/
    fi

    # Hicolor icon for desktop environments
    install -Dm644 packages/desktop/assets/icon.png \
      $out/share/icons/hicolor/512x512/apps/paseo-desktop.png

    # Launcher wraps nixpkgs electron.
    # --no-sandbox: Chromium's setuid sandbox can't live in /nix/store
    # (immutable, no setuid). Acceptable for v1; a follow-up can wire
    # `security.wrappers` via a NixOS module for users who want the sandbox.
    #
    # EXPO_DEV_URL: We run unpackaged via `electron path/to/main.js`, so
    # `app.isPackaged` is false. In that mode main.ts loads `DEV_SERVER_URL`
    # (defaults to http://localhost:8081 — the Expo dev server, which doesn't
    # exist here). Point it at the `paseo://` protocol handler instead, which
    # serves from `__dirname/../../app/dist` (our install layout matches).
    makeWrapper ${electron}/bin/electron $out/bin/paseo-desktop \
      --add-flags "$out/share/paseo-desktop/packages/desktop/dist/main.js" \
      --add-flags "--no-sandbox" \
      --set EXPO_DEV_URL "paseo://app/"

    copyDesktopItems

    runHook postInstall
  '';

  desktopItems = [
    (makeDesktopItem {
      name = "paseo-desktop";
      desktopName = "Paseo";
      genericName = "AI Coding Agents";
      comment = "Self-hosted daemon for AI coding agents";
      exec = "paseo-desktop";
      icon = "paseo-desktop";
      categories = [ "Development" ];
      startupWMClass = "Paseo";
    })
  ];

  meta = {
    description = "Paseo desktop app (Electron wrapper)";
    homepage = "https://github.com/getpaseo/paseo";
    license = lib.licenses.agpl3Plus;
    mainProgram = "paseo-desktop";
    platforms = lib.platforms.linux;
  };
}
