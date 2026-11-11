import { createHash } from "node:crypto";
import { runGitCommand, type GitCommandOptions } from "../../utils/run-git-command.js";

interface Interpretation {
  config: string;
  attributes: Map<string, string[]>;
  fingerprint: string;
}

// Reuse depends on Git's interpretation, not just filesystem metadata. Ask Git
// for effective attributes/config and filtered blob identities without writing objects.
export async function readGitInputs(
  paths: string[],
  worktreeFiles: Set<string>,
  options: GitCommandOptions,
) {
  const regular = paths.filter((path) => worktreeFiles.has(path));
  const [interpretation, blobs] = await Promise.all([
    readInterpretation(paths, options),
    regular.length
      ? runGitCommand(["hash-object", "--stdin-paths"], {
          ...options,
          input: regular.map(quotePath).join("\n") + "\n",
        })
      : null,
  ]);
  if (blobs?.truncated) throw new Error("Git input identity exceeded the output budget");
  const hashes = blobs?.stdout.trim().split(/\r?\n/) ?? [];
  if (hashes.length !== regular.length) throw new Error("Git returned incomplete blob identities");
  const blobByPath = new Map(regular.map((path, index) => [path, hashes[index]]));
  const identities = new Map(
    paths.map((path) => [
      path,
      fingerprint([
        interpretation.config,
        interpretation.attributes.get(path) ?? [],
        blobByPath.get(path) ?? null,
      ]),
    ]),
  );
  return {
    identities,
    hasInterpretationChanged: interpretationCheck(paths, options.cwd, interpretation.fingerprint),
  };
}

function interpretationCheck(
  paths: string[],
  cwd: string,
  baseline: string,
): () => Promise<boolean> {
  // Retain only the input description, never a comparison's patch/source pages.
  return async () => {
    const current = await readInterpretation(paths, {
      cwd,
      envOverlay: { GIT_OPTIONAL_LOCKS: "0" },
    });
    return current.fingerprint !== baseline;
  };
}

async function readInterpretation(
  paths: string[],
  options: GitCommandOptions,
): Promise<Interpretation> {
  if (!paths.length) return { config: "", attributes: new Map(), fingerprint: "" };
  const [config, result] = await Promise.all([
    runGitCommand(["config", "--null", "--list"], options),
    runGitCommand(["check-attr", "--all", "-z", "--stdin"], {
      ...options,
      input: paths.join("\0") + "\0",
    }),
  ]);
  if (config.truncated || result.truncated)
    throw new Error("Git input identity exceeded the output budget");
  const attributes = new Map<string, string[]>();
  const fields = result.stdout.split("\0");
  if (fields.at(-1) === "") fields.pop();
  if (fields.length % 3) throw new Error("Git returned invalid attributes");
  for (let index = 0; index < fields.length; index += 3) {
    const values = attributes.get(fields[index]) ?? [];
    values.push(JSON.stringify([fields[index + 1], fields[index + 2]]));
    attributes.set(fields[index], values);
  }
  for (const values of attributes.values()) values.sort();
  const configIdentity = createHash("sha256").update(config.stdout).digest("hex");
  return {
    config: configIdentity,
    attributes,
    fingerprint: fingerprint([
      configIdentity,
      paths.map((path) => [path, attributes.get(path) ?? []]),
    ]),
  };
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function quotePath(path: string): string {
  let quoted = '"';
  for (const byte of Buffer.from(path)) {
    quoted +=
      byte >= 32 && byte <= 126 && byte !== 34 && byte !== 92
        ? String.fromCharCode(byte)
        : `\\${byte.toString(8).padStart(3, "0")}`;
  }
  return quoted + '"';
}
