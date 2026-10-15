import { useEffect } from "react";
import { getDesktopHost } from "./host";
import { hasLocalUpdateBlockers } from "./use-local-update-blocker";
import { flushDraftPersistStorage } from "@/stores/draft-store";

export function useLocalUpdate(): void {
  useEffect(() => {
    const bridge = getDesktopHost()?.localUpdate;
    const id = process.env.EXPO_PUBLIC_PASEO_BUILD_ID;
    if (!bridge?.buildId || !id) return;
    const banner = document.createElement("div");
    banner.setAttribute("role", "status");
    banner.dataset.testid = "local-update-banner";
    Object.assign(banner.style, {
      display: "flex",
      alignItems: "center",
      boxSizing: "border-box",
      position: "fixed",
      bottom: "16px",
      left: "50%",
      transform: "translateX(-50%)",
      zIndex: "2147483647",
      background: "#383534",
      color: "#f9f7f4",
      padding: "12px 16px",
      borderRadius: "10px",
      font: "13px system-ui",
      maxWidth: "90vw",
      width: "max-content",
    });
    const dismissed = new Set<string>();
    let noticeKey = "";
    const close = document.createElement("button");
    close.type = "button";
    close.textContent = "×";
    close.setAttribute("aria-label", "Fermer la notification");
    close.title = "Fermer la notification";
    Object.assign(close.style, {
      marginLeft: "12px",
      padding: "0 6px",
      border: "0",
      background: "transparent",
      color: "inherit",
      font: "20px system-ui",
      cursor: "pointer",
      flexShrink: "0",
    });
    close.addEventListener("click", () => {
      dismissed.add(noticeKey);
      banner.remove();
    });
    const label = document.createElement("span");
    const button = document.createElement("button");
    button.textContent = "Reporter 30 min";
    Object.assign(button.style, { marginLeft: "12px", cursor: "pointer", flexShrink: "0" });
    button.addEventListener("click", () => {
      void bridge.postpone();
    });
    banner.append(label, button, close);
    const offStatus = bridge.onStatus((value) => {
      if (!value || typeof value !== "object") return;
      const state = value as {
        phase: string;
        installed?: string;
        postponedUntil?: number;
        deadline?: number;
        error?: string;
        publicationWarning?: string;
      };
      noticeKey = JSON.stringify([
        state.installed,
        state.phase,
        state.error,
        state.publicationWarning,
      ]);
      if (
        dismissed.has(noticeKey) ||
        (state.phase === "ready" && Date.now() < (state.postponedUntil ?? 0))
      ) {
        banner.remove();
        return;
      }
      if (state.phase === "current" && !state.publicationWarning) {
        banner.remove();
        return;
      }
      label.textContent = state.publicationWarning ?? "Mise à jour prête — activation au repos";
      if (state.phase === "error") label.textContent = state.error ?? "Mise à jour non activée";
      if (state.phase === "countdown")
        label.textContent = `Mise à jour de l’interface dans ${Math.max(0, Math.ceil(((state.deadline ?? 0) - Date.now()) / 1000))} s`;
      if (state.phase === "activating") label.textContent = "Sauvegarde avant mise à jour…";
      button.hidden =
        state.phase === "current" || state.phase === "error" || state.phase === "activating";
      if (!banner.isConnected) document.body.append(banner);
    });
    let lastActivity = 0;
    const activity = () => {
      if (Date.now() - lastActivity < 250) return;
      lastActivity = Date.now();
      void bridge.activity();
    };
    const events = ["pointermove", "pointerdown", "keydown", "wheel", "input"];
    events.forEach((name) => document.addEventListener(name, activity, true));
    const offPrepare = bridge.onPrepare(async () => {
      // Other forms have no universal durable-save contract. Leave them open.
      const unsafeInput = [
        ...document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input,textarea"),
      ].some(
        (input) =>
          input.getClientRects().length &&
          input.value &&
          !input.closest('[data-testid="persisted-composer"]'),
      );
      if (hasLocalUpdateBlockers() || unsafeInput || document.querySelector('[role="dialog"]'))
        return false;
      await flushDraftPersistStorage();
      return !hasLocalUpdateBlockers();
    });
    void bridge.ready(id);
    return () => {
      offStatus();
      offPrepare();
      banner.remove();
      events.forEach((name) => document.removeEventListener(name, activity, true));
    };
  }, []);
}
