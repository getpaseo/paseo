import { parseHostTarget } from "@getpaseo/protocol/host-target";
import { resolvePaseoHome } from "@getpaseo/server/daemon-control";

export type DaemonTarget = { kind: "instance"; home: string } | { kind: "endpoint"; host: string };

export function selectDaemonTarget(
  options: { home?: string; host?: string },
  env: NodeJS.ProcessEnv = process.env,
  localOnly = false,
): DaemonTarget {
  for (const key of ["home", "host"] as const) {
    if (options[key] !== undefined && !options[key]!.trim())
      throw { code: "TARGET_INVALID", message: `--${key} requires a non-empty value.` };
  }
  if (options.home !== undefined && options.host !== undefined)
    throw { code: "TARGET_AMBIGUOUS", message: "Choose either --home or --host, not both." };
  if (localOnly) {
    if (options.host !== undefined)
      throw {
        code: "LOCAL_OPERATION",
        message: "This is a local operation; use --home. --host is not supported.",
      };
    return {
      kind: "instance",
      home: resolvePaseoHome({ PASEO_HOME: options.home ?? env.PASEO_HOME }),
    };
  }
  if (options.home !== undefined)
    return { kind: "instance", home: resolvePaseoHome({ PASEO_HOME: options.home }) };
  if (options.host !== undefined) return { kind: "endpoint", host: options.host };
  if (env.PASEO_HOME && env.PASEO_HOST)
    throw {
      code: "TARGET_AMBIGUOUS",
      message: "PASEO_HOME and PASEO_HOST are both set. Choose --home or --host explicitly.",
    };
  if (env.PASEO_HOST) return { kind: "endpoint", host: env.PASEO_HOST };
  return { kind: "instance", home: resolvePaseoHome({ PASEO_HOME: env.PASEO_HOME }) };
}

export function describeDaemonTarget(target: DaemonTarget): string {
  if (target.kind === "instance") return `home ${target.home}`;
  try {
    return parseHostTarget(target.host).description;
  } catch {
    return "<invalid endpoint>";
  }
}
