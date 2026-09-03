import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * The four lifecycles Paseo's on-disk files fall into. New and migrated call sites name the
 * category they want so the roots can diverge incrementally.
 */
export type PaseoPathCategory = "config" | "data" | "state" | "cache";

export type PaseoLayout = "flat" | "xdg";

export interface PaseoPaths {
  /**
   * Historical single root. Equal to every category under `flat`, and to `data` under `xdg`, so
   * a call site that has not been classified yet keeps landing somewhere sane.
   */
  home: string;
  config: string;
  data: string;
  state: string;
  cache: string;
  layout: PaseoLayout;
}

export const LEGACY_PASEO_HOME = "~/.paseo";
export const XDG_LAYOUT_MARKER = ".xdg-layout";

function expandHomeDir(input: string, homeDirectory: string): string {
  if (input.startsWith("~/")) {
    return path.join(homeDirectory, input.slice(2));
  }
  if (input === "~") {
    return homeDirectory;
  }
  return input;
}

function xdgRoot(
  env: NodeJS.ProcessEnv,
  variable: string,
  fallback: string,
  homeDirectory: string,
): string {
  const configured = env[variable]?.trim();
  const expanded = configured ? expandHomeDir(configured, homeDirectory) : null;
  const base =
    expanded && path.isAbsolute(expanded) ? expanded : path.join(homeDirectory, fallback);
  return path.join(path.resolve(base), "paseo");
}

function flatPaths(root: string): PaseoPaths {
  const resolved = path.resolve(root);
  return {
    home: resolved,
    config: resolved,
    data: resolved,
    state: resolved,
    cache: resolved,
    layout: "flat",
  };
}

/**
 * Resolution order, chosen so no existing install changes shape on upgrade:
 *
 * 1. `PASEO_HOME` set — the flat layout, rooted where the user asked. Unchanged from before.
 * 2. Not Linux — the flat layout. XDG is a Linux convention; macOS and Windows have their own,
 *    and choosing one for them is a separate decision from separating config out of the home
 *    directory. Nothing changes on those platforms.
 * 3. The XDG data directory contains Paseo's layout marker — the XDG layout. Once a fresh
 *    install has selected XDG, a later `~/.paseo` created by an older binary must not switch it
 *    back on restart.
 * 4. `~/.paseo` already exists — the flat layout. Every install that predates this code takes
 *    this branch and keeps its exact current directory layout until a migration is requested.
 * 5. Otherwise (a fresh Linux install, with no existing layout to honor) — the XDG layout.
 *
 * Resolving is free of side effects, so detection cannot be poisoned by a directory an earlier
 * call created: creating `~/.paseo` here would pin every later call to the flat layout.
 *
 * The answer is also decided once per installation and cached. Layout detection asks the
 * filesystem a question whose answer can change while the process runs — an older release or
 * another tool creating `~/.paseo` — and without the cache a daemon that started under XDG would
 * silently begin reading and writing `~/.paseo/config.json` while its data root stayed where it
 * was. The layout a process starts with is the layout it keeps.
 */
const resolvedPaths = new Map<string, PaseoPaths>();

export function resolvePaseoPaths(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  homeDirectory: string = os.homedir(),
): PaseoPaths {
  // The installation identity is stable for the process lifetime. XDG variables are deliberately
  // absent: changing one after startup must not move files out from under a running daemon.
  const key = JSON.stringify([platform, env.PASEO_HOME, homeDirectory]);
  const cached = resolvedPaths.get(key);
  if (cached) {
    return cached;
  }
  const paths = computePaseoPaths(env, platform, homeDirectory);
  resolvedPaths.set(key, paths);
  return paths;
}

function computePaseoPaths(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  homeDirectory: string,
): PaseoPaths {
  const configuredHome = env.PASEO_HOME;
  if (configuredHome !== undefined) {
    return flatPaths(expandHomeDir(configuredHome, homeDirectory));
  }

  const legacyHome = expandHomeDir(LEGACY_PASEO_HOME, homeDirectory);
  if (platform !== "linux") {
    return flatPaths(legacyHome);
  }

  const data = xdgRoot(env, "XDG_DATA_HOME", ".local/share", homeDirectory);
  if (existsSync(path.join(data, XDG_LAYOUT_MARKER))) {
    return xdgPaths(env, data, homeDirectory);
  }
  if (existsSync(legacyHome)) {
    return flatPaths(legacyHome);
  }

  // Only `config` diverges for now. `data`, `state` and `cache` are distinct categories at every
  // resolver but resolve to one root, so no file moves before its call sites are classified.
  // Pointing them at their own XDG roots later requires classifying those call sites and a
  // migration for the files that move.
  return xdgPaths(env, data, homeDirectory);
}

function xdgPaths(env: NodeJS.ProcessEnv, data: string, homeDirectory: string): PaseoPaths {
  return {
    home: data,
    config: xdgRoot(env, "XDG_CONFIG_HOME", ".config", homeDirectory),
    data,
    state: data,
    cache: data,
    layout: "xdg",
  };
}

export function resolvePaseoPath(
  category: PaseoPathCategory,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return resolvePaseoPaths(env)[category];
}
