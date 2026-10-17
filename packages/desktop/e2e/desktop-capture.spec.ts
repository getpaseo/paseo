import { randomUUID } from "node:crypto";
import { test, expect } from "../../app/e2e/support/fixtures";
import { installDesktopRuntime } from "./support/runtime";
import { getE2EDaemonPort } from "../../app/e2e/support/helpers/daemon-port";

test("capture keeps annotations and creates one agent after retry", async ({
  page,
  e2eWorkerClient,
}, testInfo) => {
  const serverId = process.env.E2E_SERVER_ID!;
  await page.setViewportSize({ width: 720, height: 620 });
  await page.setContent(
    '<main style="padding:70px;font:24px system-ui;background:#f3f4f6;height:480px"><h1>Boutique</h1><p>Le bouton Ajouter reste inactif.</p><button style="padding:12px 28px;font:inherit">Ajouter</button></main>',
  );
  const png = (await page.screenshot()).toString("base64");
  const deviceId = randomUUID();
  const id = randomUUID();
  await installDesktopRuntime(page, { serverId, daemonListen: `127.0.0.1:${getE2EDaemonPort()}` });
  await page.addInitScript(
    (fixture) => {
      const {
        serverId: capturedServer,
        png: capturedPng,
        deviceId: capturedDevice,
        id: capturedId,
      } = fixture;
      const capture = {
        id: capturedId,
        deviceId: capturedDevice,
        serverId: capturedServer,
        png: capturedPng,
        width: 720,
        height: 620,
        context: { application: "Boutique" },
        ocr: "Ajouter",
        captureMs: 12,
      };
      const images = new Map<string, string>();
      const invoke = window.paseoDesktop!.invoke!;
      window.paseoDesktop!.invoke = async (command, args) => {
        if (command === "write_attachment_base64") {
          const file = `/fixture/${String(args?.attachmentId)}.png`;
          const base64 = String(args?.base64);
          images.set(file, base64);
          return { path: file, byteSize: atob(base64).length };
        }
        if (command === "read_file_base64") return images.get(String(args?.path));
        return invoke(command, args);
      };
      let attempts = 0;
      Object.assign(window, { captureOpens: 0 });
      window.paseoDesktop!.desktopCapture = {
        getDraft: async () => capture,
        onUpdate: () => () => {},
        device: async () => capturedDevice,
        ensurePara: async () => {
          if (++attempts === 1) throw new Error("Test: offline");
          return fixture.para;
        },
        cancel: async () => {},
        complete: async () => {},
        open: async () => {
          Reflect.set(window, "captureOpens", Number(Reflect.get(window, "captureOpens")) + 1);
        },
        execute: async () => {
          throw new Error("No system access in this UI fixture");
        },
        revoke: async () => {},
        onStop: () => () => {},
      };
    },
    { serverId, png, deviceId, id, para: process.env.E2E_PASEO_HOME! },
  );
  await page.goto("/desktop-capture");
  const editor = page.getByRole("textbox", { name: "Votre demande" });
  await expect(editor).toBeVisible({ timeout: 60000 });
  await editor.fill("Corrige le bouton Ajouter");
  const canvas = page.locator("canvas[aria-label='Entourez une zone']");
  await expect(canvas).toBeVisible();
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + 55, box.y + 110);
  await page.mouse.down();
  await page.mouse.move(box.x + 350, box.y + 250);
  await page.mouse.up();
  await page.screenshot({ path: testInfo.outputPath("capture-request.png") });
  await page.getByRole("button", { name: "Envoyer", exact: true }).click();
  await expect(page.getByRole("button", { name: "Réessayer", exact: true })).toBeVisible({
    timeout: 20000,
  });
  await expect(
    page.getByText("Envoi non confirmé. Réessayez pour retrouver la même demande."),
  ).toBeVisible();
  await expect(canvas).toBeVisible();
  await expect(editor).toHaveValue("Corrige le bouton Ajouter");
  await page.screenshot({ path: testInfo.outputPath("capture-retry.png") });
  await page.getByRole("button", { name: "Réessayer", exact: true }).dblclick();
  await expect(page.getByText("Agent créé", { exact: true })).toBeVisible({ timeout: 30000 });
  expect(await page.evaluate(() => Reflect.get(window, "captureOpens"))).toBe(0);
  const agents = await e2eWorkerClient.fetchAgents({ scope: "active" });
  expect(
    agents.entries.filter(({ agent }) => agent.cwd === process.env.E2E_PASEO_HOME),
  ).toHaveLength(1);
  await page.screenshot({ path: testInfo.outputPath("capture-created.png") });
  await page.getByRole("button", { name: "Ouvrir dans Paseo", exact: true }).click();
  expect(await page.evaluate(() => Reflect.get(window, "captureOpens"))).toBe(1);
  const workspace = (await e2eWorkerClient.fetchWorkspaces()).entries.find(
    (entry) => entry.workspaceDirectory === process.env.E2E_PASEO_HOME,
  );
  if (workspace) await e2eWorkerClient.removeProject(workspace.projectId);
});
