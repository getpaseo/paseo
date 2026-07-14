{
  lib,
  stdenv,
  buildNpmPackage,
  nodejs_22,
  python3,
  makeWrapper,
  # node-pty needs libuv headers on Linux
  libuv,
  # Exposed so downstream flakes that follow a different nixpkgs revision
  # (where `fetchNpmDeps` may produce a different hash for the same lockfile)
  # can override via `.override { npmDepsHash = "sha256-..."; }` without
  # `overrideAttrs` gymnastics — `npmDepsHash` is destructured from
  # `buildNpmPackage`'s args, so `overrideAttrs` cannot reach it.
  #
  # The default is read from a sidecar file so the CI auto-updater can replace
  # the hash with a single file write instead of a sed against this source.
  npmDepsHash ? lib.fileContents ./npm-deps.hash,
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
      !(lib.hasPrefix "/packages/app/android" relPath)
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

  # Default hash lives in nix/npm-deps.hash (see arg default above).
  # CI auto-updates that file when package-lock.json changes (see .github/workflows/).
  inherit npmDepsHash;

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

    # Build all server packages in dependency order (defined in package.json)
    npm run build:server
    npm run build:daemon-web-ui

    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall

    # Compute the daemon's runtime closure by static module-graph tracing
    # (@vercel/nft from supervisor-entrypoint.js, cli/dist/index.js, and the
    # forked terminal-worker-process.js) plus an explicit list of non-JS
    # assets read at runtime. The trace script is the single source of
    # truth for what the daemon needs at $out — auditable in plain JS, no
    # npm hoisting / .bin / workspace-symlink footguns.
    mkdir -p $out/lib/paseo
    node scripts/trace-daemon.mjs > daemon-files.txt

    while IFS= read -r path; do
      [ -z "$path" ] && continue
      mkdir -p "$out/lib/paseo/$(dirname "$path")"
      cp -a "$path" "$out/lib/paseo/$path"
    done < daemon-files.txt

    # Root package.json lets node resolve the workspace layout when the
    # CLI/server bin starts from $out.
    cp package.json $out/lib/paseo/

    # Web UI Assets
    cp -r packages/server/dist/server/web-ui $out/lib/paseo/packages/server/dist/server/

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
