const PASEO_NODE_ENV = "PASEO_NODE_ENV";
const PASEO_SERVICE_MANAGED = "PASEO_SERVICE_MANAGED";

export interface NodeEntrypointSpec {
  entryPath: string;
  execArgv: string[];
}

export interface NodeEntrypointInvocation {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

export type NodeEntrypointArgvMode = "bare" | "node-script";

interface CreateNodeEntrypointInvocationInput {
  execPath: string;
  isPackaged: boolean;
  packagedRunnerPath: string | null;
  entrypoint: NodeEntrypointSpec;
  argvMode: NodeEntrypointArgvMode;
  args: string[];
  baseEnv: NodeJS.ProcessEnv;
}

export function createElectronNodeEnv(
  baseEnv: NodeJS.ProcessEnv,
  options?: { isPackaged?: boolean },
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...baseEnv,
    ELECTRON_RUN_AS_NODE: "1",
    [PASEO_NODE_ENV]: options?.isPackaged === true ? "production" : "development",
  };
  // A daemon the desktop starts is owned by the desktop, never by a service
  // manager, and the desktop has to be able to stop it again on quit. The value
  // can arrive from the launching shell, from a login profile that survives
  // shell resolution, or from an inherited env kept after resolution fails, so
  // delete it here rather than trying to catch every source. An overlay cannot
  // do this — spreading an absent key leaves the inherited one in place.
  delete env[PASEO_SERVICE_MANAGED];
  return env;
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
