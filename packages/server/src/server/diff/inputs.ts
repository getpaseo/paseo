import { createHash } from "node:crypto";
import { runGitCommand, type GitCommandOptions } from "../../utils/run-git-command.js";
import type { ListedFile } from "./git.js";

// Reuse depends on Git's interpretation, not just filesystem metadata. Ask Git
// for effective attributes/config and filtered blob identities without writing objects.
export async function readGitInputIdentities(
  files: ListedFile[],
  worktreeFiles: Set<string>,
  options: GitCommandOptions,
): Promise<Map<string, string>> {
  const paths = files
    .filter((file) => file.entry.content === "text")
    .map((file) => file.entry.path);
  if (!paths.length) return new Map();
  const regular = paths.filter((path) => worktreeFiles.has(path));
  const [config, attributes, blobs] = await Promise.all([
    runGitCommand(["config", "--null", "--list"], options),
    runGitCommand(["check-attr", "--all", "-z", "--stdin"], {
      ...options,
      input: paths.join("\0") + "\0",
    }),
    regular.length
      ? runGitCommand(["hash-object", "--stdin-paths"], {
          ...options,
          input: regular.map(quotePath).join("\n") + "\n",
        })
      : null,
  ]);
  if (config.truncated || attributes.truncated || blobs?.truncated)
    throw new Error("Git input identity exceeded the output budget");
  const byPath = new Map<string, string[]>();
  const fields = attributes.stdout.split("\0");
  if (fields.at(-1) === "") fields.pop();
  if (fields.length % 3) throw new Error("Git returned invalid attributes");
  for (let index = 0; index < fields.length; index += 3) {
    const values = byPath.get(fields[index]) ?? [];
    values.push(JSON.stringify([fields[index + 1], fields[index + 2]]));
    byPath.set(fields[index], values);
  }
  const hashes = blobs?.stdout.trim().split(/\r?\n/) ?? [];
  if (hashes.length !== regular.length) throw new Error("Git returned incomplete blob identities");
  const blobByPath = new Map(regular.map((path, index) => [path, hashes[index]]));
  const configIdentity = createHash("sha256").update(config.stdout).digest("hex");
  return new Map(
    paths.map((path) => [
      path,
      createHash("sha256")
        .update(
          JSON.stringify([
            configIdentity,
            byPath.get(path)?.sort() ?? [],
            blobByPath.get(path) ?? null,
          ]),
        )
        .digest("hex"),
    ]),
  );
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
