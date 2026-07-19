import { describe, expect, it } from "vitest";
import type { MobilePanelView } from "@/stores/panel-store";
import {
  canBeginMobilePanelGesture,
  createMobilePanelMotionState,
  getMobilePanelFrame,
  isMobilePanelGestureCurrent,
  transitionMobilePanel,
  type MobilePanelCommit,
  type MobilePanelEvent,
  type MobilePanelMotionState,
} from "./model";

class MobilePanelsScenario {
  private nextRevision = 0;
  private startedRevision = -1;
  private state: MobilePanelMotionState;
  readonly commits: MobilePanelCommit[] = [];

  constructor(target: MobilePanelView = "agent") {
    this.state = createMobilePanelMotionState({ target, revision: this.nextRevision });
  }

  command(target: MobilePanelView) {
    this.nextRevision += 1;
    this.dispatch({ type: "command", selection: { target, revision: this.nextRevision } });
    return this;
  }

  beginGesture(origin: MobilePanelView) {
    this.dispatch({ type: "gesture.begin", origin });
    this.startedRevision = this.state.gesture?.startedRevision ?? -1;
    return this;
  }

  finishGesture(target: MobilePanelView) {
    this.dispatch({
      type: "gesture.finish",
      startedRevision: this.startedRevision,
      success: true,
      target,
    });
    return this;
  }

  cancelGesture() {
    this.dispatch({
      type: "gesture.finish",
      startedRevision: this.startedRevision,
      success: false,
      target: this.state.target,
    });
    return this;
  }

  finishAnimation(target: MobilePanelView, revision = this.state.revision) {
    this.dispatch({ type: "animation.finished", revision, target });
    return this;
  }

  snapshot() {
    return {
      motionTarget: this.state.motionTarget,
      revision: this.state.revision,
      settledTarget: this.state.settledTarget,
      target: this.state.target,
    };
  }

  private dispatch(event: MobilePanelEvent) {
    const transition = transitionMobilePanel(this.state, event);
    this.state = transition.state;
    if (transition.commit) {
      this.commits.push(transition.commit);
    }
  }
}

describe("mobile panel ownership", () => {
  it("follows programmatic commands through left, center, and right", () => {
    const panels = new MobilePanelsScenario();

    panels.command("agent-list").finishAnimation("agent-list");
    expect(panels.snapshot()).toEqual({
      target: "agent-list",
      motionTarget: "agent-list",
      settledTarget: "agent-list",
      revision: 1,
    });

    panels.command("agent").command("file-explorer").finishAnimation("file-explorer");
    expect(panels.snapshot()).toEqual({
      target: "file-explorer",
      motionTarget: "file-explorer",
      settledTarget: "file-explorer",
      revision: 3,
    });
  });

  it("turns a completed drag into one semantic commit", () => {
    const panels = new MobilePanelsScenario();

    panels.beginGesture("agent").finishGesture("agent-list");

    expect(panels.snapshot()).toEqual({
      target: "agent",
      motionTarget: "agent-list",
      settledTarget: "agent",
      revision: 0,
    });
    expect(panels.commits).toEqual([{ target: "agent-list", startedRevision: 0 }]);
  });

  it("returns a canceled drag to the latest canonical target", () => {
    const panels = new MobilePanelsScenario("agent-list");

    panels.beginGesture("agent-list").cancelGesture();

    expect(panels.snapshot()).toEqual({
      target: "agent-list",
      motionTarget: "agent-list",
      settledTarget: "agent-list",
      revision: 0,
    });
    expect(panels.commits).toEqual([]);
  });

  it("makes a command during a drag invalidate the stale gesture finish", () => {
    const panels = new MobilePanelsScenario();

    panels.beginGesture("agent").command("file-explorer").finishGesture("agent-list");

    expect(panels.snapshot()).toEqual({
      target: "file-explorer",
      motionTarget: "file-explorer",
      settledTarget: "agent",
      revision: 1,
    });
    expect(panels.commits).toEqual([]);
  });

  it("keeps the latest rapid command and rejects stale animation completion", () => {
    const panels = new MobilePanelsScenario();

    panels.command("agent-list");
    const staleRevision = panels.snapshot().revision;
    panels.command("agent").command("file-explorer");
    panels.finishAnimation("agent-list", staleRevision);

    expect(panels.snapshot()).toEqual({
      target: "file-explorer",
      motionTarget: "file-explorer",
      settledTarget: "agent",
      revision: 3,
    });
  });

  it("keeps an activated drag current while blocking a second drag", () => {
    const initial = createMobilePanelMotionState({ target: "agent", revision: 7 });
    const active = transitionMobilePanel(initial, {
      type: "gesture.begin",
      origin: "agent",
    }).state;

    expect(isMobilePanelGestureCurrent(active, 7)).toBe(true);
    expect(canBeginMobilePanelGesture(active, "agent", 0)).toBe(false);
  });

  it("derives both transforms and both backdrops from one normalized position", () => {
    expect(getMobilePanelFrame(0.25, 400)).toEqual({
      leftBackdropOpacity: 0,
      leftTranslateX: -400,
      rightBackdropOpacity: 0.25,
      rightTranslateX: 300,
    });
    expect(getMobilePanelFrame(0.25, 800)).toEqual({
      leftBackdropOpacity: 0,
      leftTranslateX: -800,
      rightBackdropOpacity: 0.25,
      rightTranslateX: 600,
    });
  });
});
