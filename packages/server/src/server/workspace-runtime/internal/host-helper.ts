import { buildSelfNodeCommand } from "../../paseo-env.js";
import { workspaceHelperExecutable } from "@getpaseo/workspace-helper";

const launch = buildSelfNodeCommand([workspaceHelperExecutable]);

export const hostWorkspaceHelper = {
  command: [launch.command, ...launch.args] as readonly [string, ...string[]],
  env: launch.env,
};
