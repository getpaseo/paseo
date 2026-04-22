const IGNORED_ARG_PREFIXES = ["-psn_", "--no-sandbox"];

export const DESKTOP_CLI_ENV = "PASEO_DESKTOP_CLI";

export type NodeEntrypointSpec = {
  entryPath: string;
  execArgv: string[];
};

export type NodeEntrypointInvocation = {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
};

export type NodeEntrypointArgvMode = "bare" | "node-script";

type CreateNodeEntrypointInvocationInput = {
  execPath: string;
  isPackaged: boolean;
  packagedRunnerPath: string | null;
  entrypoint: NodeEntrypointSpec;
  argvMode: NodeEntrypointArgvMode;
  args: string[];
  baseEnv: NodeJS.ProcessEnv;
};

type ParseCliPassthroughArgsFromArgvInput = {
  argv: string[];
  isDefaultApp: boolean;
  forceCli: boolean;
};

export function createElectronNodeEnv(
  baseEnv: NodeJS.ProcessEnv,
  options?: { isPackaged?: boolean },
): NodeJS.ProcessEnv {
  return {
    ...baseEnv,
    ELECTRON_RUN_AS_NODE: "1",
    ...(options?.isPackaged === true ? { NODE_ENV: "production" } : {}),
  };
}

export function parseCliPassthroughArgsFromArgv(
  input: ParseCliPassthroughArgsFromArgvInput,
): string[] | null {
  const startIndex = input.isDefaultApp ? 2 : 1;
  const effective: string[] = [];

  for (const arg of input.argv.slice(startIndex)) {
    if (IGNORED_ARG_PREFIXES.some((prefix) => arg.startsWith(prefix))) {
      continue;
    }
    effective.push(arg);
  }

  if (input.forceCli) {
    return effective;
  }

  return effective.length > 0 ? effective : null;
}

export function createNodeEntrypointInvocation(
  input: CreateNodeEntrypointInvocationInput,
): NodeEntrypointInvocation {
  const env = createElectronNodeEnv(input.baseEnv, { isPackaged: input.isPackaged });

  if (input.isPackaged) {
    if (!input.packagedRunnerPath) {
      throw new Error("Packaged node entrypoint runner is required for desktop launches.");
    }

    return {
      command: input.execPath,
      args: [
        "--disable-warning=DEP0040",
        input.packagedRunnerPath,
        input.argvMode,
        input.entrypoint.entryPath,
        ...input.args,
      ],
      env,
    };
  }

  return {
    command: input.execPath,
    args: [...input.entrypoint.execArgv, input.entrypoint.entryPath, ...input.args],
    env,
  };
}
