import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { within } from "@testing-library/dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n as testI18n } from "@/i18n/i18next";
import { RemoteSshHostForm } from "./remote-ssh-host-form";

void testI18n;
// The browser cannot execute Android Keystore or the native picker. Keep those boundaries
// injectable here; the real form, editing primitives, and approval interaction run in Chromium.
const native = vi.hoisted(() => ({
  inspect: vi.fn(),
  stage: vi.fn(),
  commit: vi.fn(),
  discard: vi.fn(),
}));
const save = vi.hoisted(() => vi.fn());
const picker = vi.hoisted(() => vi.fn());
vi.mock("@/hosts/ssh/ssh-transport", () => ({
  supportsSshKeyImport: true,
  getSshKeyImportBridge: () => native,
}));
vi.mock("@/hosts/ssh/import-private-key", () => ({
  importPrivateKey: picker,
}));
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("React", React);
  native.inspect.mockReset().mockResolvedValue("SHA256:test-server");
  native.stage.mockReset().mockResolvedValue(undefined);
  native.commit.mockReset().mockResolvedValue(undefined);
  native.discard.mockReset().mockResolvedValue(undefined);
  picker.mockReset().mockResolvedValue({ name: "id_ed25519", text: "test-private-key" });
  save.mockReset().mockImplementation(async (input) => {
    await input.beforeSave();
    return { profile: { serverId: "srv_ssh" }, serverId: "srv_ssh", hostname: "server" };
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

/** Edit through the real uncontrolled input rather than assigning component state. */
function typeTarget(text: string) {
  const input = within(document.body).getByLabelText("SSH host") as HTMLInputElement;
  const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  if (!valueSetter) throw new Error("HTML input value setter is unavailable");
  act(() => {
    valueSetter.call(input, text);
    input.dispatchEvent(new InputEvent("input", { bubbles: true, data: text }));
  });
}
async function click(label: string) {
  await act(async () => within(document.body).getByRole("button", { name: label }).click());
}
function renderForm(visible: boolean, onSaved = vi.fn()) {
  const onClose = vi.fn(() => renderForm(false, onSaved));
  act(() =>
    root.render(
      <RemoteSshHostForm
        hosts={[]}
        probeAndUpsertRemoteSshConnection={save}
        visible={visible}
        onClose={onClose}
        onSaved={onSaved}
      />,
    ),
  );
}
function mount() {
  const onSaved = vi.fn();
  renderForm(true, onSaved);
  return onSaved;
}

describe("Android SSH key import form", () => {
  it("requires fingerprint approval before connecting and clears credentials after success", async () => {
    const onSaved = mount();
    typeTarget("ssh://deploy@example.com");
    await click("Import private key");
    await click("Connect");
    expect(within(document.body).getByTestId("ssh-server-fingerprint").textContent).toBe(
      "SHA256:test-server",
    );
    expect(save).toHaveBeenCalledTimes(0);
    await click("Trust and connect");
    expect(save).toHaveBeenCalledTimes(1);
    expect(native.commit).toHaveBeenCalledTimes(1);
    expect(onSaved).toHaveBeenCalledWith({
      profile: { serverId: "srv_ssh" },
      serverId: "srv_ssh",
      hostname: "server",
      isNewHost: true,
    });
    expect(within(document.body).queryByLabelText("SSH host")).toBeNull();
    mount();
    expect(
      within(document.body).getByRole("button", { name: "Import private key" }).textContent,
    ).toBe("Import private key");
    expect((within(document.body).getByLabelText("SSH host") as HTMLInputElement).value).toBe("");
  });
  it("shows import errors in the form and lets the user retry without losing the target", async () => {
    native.inspect.mockRejectedValueOnce(
      new Error("Unable to read the private key. Check its format and passphrase."),
    );
    mount();
    typeTarget("ssh://deploy@example.com");
    await click("Import private key");
    await click("Connect");
    expect(
      within(document.body).getByText(
        "Unable to connect over SSH. Unable to read the private key. Check its format and passphrase.",
      ).textContent,
    ).toBe(
      "Unable to connect over SSH. Unable to read the private key. Check its format and passphrase.",
    );
    expect((within(document.body).getByLabelText("SSH host") as HTMLInputElement).value).toBe(
      "ssh://deploy@example.com",
    );
    await click("Connect");
    expect(within(document.body).getByTestId("ssh-server-fingerprint").textContent).toBe(
      "SHA256:test-server",
    );
  });
  it("requires fingerprint approval again when the destination changes", async () => {
    mount();
    typeTarget("ssh://deploy@example.com");
    await click("Import private key");
    await click("Connect");
    typeTarget("ssh://deploy@other.example.com");
    expect(within(document.body).queryByTestId("ssh-server-fingerprint")).toBeNull();
    await click("Connect");
    expect(native.inspect).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenCalledTimes(0);
  });
  it("accepts dismissal while fingerprint inspection is pending and reopens with fresh inputs", async () => {
    let finishInspection: (fingerprint: string) => void = () => {};
    native.inspect.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          finishInspection = resolve;
        }),
    );
    mount();
    typeTarget("ssh://deploy@example.com");
    await click("Import private key");
    act(() => within(document.body).getByRole("button", { name: "Connect" }).click());
    await click("Cancel");
    expect(within(document.body).queryByLabelText("SSH host")).toBeNull();
    mount();
    await act(async () => finishInspection("SHA256:stale"));
    expect(within(document.body).queryByTestId("ssh-server-fingerprint")).toBeNull();
    expect((within(document.body).getByLabelText("SSH host") as HTMLInputElement).value).toBe("");
    expect(save).not.toHaveBeenCalled();
  });
  it("ignores a picker result after the parent hides the form", async () => {
    let finishPicker: (key: { name: string; text: string }) => void = () => {};
    picker.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishPicker = resolve;
        }),
    );
    mount();
    act(() => within(document.body).getByRole("button", { name: "Import private key" }).click());
    renderForm(false);
    mount();
    await act(async () => finishPicker({ name: "stale-key", text: "private-key" }));
    expect(
      within(document.body).getByRole("button", { name: "Import private key" }).textContent,
    ).toBe("Import private key");
  });
  it("discards credentials staged after dismissal without starting a host probe", async () => {
    let finishStage: () => void = () => {};
    native.stage.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishStage = resolve;
        }),
    );
    mount();
    typeTarget("ssh://deploy@example.com");
    await click("Import private key");
    await click("Connect");
    act(() => within(document.body).getByRole("button", { name: "Trust and connect" }).click());
    await click("Cancel");
    await act(async () => finishStage());
    expect(save).not.toHaveBeenCalled();
    expect(native.commit).not.toHaveBeenCalled();
    expect(native.discard).toHaveBeenCalledTimes(1);
  });
  it("rejects a late successful probe before committing credentials or publishing a host", async () => {
    let finishProbe: () => void = () => {};
    save.mockImplementationOnce(async (input) => {
      await new Promise<void>((resolve) => {
        finishProbe = resolve;
      });
      await input.beforeSave();
      return { profile: { serverId: "srv_ssh" }, serverId: "srv_ssh", hostname: "server" };
    });
    const onSaved = mount();
    typeTarget("ssh://deploy@example.com");
    await click("Import private key");
    await click("Connect");
    act(() => within(document.body).getByRole("button", { name: "Trust and connect" }).click());
    await act(async () => {});
    await click("Cancel");
    await act(async () => finishProbe());
    expect(native.commit).not.toHaveBeenCalled();
    expect(native.discard).toHaveBeenCalledTimes(1);
    expect(onSaved).not.toHaveBeenCalled();
  });
  it("serializes imports when a cancelled form is reopened for the same destination", async () => {
    let finishOldProbe: () => void = () => {};
    save.mockImplementationOnce(async (input) => {
      await new Promise<void>((resolve) => {
        finishOldProbe = resolve;
      });
      await input.beforeSave();
      return { profile: { serverId: "srv_ssh" }, serverId: "srv_ssh", hostname: "server" };
    });
    const oldSaved = mount();
    typeTarget("ssh://deploy@example.com");
    await click("Import private key");
    await click("Connect");
    act(() => within(document.body).getByRole("button", { name: "Trust and connect" }).click());
    await act(async () => {});
    await click("Cancel");

    const newSaved = mount();
    typeTarget("ssh://deploy@example.com");
    await click("Import private key");
    await click("Connect");
    act(() => within(document.body).getByRole("button", { name: "Trust and connect" }).click());
    await act(async () => {});
    expect(native.stage).toHaveBeenCalledTimes(1);
    await act(async () => finishOldProbe());
    expect(native.stage).toHaveBeenCalledTimes(2);
    expect(native.discard).toHaveBeenCalledTimes(2);
    expect(native.commit).toHaveBeenCalledTimes(1);
    expect(oldSaved).not.toHaveBeenCalled();
    expect(newSaved).toHaveBeenCalledTimes(1);
  });
  it("finishes publishing the host if dismissed after durable commit has begun", async () => {
    let finishCommit: () => void = () => {};
    native.commit.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishCommit = resolve;
        }),
    );
    const published = vi.fn();
    save.mockImplementationOnce(async (input) => {
      await input.beforeSave();
      published();
      return { profile: { serverId: "srv_ssh" }, serverId: "srv_ssh", hostname: "server" };
    });
    const onSaved = mount();
    typeTarget("ssh://deploy@example.com");
    await click("Import private key");
    await click("Connect");
    act(() => within(document.body).getByRole("button", { name: "Trust and connect" }).click());
    await act(async () => {});
    expect(native.commit).toHaveBeenCalledTimes(1);
    await click("Cancel");
    await act(async () => finishCommit());
    expect(published).toHaveBeenCalledTimes(1);
    expect(native.discard).toHaveBeenCalledTimes(1);
    expect(onSaved).not.toHaveBeenCalled();
  });
});
