import { describe, expect, it } from "vitest";
import {
  createOnboardingModel,
  type OnboardingCompletionStorage,
  type OnboardingSetupHost,
} from "./model";

class MemoryCompletionStorage implements OnboardingCompletionStorage {
  completed: boolean;

  constructor(completed = false) {
    this.completed = completed;
  }

  async isCompleted(): Promise<boolean> {
    return this.completed;
  }

  async markCompleted(): Promise<void> {
    this.completed = true;
  }
}

const FRESH_HOST: OnboardingSetupHost = {
  serverId: "local",
  isConnected: true,
  hasHydratedWorkspaces: true,
  hasProjects: false,
};

async function openModel(storage = new MemoryCompletionStorage()) {
  const model = createOnboardingModel({ storage });
  await model.ready;
  return model;
}

describe("onboarding model", () => {
  it("opens on the appearance step for a connected host with no projects", async () => {
    const model = await openModel();

    model.applySetupHost(FRESH_HOST, { includePhoneStep: true });

    expect(model.getState()).toEqual({
      status: "open",
      serverId: "local",
      steps: ["appearance", "providers", "projects", "orchestration", "phone"],
      stepIndex: 0,
    });
  });

  it("waits until the host is connected and its workspaces are hydrated", async () => {
    const model = await openModel();

    model.applySetupHost(null, { includePhoneStep: true });
    model.applySetupHost({ ...FRESH_HOST, isConnected: false }, { includePhoneStep: true });
    model.applySetupHost(
      { ...FRESH_HOST, hasHydratedWorkspaces: false },
      { includePhoneStep: true },
    );
    expect(model.getState()).toEqual({ status: "deciding" });

    model.applySetupHost(FRESH_HOST, { includePhoneStep: true });
    expect(model.getState().status).toBe("open");
  });

  it("stays hidden for a host that already has projects, even after they are removed", async () => {
    const model = await openModel();

    model.applySetupHost({ ...FRESH_HOST, hasProjects: true }, { includePhoneStep: true });
    model.applySetupHost(FRESH_HOST, { includePhoneStep: true });

    expect(model.getState()).toEqual({ status: "hidden" });
  });

  it("stays hidden once setup was completed on this client", async () => {
    const model = await openModel(new MemoryCompletionStorage(true));

    model.applySetupHost(FRESH_HOST, { includePhoneStep: true });

    expect(model.getState()).toEqual({ status: "hidden" });
  });

  it("decides only after the completion record has loaded", async () => {
    const model = createOnboardingModel({ storage: new MemoryCompletionStorage(true) });

    model.applySetupHost(FRESH_HOST, { includePhoneStep: true });
    expect(model.getState()).toEqual({ status: "deciding" });

    await model.ready;
    expect(model.getState()).toEqual({ status: "hidden" });
  });

  it("keeps the modal open when the host gains its first project during setup", async () => {
    const model = await openModel();
    model.applySetupHost(FRESH_HOST, { includePhoneStep: true });
    model.next("appearance");
    model.next("providers");

    model.applySetupHost({ ...FRESH_HOST, hasProjects: true }, { includePhoneStep: true });

    expect(model.getState()).toMatchObject({ status: "open", stepIndex: 2 });
  });

  it("omits the phone step when the client is a phone", async () => {
    const model = await openModel();

    model.applySetupHost(FRESH_HOST, { includePhoneStep: false });

    expect(model.getState()).toMatchObject({
      steps: ["appearance", "providers", "projects", "orchestration"],
    });
  });

  it("moves between steps without leaving the step list", async () => {
    const model = await openModel();
    model.applySetupHost(FRESH_HOST, { includePhoneStep: false });

    model.back();
    expect(model.getState()).toMatchObject({ stepIndex: 0 });
    model.next("appearance");
    model.next("providers");
    model.next("projects");
    model.next("orchestration");
    expect(model.getState()).toMatchObject({ stepIndex: 3 });
    model.goTo("providers");
    expect(model.getState()).toMatchObject({ stepIndex: 1 });
    model.back();
    expect(model.getState()).toMatchObject({ stepIndex: 0 });
  });

  it("ignores a late advance from a step the user already left", async () => {
    const model = await openModel(new MemoryCompletionStorage(true));
    model.reopen("local", { includePhoneStep: true });
    model.goTo("projects");

    // Projects are still being added when the user picks Appearance in the step rail.
    model.goTo("appearance");
    model.next("projects");
    expect(model.getState()).toMatchObject({ stepIndex: 0 });

    // Or closes setup and opens it again before the add finishes.
    await model.complete();
    model.reopen("local", { includePhoneStep: true });
    model.next("projects");
    expect(model.getState()).toMatchObject({ status: "open", stepIndex: 0 });
  });

  it("records completion when setup closes, so it does not open again", async () => {
    const storage = new MemoryCompletionStorage();
    const model = await openModel(storage);
    model.applySetupHost(FRESH_HOST, { includePhoneStep: true });

    await model.complete();

    expect(model.getState()).toEqual({ status: "hidden" });
    expect(storage.completed).toBe(true);
    const relaunched = await openModel(storage);
    relaunched.applySetupHost(FRESH_HOST, { includePhoneStep: true });
    expect(relaunched.getState()).toEqual({ status: "hidden" });
  });

  it("reopens on the first step for an existing user", async () => {
    const model = await openModel(new MemoryCompletionStorage(true));
    model.applySetupHost({ ...FRESH_HOST, hasProjects: true }, { includePhoneStep: true });

    model.reopen("local", { includePhoneStep: true });

    expect(model.getState()).toMatchObject({ status: "open", serverId: "local", stepIndex: 0 });
  });

  it("notifies subscribers on every state change", async () => {
    const model = await openModel();
    const seen: string[] = [];
    model.subscribe(() => {
      const state = model.getState();
      seen.push(state.status === "open" ? `open:${state.stepIndex}` : state.status);
    });

    model.applySetupHost(FRESH_HOST, { includePhoneStep: true });
    model.next("appearance");
    await model.complete();

    expect(seen).toEqual(["open:0", "open:1", "hidden"]);
  });
});
