import AsyncStorage from "@react-native-async-storage/async-storage";
import { beforeEach, describe, expect, it } from "vitest";
import { toggleProjectPinKey, useSidebarProjectPinsStore } from "./sidebar-project-pins-store";

describe("toggleProjectPinKey", () => {
  it("adds and removes a project key", () => {
    expect(toggleProjectPinKey([], "project-a")).toEqual(["project-a"]);
    expect(toggleProjectPinKey(["project-a", "project-b"], "project-a")).toEqual(["project-b"]);
  });

  it("ignores blank keys and preserves a trailing-space key", () => {
    expect(toggleProjectPinKey(["project-a"], "  ")).toEqual(["project-a"]);
    expect(toggleProjectPinKey([], "project-a ")).toEqual(["project-a "]);
  });
});

describe("sidebar project pins store", () => {
  beforeEach(async () => {
    await AsyncStorage.removeItem("sidebar-project-pins");
    useSidebarProjectPinsStore.setState({ pinnedProjectKeys: [] });
  });

  it("round-trips a project pin through the store state", () => {
    useSidebarProjectPinsStore.getState().toggleProjectPinned("project-a");
    expect(useSidebarProjectPinsStore.getState().pinnedProjectKeys).toEqual(["project-a"]);

    useSidebarProjectPinsStore.getState().toggleProjectPinned("project-a");
    expect(useSidebarProjectPinsStore.getState().pinnedProjectKeys).toEqual([]);
  });

  it("accepts the persisted empty and populated shapes", async () => {
    await AsyncStorage.setItem("sidebar-project-pins", JSON.stringify({ state: {}, version: 1 }));
    await useSidebarProjectPinsStore.persist.rehydrate();
    expect(useSidebarProjectPinsStore.getState().pinnedProjectKeys).toEqual([]);
    expect(await AsyncStorage.getItem("sidebar-project-pins")).not.toBeNull();

    await AsyncStorage.setItem(
      "sidebar-project-pins",
      JSON.stringify({ state: { pinnedProjectKeys: ["project-a"] }, version: 1 }),
    );
    await useSidebarProjectPinsStore.persist.rehydrate();
    expect(useSidebarProjectPinsStore.getState().pinnedProjectKeys).toEqual(["project-a"]);
  });
});
