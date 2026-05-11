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
  # Shares the daemon's npm-deps hash — same package-lock.json, same fetcher.
  # Override via `.override { npmDepsHash = "..."; }` if your nixpkgs computes a
  # different value.
  npmDepsHash ? lib.fileContents ./npm-deps.hash,
}:

buildNpmPackage rec {
  pname = "paseo-desktop";
  version = (builtins.fromJSON (builtins.readFile ../package.json)).version;

  src = lib.cleanSourceWith {
    src = ./..;
    filter = path: type:
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
  inherit npmDepsHash;

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

    # Daemon workspaces (highlight + relay + server + cli)
    npm run build:daemon

    # App workspace deps not covered by build:daemon
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
    cp package.json $out/share/paseo-desktop/

    mkdir -p $out/share/paseo-desktop/packages/desktop
    cp -a packages/desktop/dist $out/share/paseo-desktop/packages/desktop/
    cp -a packages/desktop/assets $out/share/paseo-desktop/packages/desktop/
    cp packages/desktop/package.json $out/share/paseo-desktop/packages/desktop/

    mkdir -p $out/share/paseo-desktop/packages/app
    cp -a packages/app/dist $out/share/paseo-desktop/packages/app/
    cp packages/app/package.json $out/share/paseo-desktop/packages/app/

    # Built daemon workspaces (server, cli, relay, highlight, expo-two-way-audio)
    for pkg in server cli relay highlight expo-two-way-audio; do
      if [ -d packages/$pkg/dist ]; then
        mkdir -p $out/share/paseo-desktop/packages/$pkg
        cp packages/$pkg/package.json $out/share/paseo-desktop/packages/$pkg/
        cp -a packages/$pkg/dist $out/share/paseo-desktop/packages/$pkg/
      fi
    done

    # node_modules (with workspace symlinks intact)
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
    makeWrapper ${electron}/bin/electron $out/bin/paseo-desktop \
      --add-flags "$out/share/paseo-desktop/packages/desktop/dist/main.js" \
      --add-flags "--no-sandbox"

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
