import type { BoundWorkspaceRuntime } from "../../index.js";
import type { WorkspaceRuntimeDriver } from "../../drivers/index.js";
import type { WorkspaceFilesSubscription } from "@getpaseo/workspace-helper";
import { registerGitCommonObservationCapability } from "./capability.js";

interface GitObservation {
  workspaceId: string;
  runtime: BoundWorkspaceRuntime;
  driver: WorkspaceRuntimeDriver;
  listener: () => void;
  physical: { unsubscribe(): Promise<void> } | null;
}

type PhysicalGitObservation = NonNullable<GitObservation["physical"]>;

export interface ObservationRebindTransaction {
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

export interface GitCommonObservationCoordinator {
  bind(runtime: BoundWorkspaceRuntime, workspaceId: string, driver: WorkspaceRuntimeDriver): void;
  close(): Promise<void>;
  pause(workspaceId: string): Promise<void>;
  stageResume(workspaceId: string): Promise<ObservationRebindTransaction>;
  destroy(workspaceId: string): Promise<void>;
}

/** Git invalidation is workspace-bound. Runtime-private observers never disclose placement. */
export function createGitCommonObservationCoordinator(): GitCommonObservationCoordinator {
  const observations = new Set<GitObservation>();
  const acquisitions = new Set<Promise<PhysicalGitObservation>>();
  const resumeStages = new Set<Map<GitObservation, PhysicalGitObservation>>();
  let closePromise: Promise<void> | null = null;
  let closed = false;

  return {
    bind(runtime, workspaceId, driver) {
      assertOpen();
      registerGitCommonObservationCapability(runtime, {
        observe: async (listener) => {
          assertOpen();
          const observation: GitObservation = {
            workspaceId,
            runtime,
            driver,
            listener,
            physical: null,
          };
          observation.physical = await acquire(observation);
          observations.add(observation);
          let active = true;
          return {
            async unsubscribe() {
              if (!active) return;
              active = false;
              observations.delete(observation);
              await stop(observation);
            },
          };
        },
      });
    },
    close() {
      if (closePromise) return closePromise;
      closed = true;
      closePromise = (async () => {
        await Promise.allSettled(acquisitions);
        await Promise.allSettled([...resumeStages].map((stage) => disposeStage(stage)));
        const selected = [...observations];
        observations.clear();
        await Promise.allSettled(selected.map((observation) => stop(observation)));
      })();
      return closePromise;
    },
    async pause(workspaceId) {
      for (const observation of owned(workspaceId)) {
        await stop(observation);
      }
    },
    async stageResume(workspaceId) {
      assertOpen();
      const staged = new Map<GitObservation, PhysicalGitObservation>();
      resumeStages.add(staged);
      try {
        for (const observation of owned(workspaceId)) {
          if (!observation.physical) staged.set(observation, await acquire(observation));
        }
      } catch (error) {
        await disposeStage(staged);
        throw error;
      }
      let finished = false;
      return {
        async commit() {
          if (finished) return;
          if (closed) {
            finished = true;
            await disposeStage(staged);
            throw new Error("Git common observation coordinator is closed");
          }
          finished = true;
          resumeStages.delete(staged);
          for (const [observation, physical] of staged) observation.physical = physical;
          staged.clear();
        },
        async rollback() {
          if (finished) return;
          finished = true;
          await disposeStage(staged);
        },
      };
    },
    async destroy(workspaceId) {
      const selected = owned(workspaceId);
      for (const observation of selected) observations.delete(observation);
      await Promise.allSettled(selected.map((observation) => stop(observation)));
    },
  };

  function owned(workspaceId: string): GitObservation[] {
    return [...observations].filter((observation) => observation.workspaceId === workspaceId);
  }

  function assertOpen(): void {
    if (closed) throw new Error("Git common observation coordinator is closed");
  }

  function acquire(observation: GitObservation): Promise<PhysicalGitObservation> {
    assertOpen();
    const acquisition = (async () => {
      const physical = await start(observation);
      if (closed) {
        await physical.unsubscribe();
        throw new Error("Git common observation coordinator is closed");
      }
      return physical;
    })();
    acquisitions.add(acquisition);
    void acquisition.then(
      () => acquisitions.delete(acquisition),
      () => acquisitions.delete(acquisition),
    );
    return acquisition;
  }

  async function stop(observation: GitObservation): Promise<void> {
    const physical = observation.physical;
    observation.physical = null;
    await physical?.unsubscribe();
  }

  async function disposeStage(stage: Map<GitObservation, PhysicalGitObservation>): Promise<void> {
    resumeStages.delete(stage);
    const physical = [...stage.values()];
    stage.clear();
    await Promise.allSettled(physical.map((item) => item.unsubscribe()));
  }

  async function start(observation: GitObservation): Promise<PhysicalGitObservation> {
    if (observation.driver.observeGit) {
      return observation.driver.observeGit(observation.workspaceId, observation.listener);
    }
    const ignoredPaths = await readGitIgnoredPaths(observation.runtime);
    const subscription: WorkspaceFilesSubscription = await observation.runtime.files.subscribe(
      { paths: ["."], recursive: true, ignoredPaths },
      (event) => {
        if (event.type !== "error") observation.listener();
      },
    );
    return subscription;
  }
}

async function readGitIgnoredPaths(runtime: BoundWorkspaceRuntime): Promise<string[]> {
  const git = await runtime.resolveCommand("git");
  if (!git) return [];
  const process = await runtime.run({
    argv: [git, "ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"],
    env: { GIT_OPTIONAL_LOCKS: "0" },
    purpose: { kind: "git" },
  });
  process.stdin.end();
  const [stdout, , exit] = await Promise.all([
    collect(process.stdout),
    collect(process.stderr),
    process.exited,
  ]);
  if (exit.code !== 0 || exit.signal !== null) return [];
  return [
    ...new Set(
      stdout
        .split("\0")
        .map((entry) => entry.replace(/\/+$/, ""))
        .filter(Boolean),
    ),
  ];
}

async function collect(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}
