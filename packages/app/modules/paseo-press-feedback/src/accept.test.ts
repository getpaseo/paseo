import { expect, it } from "vitest";
import { acceptWorkspaceRowPress } from "./accept";

it("acknowledges an accepted row before navigation starts", () => {
  const visible: string[] = [];
  expect(
    acceptWorkspaceRowPress({
      cancelled: false,
      isAvailable: () => true,
      acknowledge: () => visible.push("row"),
      navigate: () => visible.push("workspace"),
    }),
  ).toBe(true);
  expect(visible).toEqual(["row", "workspace"]);
});

it("does not acknowledge or navigate after scrolling or a long press claims the touch", () => {
  const visible: string[] = [];
  expect(
    acceptWorkspaceRowPress({
      cancelled: true,
      isAvailable: () => true,
      acknowledge: () => visible.push("row"),
      navigate: () => visible.push("workspace"),
    }),
  ).toBe(false);
  expect(visible).toEqual([]);
});

it("accepts only the first row while its selection closes the sidebar", () => {
  const visible: string[] = [];
  let sidebarOpen = true;
  const press = (row: string) =>
    acceptWorkspaceRowPress({
      cancelled: false,
      isAvailable: () => sidebarOpen,
      acknowledge: () => visible.push(row),
      navigate: () => {
        sidebarOpen = false;
        visible.push(`workspace ${row}`);
      },
    });
  expect(press("B")).toBe(true);
  expect(press("C")).toBe(false);
  expect(visible).toEqual(["B", "workspace B"]);
});
