import { describe, expect, it } from "vitest";
import {
  canCloseLeftSidebarGesture,
  canCloseRightSidebarGesture,
  canOpenLeftSidebarGesture,
  canOpenRightSidebarGesture,
  getMobilePanelTransitionStart,
  getSidebarAnimationSyncPlan,
  getLeftSidebarAnimationTargets,
  getRightSidebarAnimationTargets,
  MOBILE_PANEL_STATE_AGENT,
  MOBILE_PANEL_STATE_AGENT_LIST_CLOSING,
  MOBILE_PANEL_STATE_AGENT_LIST_OPEN,
  MOBILE_PANEL_STATE_AGENT_LIST_OPENING,
  MOBILE_PANEL_STATE_FILE_EXPLORER_CLOSING,
  MOBILE_PANEL_STATE_FILE_EXPLORER_OPEN,
  MOBILE_PANEL_STATE_FILE_EXPLORER_OPENING,
  MOBILE_PANEL_TARGET_AGENT,
  MOBILE_PANEL_TARGET_AGENT_LIST,
  MOBILE_PANEL_TARGET_FILE_EXPLORER,
  shouldSettleMobilePanelTransition,
  shouldSyncSidebarAnimation,
} from "./sidebar-animation-state";

describe("sidebar-animation-state", () => {
  it("requests a sync when the open state changes", () => {
    expect(
      shouldSyncSidebarAnimation({
        previousIsOpen: false,
        nextIsOpen: true,
        previousWindowWidth: 390,
        nextWindowWidth: 390,
      }),
    ).toBe(true);
  });

  it("requests a sync when the viewport width changes", () => {
    expect(
      shouldSyncSidebarAnimation({
        previousIsOpen: false,
        nextIsOpen: false,
        previousWindowWidth: 390,
        nextWindowWidth: 430,
      }),
    ).toBe(true);
  });

  it("keeps left sidebar store transitions authoritative", () => {
    expect(
      getSidebarAnimationSyncPlan({
        previousIsOpen: true,
        nextIsOpen: false,
        previousMobileView: "agent-list",
        nextMobileView: "agent",
        previousWindowWidth: 390,
        nextWindowWidth: 390,
        ownedMobileView: "agent-list",
      }),
    ).toEqual({
      shouldSync: true,
      didOpen: false,
      didOpenStateChange: true,
      ownsMobileViewChange: true,
    });
  });

  it("keeps right sidebar store transitions authoritative", () => {
    expect(
      getSidebarAnimationSyncPlan({
        previousIsOpen: false,
        nextIsOpen: true,
        previousMobileView: "agent",
        nextMobileView: "file-explorer",
        previousWindowWidth: 390,
        nextWindowWidth: 390,
        ownedMobileView: "file-explorer",
      }),
    ).toEqual({
      shouldSync: true,
      didOpen: true,
      didOpenStateChange: true,
      ownsMobileViewChange: true,
    });
  });

  it("does not claim ownership for unrelated mobile view changes", () => {
    expect(
      getSidebarAnimationSyncPlan({
        previousIsOpen: false,
        nextIsOpen: false,
        previousMobileView: "file-explorer",
        nextMobileView: "agent",
        previousWindowWidth: 390,
        nextWindowWidth: 390,
        ownedMobileView: "agent-list",
      }),
    ).toEqual({
      shouldSync: true,
      didOpen: false,
      didOpenStateChange: false,
      ownsMobileViewChange: false,
    });
  });

  it("keeps a repeated left-sidebar close transition in the closing state", () => {
    const firstStart = getMobilePanelTransitionStart("agent", MOBILE_PANEL_STATE_AGENT_LIST_OPEN);
    expect(firstStart).toEqual({
      target: MOBILE_PANEL_TARGET_AGENT,
      state: MOBILE_PANEL_STATE_AGENT_LIST_CLOSING,
    });
    expect(getMobilePanelTransitionStart("agent", firstStart.state)).toEqual({
      target: MOBILE_PANEL_TARGET_AGENT,
      state: MOBILE_PANEL_STATE_AGENT_LIST_CLOSING,
    });
  });

  it("keeps a repeated right-sidebar close transition in the closing state", () => {
    const firstStart = getMobilePanelTransitionStart(
      "agent",
      MOBILE_PANEL_STATE_FILE_EXPLORER_OPEN,
    );
    expect(firstStart).toEqual({
      target: MOBILE_PANEL_TARGET_AGENT,
      state: MOBILE_PANEL_STATE_FILE_EXPLORER_CLOSING,
    });
    expect(getMobilePanelTransitionStart("agent", firstStart.state)).toEqual({
      target: MOBILE_PANEL_TARGET_AGENT,
      state: MOBILE_PANEL_STATE_FILE_EXPLORER_CLOSING,
    });
  });

  it("keeps the left sidebar fully off-screen when closed", () => {
    expect(getLeftSidebarAnimationTargets({ isOpen: false, windowWidth: 430 })).toEqual({
      translateX: -430,
      backdropOpacity: 0,
    });
  });

  it("keeps the right sidebar fully off-screen when closed", () => {
    expect(getRightSidebarAnimationTargets({ isOpen: false, windowWidth: 430 })).toEqual({
      translateX: 430,
      backdropOpacity: 0,
    });
  });

  it("allows the left open gesture only after the app is settled on the agent panel", () => {
    expect(canOpenLeftSidebarGesture(MOBILE_PANEL_STATE_AGENT, -430, 430)).toBe(true);
    expect(canOpenLeftSidebarGesture(MOBILE_PANEL_STATE_AGENT, -240, 430)).toBe(false);
    expect(canOpenLeftSidebarGesture(MOBILE_PANEL_STATE_AGENT_LIST_CLOSING, -430, 430)).toBe(false);
    expect(canOpenLeftSidebarGesture(MOBILE_PANEL_STATE_AGENT_LIST_OPENING, -430, 430)).toBe(false);
    expect(canOpenLeftSidebarGesture(MOBILE_PANEL_STATE_FILE_EXPLORER_OPEN, -430, 430)).toBe(false);
  });

  it("allows the left close gesture only while the left sidebar is settled open", () => {
    expect(canCloseLeftSidebarGesture(MOBILE_PANEL_STATE_AGENT_LIST_OPEN)).toBe(true);
    expect(canCloseLeftSidebarGesture(MOBILE_PANEL_STATE_AGENT_LIST_OPENING)).toBe(false);
    expect(canCloseLeftSidebarGesture(MOBILE_PANEL_STATE_AGENT_LIST_CLOSING)).toBe(false);
    expect(canCloseLeftSidebarGesture(MOBILE_PANEL_STATE_AGENT)).toBe(false);
  });

  it("allows the right open gesture only after the app is settled on the agent panel", () => {
    expect(canOpenRightSidebarGesture(MOBILE_PANEL_STATE_AGENT, 430, 430)).toBe(true);
    expect(canOpenRightSidebarGesture(MOBILE_PANEL_STATE_AGENT, 240, 430)).toBe(false);
    expect(canOpenRightSidebarGesture(MOBILE_PANEL_STATE_FILE_EXPLORER_CLOSING, 430, 430)).toBe(
      false,
    );
    expect(canOpenRightSidebarGesture(MOBILE_PANEL_STATE_FILE_EXPLORER_OPENING, 430, 430)).toBe(
      false,
    );
    expect(canOpenRightSidebarGesture(MOBILE_PANEL_STATE_AGENT_LIST_OPEN, 430, 430)).toBe(false);
  });

  it("allows the right close gesture only while the right sidebar is settled open", () => {
    expect(canCloseRightSidebarGesture(MOBILE_PANEL_STATE_FILE_EXPLORER_OPEN)).toBe(true);
    expect(canCloseRightSidebarGesture(MOBILE_PANEL_STATE_FILE_EXPLORER_OPENING)).toBe(false);
    expect(canCloseRightSidebarGesture(MOBILE_PANEL_STATE_FILE_EXPLORER_CLOSING)).toBe(false);
    expect(canCloseRightSidebarGesture(MOBILE_PANEL_STATE_AGENT)).toBe(false);
  });

  it("rejects stale settle callbacks from a panel that is no longer the destination", () => {
    expect(
      shouldSettleMobilePanelTransition(
        MOBILE_PANEL_TARGET_AGENT_LIST,
        MOBILE_PANEL_TARGET_AGENT_LIST,
      ),
    ).toBe(true);
    expect(
      shouldSettleMobilePanelTransition(MOBILE_PANEL_TARGET_AGENT_LIST, MOBILE_PANEL_TARGET_AGENT),
    ).toBe(false);
    expect(
      shouldSettleMobilePanelTransition(
        MOBILE_PANEL_TARGET_AGENT_LIST,
        MOBILE_PANEL_TARGET_FILE_EXPLORER,
      ),
    ).toBe(false);
  });
});
