import { exec } from "node:child_process";
import { promisify } from "node:util";
import { hasEnvReference, substituteEnvReferences } from "./env-references.js";

const execAsync = promisify(exec);
const CREDENTIAL_COMMAND_TIMEOUT_MS = 30_000;

// Resolution of a *self-supplied* OAuth refresh token expression — a literal, an env
// reference (`$VAR` / `${VAR}`), or a `!command` that prints the token. This is an
// advanced/manual escape hatch for users who already hold their own refresh token;
// the normal product path writes a Paseo-owned credential store (see oauth-store.ts).
//
// This module deliberately does NOT read any other tool's auth files and imports no
// Pi runtime code. Token values are never logged.

/**
 * Resolve a refresh-token expression to its literal value (may run a `!command`).
 * Returns undefined when it can't be resolved.
 */
export function resolveRefreshTokenExpression(
  value: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
  if (value.startsWith("!")) {
    const command = value.slice(1).trim();
    if (!command) {
      return Promise.resolve(undefined);
    }

    return execAsync(command, {
      encoding: "utf8",
      env,
      timeout: CREDENTIAL_COMMAND_TIMEOUT_MS,
    })
      .then(({ stdout }) => {
        const output = stdout.trim();
        return output.length > 0 ? output : undefined;
      })
      .catch(() => undefined);
  }

  return Promise.resolve(resolveStaticRefreshTokenExpression(value, env));
}

function resolveStaticRefreshTokenExpression(
  value: string,
  env: NodeJS.ProcessEnv,
): string | undefined {
  if (hasEnvReference(value)) {
    const output = substituteEnvReferences(value, env);
    if (output) {
      return output.length > 0 ? output : undefined;
    }
    return undefined;
  }

  return value.length > 0 ? value : undefined;
}

/**
 * Cheap check: could this refresh-token expression yield a value without running a
 * command? `!command` is assumed runnable; env refs require their vars to be set.
 */
export function isRefreshTokenExpressionConfigured(
  value: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (value.startsWith("!")) {
    return true;
  }
  if (hasEnvReference(value)) {
    return substituteEnvReferences(value, env) !== undefined;
  }
  return value.length > 0;
}
