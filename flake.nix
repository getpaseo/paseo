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
      pkgsFor = system: import nixpkgs { inherit system; };
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
      );
    };
}
