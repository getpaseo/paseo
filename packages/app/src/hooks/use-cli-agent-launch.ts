// useCliAgentLaunch — launches CLI agents in a daemon terminal
// Uses the extended create_terminal_request with command+args

import { useCallback } from "react";
import { useMutation } from "@tanstack/react-query";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import {
  buildCliAgentArgs,
  getCliProvider,
  type CliProviderId,
} from "@server/shared/cli-provider-registry";
import { useDaemonConfig } from "./use-daemon-config";

export interface LaunchCliAgentOptions {
  /** CLI provider ID (e.g. "claude", "codex", "gemini") */
  providerId: CliProviderId;
  /** Working directory for the agent */
  cwd: string;
  /** Enable auto-approve mode (dangerous) */
  autoApprove?: boolean;
  /** Initial prompt to pass to the agent */
  initialPrompt?: string;
  /** Whether to resume an existing session */
  resume?: boolean;
  /** Extra CLI arguments */
  extraArgs?: string[];
  /** Extra env vars to inject */
  env?: Record<string, string>;
  /** Terminal display name */
  name?: string;
}

interface LaunchResult {
  terminalId: string;
  name: string;
  cwd: string;
}

export function useCliAgentLaunch(serverId: string | null) {
  const client = useHostRuntimeClient(serverId ?? "");
  const { config } = useDaemonConfig(serverId ?? "");
  const cliProviderOverrides = config?.agents?.cliProviders;

  const mutation = useMutation<LaunchResult, Error, LaunchCliAgentOptions>({
    mutationFn: async (options) => {
      if (!client) {
        throw new Error("Host is not connected");
      }

      const provider = getCliProvider(options.providerId, cliProviderOverrides);
      if (!provider) {
        throw new Error(`Unknown CLI provider: ${options.providerId}`);
      }

      const command = provider.cli ?? provider.commands?.[0];
      if (!command) {
        throw new Error(`No CLI command defined for provider: ${options.providerId}`);
      }

      const args = buildCliAgentArgs(
        {
          providerId: options.providerId,
          autoApprove: options.autoApprove,
          initialPrompt: options.initialPrompt,
          resume: options.resume,
          extraArgs: options.extraArgs,
        },
        cliProviderOverrides,
      );

      const result = await client.createCliAgentTerminal({
        cwd: options.cwd,
        command,
        args,
        name: options.name ?? `${provider.name}`,
        env: options.env,
      });

      if (result.error || !result.terminal) {
        throw new Error(result.error ?? "Failed to launch CLI agent terminal");
      }

      return {
        terminalId: result.terminal.id,
        name: result.terminal.name,
        cwd: result.terminal.cwd,
      };
    },
  });

  const launch = useCallback(
    (options: LaunchCliAgentOptions) => mutation.mutateAsync(options),
    [mutation],
  );

  return {
    launch,
    isLaunching: mutation.isPending,
    error: mutation.error?.message ?? null,
    lastResult: mutation.data ?? null,
  };
}
