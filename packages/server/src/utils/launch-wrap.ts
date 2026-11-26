/** A plugin's launch wrap: an absolute executable and its arguments. */
export type LaunchWrap = readonly [string, ...string[]];

export interface CommandLaunch {
  command: string;
  args: string[];
}

/**
 * The launch that starts `launch` behind `wrap`: `[...wrap, command, ...args]`. Use it where the
 * process is not started by `spawnProcess`, which takes the wrap as an option.
 */
export function applyLaunchWrap(
  launch: CommandLaunch,
  wrap: LaunchWrap | undefined,
): CommandLaunch {
  if (!wrap) return launch;
  const [executable, ...wrapArgs] = wrap;
  return { command: executable, args: [...wrapArgs, launch.command, ...launch.args] };
}
