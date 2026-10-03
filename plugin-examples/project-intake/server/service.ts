import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile, stat, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { PluginHookContext } from "@getpaseo/plugin/server";
import type { Assessment, AssessmentInput, ProjectDecision } from "../shared/contracts";
import { AssessmentSchema } from "../shared/contracts";
import type { IntakePreferences } from "../shared/preferences";
import { assessPolicy, isGreeting, validateProjectName } from "../shared/policy";

const execute = promisify(execFile);
interface Target {
  cwd: string;
  projectId?: string;
}
interface RecordEntry {
  fingerprint: string;
  assessment: Assessment;
  target?: Target;
  initialized?: boolean;
  autoAfter?: number;
}

export class ProjectIntakeService {
  private operations = new Map<string, Promise<unknown>>();
  constructor(
    private readonly options: {
      directory: string;
      settings(): Promise<IntakePreferences>;
      decide(input: AssessmentInput, settings: IntakePreferences): Promise<ProjectDecision>;
      initialize?: (directory: string, name: string) => Promise<void>;
    },
  ) {}

  async assess(input: AssessmentInput): Promise<Assessment> {
    return this.serial(input.idempotencyKey, async () => {
      const settings = await this.options.settings();
      const fingerprint = createHash("sha256").update(JSON.stringify(input)).digest("hex");
      const previous = await this.read(input.idempotencyKey);
      if (previous) {
        if (previous.fingerprint === fingerprint) return previous.assessment;
        if (previous.target) throw new Error("The request changed. Start a fresh submission.");
      }
      if (!isAbsolute(input.cwd)) throw new Error("Select an absolute project directory.");
      const root = resolve(input.projectRootPath || input.cwd);
      const parentPath = (settings.enabled && settings.newProjectParent.trim()) || dirname(root);
      if (!isAbsolute(parentPath) || !(await stat(parentPath)).isDirectory())
        throw new Error("Choose an existing absolute parent directory in Project intake settings.");
      let decision: ProjectDecision | undefined;
      let unavailableReason: string | undefined;
      if (
        settings.enabled &&
        settings.useSystemOne &&
        !isGreeting(input.text) &&
        input.text.trim().length > 5
      ) {
        try {
          decision = await this.options.decide(input, settings);
        } catch {
          unavailableReason = "System One is unavailable or took longer than two seconds";
        }
      }
      const assessment = assessPolicy({
        text: input.text,
        currentName: input.projectName?.trim() || basename(root),
        parentPath,
        preferences: settings,
        decision,
        unavailableReason,
      });
      await this.write(input.idempotencyKey, {
        fingerprint,
        assessment,
        ...(assessment.timeout
          ? { autoAfter: Date.now() + assessment.timeout.seconds * 1000 }
          : {}),
      });
      return assessment;
    });
  }

  async resolve(
    input: {
      idempotencyKey: string;
      choiceId: "current" | "new";
      textValue?: string;
      automatic: boolean;
    },
    paseo: PluginHookContext["paseo"],
  ): Promise<Target | null> {
    return this.serial(input.idempotencyKey, async () => {
      const record = await this.read(input.idempotencyKey);
      if (!record) throw new Error("Project check expired. Submit the original request again.");
      if (!record.assessment.showDecision) throw new Error("This request has no project choice.");
      if (input.automatic) await this.validateAutomatic(record, input.choiceId);
      if (input.choiceId === "current") return null;
      const name = validateProjectName(input.textValue || record.assessment.proposedName);
      if (record.target && basename(record.target.cwd) !== name)
        throw new Error("A project has already been created for this request.");
      if (!record.target) {
        const created = await paseo.projects.createDirectory({
          parentPath: record.assessment.parentPath,
          name,
        });
        if (created.error || !created.directoryPath || !created.project)
          throw new Error(created.error || "The new project could not be registered.");
        const expected = join(record.assessment.parentPath, name);
        if (resolve(created.directoryPath) !== resolve(expected))
          throw new Error("The host returned a different project directory.");
        record.target = { cwd: created.directoryPath, projectId: created.project.projectId };
        await this.write(input.idempotencyKey, record);
      }
      if (!record.initialized) {
        await (this.options.initialize ?? initializeProject)(record.target.cwd, name);
        record.initialized = true;
        await this.write(input.idempotencyKey, record);
      }
      return record.target;
    });
  }

  private async read(key: string): Promise<RecordEntry | null> {
    try {
      const value = JSON.parse(await readFile(this.path(key), "utf8")) as RecordEntry;
      AssessmentSchema.parse(value.assessment);
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new Error("The saved project check could not be read.", { cause: error });
    }
  }

  private path(key: string): string {
    return join(this.options.directory, `${createHash("sha256").update(key).digest("hex")}.json`);
  }

  private async validateAutomatic(record: RecordEntry, choiceId: "current" | "new"): Promise<void> {
    if (record.assessment.timeout?.choiceId !== choiceId)
      throw new Error("Automatic project choice does not match the configured recommendation.");
    if (!record.autoAfter || Date.now() < record.autoAfter)
      throw new Error("The project choice timer has not finished.");
    const settings = await this.options.settings();
    if (!settings.enabled || settings.unansweredAction === "wait")
      throw new Error("Automatic project selection is now disabled.");
    if (settings.unansweredAction === "current" && choiceId !== "current")
      throw new Error("Automatic project selection now keeps the current project.");
  }

  private async write(key: string, record: RecordEntry): Promise<void> {
    await mkdir(this.options.directory, { recursive: true, mode: 0o700 });
    const destination = this.path(key);
    const temporary = `${destination}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(record), { mode: 0o600 });
      await rename(temporary, destination);
    } finally {
      await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
  }

  private async serial<T>(key: string, action: () => Promise<T>): Promise<T> {
    const previous = this.operations.get(key) ?? Promise.resolve();
    const pending = previous.catch(() => undefined).then(action);
    this.operations.set(key, pending);
    try {
      return await pending;
    } finally {
      if (this.operations.get(key) === pending) this.operations.delete(key);
    }
  }
}

async function initializeProject(directory: string, name: string): Promise<void> {
  const options = { cwd: directory, timeout: 10_000, maxBuffer: 64 * 1024 };
  await execute("git", ["init", "--initial-branch=main", directory], options);
  try {
    await execute("git", ["rev-parse", "--verify", "HEAD"], options);
    return;
  } catch {}
  try {
    await writeFile(
      join(directory, "README.md"),
      `# ${name}\n\nThis project was created for an independent product request in PandaOS.\n`,
      { flag: "wx" },
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  await execute("git", ["add", "--", "README.md"], options);
  await execute(
    "git",
    [
      "-c",
      "user.name=PandaOS",
      "-c",
      "user.email=pandaos@localhost",
      "commit",
      "-m",
      "Initialize project",
      "--",
      "README.md",
    ],
    options,
  );
}
