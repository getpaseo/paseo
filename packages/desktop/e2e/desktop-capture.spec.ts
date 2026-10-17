import { randomUUID } from "node:crypto";
import { test, expect, type Page } from "../../app/e2e/support/fixtures";
import { installDesktopRuntime } from "./support/runtime";
import { getE2EDaemonPort, daemonWsRoutePattern } from "../../app/e2e/support/helpers/daemon-port";

async function voiceHarness(page: Page) {
  let audioReceived!: () => void;
  const audio = new Promise<void>((resolve) => {
    audioReceived = resolve;
  });
  await page.addInitScript(() => {
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
      configurable: true,
      value: async () => {
        const context = new AudioContext();
        const oscillator = context.createOscillator();
        const destination = context.createMediaStreamDestination();
        oscillator.connect(destination);
        oscillator.start();
        return destination.stream;
      },
    });
  });
  await page.routeWebSocket(daemonWsRoutePattern(), (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((raw) => {
      const envelope = JSON.parse(String(raw)) as {
        type?: string;
        message?: { type?: string; dictationId?: string; seq?: number };
      };
      const request = envelope.message;
      if (envelope.type === "session" && request?.dictationId) {
        const dictationId = request.dictationId;
        const send = (message: unknown) => ws.send(JSON.stringify({ type: "session", message }));
        if (request.type === "dictation_stream_start") {
          send({ type: "dictation_stream_ack", payload: { dictationId, ackSeq: -1 } });
          return;
        }
        if (request.type === "dictation_stream_chunk") {
          send({ type: "dictation_stream_ack", payload: { dictationId, ackSeq: request.seq } });
          audioReceived();
          return;
        }
        if (request.type === "dictation_stream_finish") {
          send({
            type: "dictation_stream_finish_accepted",
            payload: { dictationId, timeoutMs: 5000 },
          });
          send({
            type: "dictation_stream_final",
            payload: { dictationId, text: "Corrige le bouton Ajouter" },
          });
          return;
        }
        if (request.type === "dictation_stream_cancel") return;
      }
      server.send(raw);
    });
    server.onMessage((raw) => ws.send(raw));
  });
  return { audio };
}

for (const scenario of [
  {
    held: false,
    failFirst: true,
    title: "capture keeps annotations and creates one agent after retry",
  },
  {
    held: true,
    failFirst: true,
    title: "hold dictates while pressed and preserves a failed submission",
  },
  {
    held: true,
    failFirst: false,
    title: "release creates exactly one agent without an extra click",
  },
]) {
  const { held, failFirst } = scenario;
  test(scenario.title, async ({ page, e2eWorkerClient }, testInfo) => {
    const voice = held ? await voiceHarness(page) : null;
    const serverId = process.env.E2E_SERVER_ID!;
    await page.setViewportSize({ width: 720, height: 620 });
    await page.setContent(
      '<main style="padding:70px;font:24px system-ui;background:#f3f4f6;height:480px"><h1>Boutique</h1><p>Le bouton Ajouter reste inactif.</p><button style="padding:12px 28px;font:inherit">Ajouter</button></main>',
    );
    const png = (await page.screenshot()).toString("base64");
    const deviceId = randomUUID();
    const id = randomUUID();
    await installDesktopRuntime(page, {
      serverId,
      daemonListen: `127.0.0.1:${getE2EDaemonPort()}`,
    });
    await page.addInitScript(
      (fixture) => {
        // A fresh capture window must enroll the local daemon itself.
        localStorage.removeItem("@paseo:daemon-registry");
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
          gesture: fixture.held,
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
        const gestures = new Set<
          (value: { id: string; phase: "began" | "ended" | "cancelled" }) => void
        >();
        const updates = new Set<(value: typeof capture) => void>();
        Reflect.set(window, "captureHold", (phase: "began" | "ended" | "cancelled") => {
          for (const callback of gestures) callback({ id: capturedId, phase });
          if (phase === "ended") for (const callback of updates) callback(capture);
        });
        let attempts = 0;
        Object.assign(window, { captureOpens: 0 });
        window.paseoDesktop!.desktopCapture = {
          getDraft: async () => (fixture.held ? null : capture),
          onGesture: (callback) => {
            gestures.add(callback);
            return () => gestures.delete(callback);
          },
          present: async () => {},
          onUpdate: (callback) => {
            updates.add(callback);
            return () => updates.delete(callback);
          },
          device: async () => capturedDevice,
          ensurePara: async () => {
            if (++attempts === 1 && fixture.failFirst) throw new Error("Test: offline");
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
      { serverId, png, deviceId, id, held, failFirst, para: process.env.E2E_PASEO_HOME! },
    );
    await page.goto("/desktop-capture");
    const editor = page.getByRole("textbox", { name: "Votre demande" });
    const canvas = page.locator("canvas[aria-label='Entourez une zone']");
    if (held) {
      await expect(page.getByText("Prêt à capturer", { exact: true })).toBeVisible();
      // Allow the synthetic audio context, as Electron does for this background window.
      await page.locator("body").click({ position: { x: 1, y: 1 } });
      await page.waitForTimeout(500);
      await page.evaluate(() => Reflect.get(window, "captureHold")("began"));
      await voice!.audio;
      await expect(editor).toBeHidden();
      expect(
        (await e2eWorkerClient.fetchAgents({ scope: "active" })).entries.filter(
          ({ agent }) => agent.cwd === process.env.E2E_PASEO_HOME,
        ),
      ).toHaveLength(0);
      await page.evaluate(() => Reflect.get(window, "captureHold")("ended"));
    } else {
      await expect(editor).toBeVisible({ timeout: 60000 });
      await editor.fill("Corrige le bouton Ajouter");

      await expect(canvas).toBeVisible();
      const box = (await canvas.boundingBox())!;
      await page.mouse.move(box.x + 55, box.y + 110);
      await page.mouse.down();
      await page.mouse.move(box.x + 350, box.y + 250);
      await page.mouse.up();
      await page.screenshot({ path: testInfo.outputPath("capture-request.png") });
      await page.getByRole("button", { name: "Envoyer", exact: true }).click();
    }
    if (failFirst) {
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
    } else {
      await page.evaluate(() => Reflect.get(window, "captureHold")("ended"));
    }
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
}
