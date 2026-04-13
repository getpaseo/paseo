{
  config,
  lib,
  pkgs,
  ...
}:

let
  cfg = config.services.hubcode;
in
{
  options.services.hubcode = {
    enable = lib.mkEnableOption "Hubcode, a self-hosted daemon for AI coding agents";

    package = lib.mkPackageOption pkgs "hubcode" { };

    user = lib.mkOption {
      type = lib.types.str;
      default = "hubcode";
      description = "User account under which Hubcode runs.";
    };

    group = lib.mkOption {
      type = lib.types.str;
      default = "hubcode";
      description = "Group under which Hubcode runs.";
    };

    dataDir = lib.mkOption {
      type = lib.types.str;
      default =
        if cfg.user == "hubcode"
        then "/var/lib/hubcode"
        else "/home/${cfg.user}/.hubcode";
      defaultText = lib.literalExpression ''
        if cfg.user == "hubcode"
        then "/var/lib/hubcode"
        else "/home/''${cfg.user}/.hubcode"
      '';
      description = "Directory for Hubcode state (HUBCODE_HOME). Stores agent data, config, and logs.";
    };

    port = lib.mkOption {
      type = lib.types.port;
      default = 6767;
      description = "Port for the Hubcode daemon to listen on.";
    };

    listenAddress = lib.mkOption {
      type = lib.types.str;
      default = "127.0.0.1";
      description = "Address for the Hubcode daemon to bind to.";
    };

    openFirewall = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = "Whether to open the firewall for the Hubcode daemon port.";
    };

    allowedHosts = lib.mkOption {
      type = lib.types.either (lib.types.enum [ true ]) (lib.types.listOf lib.types.str);
      default = [ ];
      example = [ ".example.com" "myhost.local" ];
      description = ''
        Hosts allowed to connect to the Hubcode daemon (DNS rebinding protection).
        Localhost and IP addresses are always allowed by default.

        Use a leading dot to match a domain and all its subdomains
        (e.g. `".example.com"` matches `example.com` and `foo.example.com`).

        Set to `true` to allow any host (not recommended).
      '';
    };

    relay = {
      enable = lib.mkOption {
        type = lib.types.bool;
        default = true;
        description = "Whether to enable the relay connection for remote access via app.hubcode.sh.";
      };
    };

    inheritUserEnvironment = lib.mkOption {
      type = lib.types.bool;
      default = cfg.user != "hubcode";
      defaultText = lib.literalExpression ''cfg.user != "hubcode"'';
      description = ''
        Whether to include the user's profile PATH in the service environment.

        When Hubcode runs as a real user (not the default system user), AI agents
        need access to the user's tools (git, ssh, etc.). This adds the user's
        NixOS profile and system paths so agents can use them without manually
        setting PATH.

        Enabled by default when `user` is set to a non-default value.
      '';
    };

    environment = lib.mkOption {
      type = lib.types.attrsOf lib.types.str;
      default = { };
      example = lib.literalExpression ''
        {
          HUBCODE_RELAY_ENDPOINT = "relay.hubcode.sh:443";
        }
      '';
      description = "Extra environment variables for the Hubcode daemon.";
    };
  };

  config = lib.mkIf cfg.enable {
    users.users.${cfg.user} = lib.mkIf (cfg.user == "hubcode") {
      isSystemUser = true;
      group = cfg.group;
      home = cfg.dataDir;
    };

    users.groups.${cfg.group} = lib.mkIf (cfg.group == "hubcode") { };

    systemd.tmpfiles.rules = [
      "d ${cfg.dataDir} 0700 ${cfg.user} ${cfg.group} - -"
    ];

    systemd.services.hubcode = {
      description = "Hubcode - self-hosted daemon for AI coding agents";
      after = [ "network.target" ];
      wantedBy = [ "multi-user.target" ];

      environment = {
        NODE_ENV = "production";
        HUBCODE_HOME = cfg.dataDir;
        HUBCODE_LISTEN = "${cfg.listenAddress}:${toString cfg.port}";
      } // lib.optionalAttrs cfg.inheritUserEnvironment {
        # mkForce overrides the default PATH from NixOS's systemd module (which
        # only includes store paths for coreutils/grep/sed/systemd). Our PATH
        # includes /run/current-system/sw/bin which is a superset of those.
        PATH = lib.mkForce (lib.concatStringsSep ":" [
          "/etc/profiles/per-user/${cfg.user}/bin"
          "/run/current-system/sw/bin"
          "/run/wrappers/bin"
          "/nix/var/nix/profiles/default/bin"
        ]);
      } // lib.optionalAttrs (cfg.allowedHosts == true) {
        HUBCODE_ALLOWED_HOSTS = "true";
      } // lib.optionalAttrs (lib.isList cfg.allowedHosts && cfg.allowedHosts != [ ]) {
        HUBCODE_ALLOWED_HOSTS = lib.concatStringsSep "," cfg.allowedHosts;
      } // cfg.environment;

      serviceConfig = {
        Type = "simple";
        User = cfg.user;
        Group = cfg.group;

        ExecStart =
          "${cfg.package}/bin/hubcode-server"
          + lib.optionalString (!cfg.relay.enable) " --no-relay";

        Restart = "on-failure";
        RestartSec = 5;

        # Graceful shutdown (server handles SIGTERM with a 10s timeout)
        KillSignal = "SIGTERM";
        TimeoutStopSec = 15;
      };
    };

    environment.systemPackages = [ cfg.package ];

    networking.firewall.allowedTCPPorts = lib.mkIf cfg.openFirewall [ cfg.port ];
  };
}
