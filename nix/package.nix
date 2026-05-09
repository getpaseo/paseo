{
  lib,
  stdenv,
  buildNpmPackage,
  nodejs_22,
  python3,
  makeWrapper,
  # node-pty needs libuv headers on Linux
  libuv,
}:

buildNpmPackage rec {
  pname = "paseo";
  version = (builtins.fromJSON (builtins.readFile ../package.json)).version;

  src = lib.cleanSourceWith {
    src = ./..;
    filter = path: type:
      let
        baseName = builtins.baseNameOf path;
        relPath = lib.removePrefix (toString ./..) path;
      in
      # Exclude non-daemon workspace contents (keep package.json for workspace resolution)
      !(lib.hasPrefix "/packages/app/src" relPath)
      && !(lib.hasPrefix "/packages/app/assets" relPath)
      && !(lib.hasPrefix "/packages/app/android" relPath)
      && !(lib.hasPrefix "/packages/app/ios" relPath)
      && !(lib.hasPrefix "/packages/website/src" relPath)
      && !(lib.hasPrefix "/packages/website/public" relPath)
      && !(lib.hasPrefix "/packages/desktop/src" relPath)
      && !(lib.hasPrefix "/packages/desktop/src-tauri" relPath)
      # Exclude test fixtures and debug files
      && !(lib.hasSuffix ".test.ts" baseName)
      && !(lib.hasSuffix ".e2e.test.ts" baseName)
      && baseName != "node_modules"
      && baseName != ".git"
      && baseName != ".paseo"
      && baseName != ".DS_Store";
  };

  nodejs = nodejs_22;

  # To update: run `nix build` with lib.fakeHash, copy the `got:` hash.
  # CI auto-updates this when package-lock.json changes (see .github/workflows/).
  npmDepsHash = "sha256-ocBSTgfzPlucgcCaPRi3iYhxpZD6hTzD3b2lphSTtb4=";

  # Prevent onnxruntime-node's install script from running during automatic
  # npm rebuild (it tries to download from api.nuget.org, which fails in the sandbox).
  # We manually rebuild only node-pty in buildPhase.
  npmRebuildFlags = [ "--ignore-scripts" ];

  nativeBuildInputs = [
    python3 # for node-gyp (node-pty compilation)
    makeWrapper
  ];

  buildInputs = lib.optionals stdenv.hostPlatform.isLinux [
    libuv
  ];

  # Don't use the default npm build hook — we need a custom build sequence
  dontNpmBuild = true;

  buildPhase = ''
    runHook preBuild

    # Rebuild only node-pty (native addon for terminal emulation).
    # Speech-related native modules (sherpa-onnx, onnxruntime-node) are
    # intentionally left unbuilt — they're lazily loaded and gracefully
    # degrade when unavailable.
    npm rebuild node-pty

    # Build all daemon packages in dependency order (defined in package.json)
    npm run build:daemon

    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall

    mkdir -p $out/lib/paseo

    # Copy root package metadata
    cp package.json $out/lib/paseo/

    # Copy node_modules (preserving workspace symlinks)
    cp -a node_modules $out/lib/paseo/

    # Auto-detect which @getpaseo/* packages were built by build:daemon
    # (they'll have a dist/ directory). Copy those and remove the rest.
    for link in $out/lib/paseo/node_modules/@getpaseo/*; do
      name=$(basename "$link")
      if [ -d "packages/$name/dist" ]; then
        mkdir -p "$out/lib/paseo/packages/$name"
        cp "packages/$name/package.json" "$out/lib/paseo/packages/$name/"
        cp -a "packages/$name/dist" "$out/lib/paseo/packages/$name/"
        if [ -d "packages/$name/node_modules" ]; then
          cp -a "packages/$name/node_modules" "$out/lib/paseo/packages/$name/"
        fi
      else
        rm -f "$link"
      fi
    done

    # Copy CLI bin entry
    mkdir -p $out/lib/paseo/packages/cli/bin
    cp packages/cli/bin/paseo $out/lib/paseo/packages/cli/bin/

    # Copy extra server files referenced at runtime
    for f in agent-prompt.md .env.example; do
      if [ -f packages/server/$f ]; then
        cp packages/server/$f $out/lib/paseo/packages/server/
      fi
    done

    # Copy server scripts (including supervisor-entrypoint) needed by CLI
    if [ -d packages/server/dist/scripts ]; then
      mkdir -p $out/lib/paseo/packages/server/dist/scripts
      cp -a packages/server/dist/scripts/* $out/lib/paseo/packages/server/dist/scripts/
    fi

    # Create wrapper for the server entry point (for systemd / direct use)
    mkdir -p $out/bin
    makeWrapper ${nodejs}/bin/node $out/bin/paseo-server \
      --add-flags "$out/lib/paseo/packages/server/dist/scripts/supervisor-entrypoint.js" \
      --set NODE_ENV production

    # Create wrapper for the CLI
    makeWrapper ${nodejs}/bin/node $out/bin/paseo \
      --add-flags "$out/lib/paseo/packages/cli/dist/index.js" \
      --set NODE_PATH "$out/lib/paseo/node_modules"

    runHook postInstall
  '';

  meta = {
    description = "Self-hosted daemon for Claude Code, Codex, and OpenCode";
    homepage = "https://github.com/getpaseo/paseo";
    license = lib.licenses.agpl3Plus;
    mainProgram = "paseo";
    platforms = lib.platforms.linux ++ lib.platforms.darwin;
  };
}
