import { test, expect } from "./fixtures";
import { ensureHostSelected, gotoHome, setWorkingDirectory } from "./helpers/app";
import { createTempGitRepo } from "./helpers/workspace";

test("pastes clipboard image into prompt attachments", async ({ page }) => {
  const repo = await createTempGitRepo("paseo-e2e-paste-image-");

  try {
    await gotoHome(page);
    await setWorkingDirectory(page, repo.path);
    await ensureHostSelected(page);

    const input = page.getByRole("textbox", { name: "Message agent..." });
    await expect(input).toBeEditable();
    await input.focus();

    const result = await page.evaluate(() => {
      const active = document.activeElement;
      if (!(active instanceof HTMLTextAreaElement)) {
        return {
          pasted: false,
          elementTag: active ? active.tagName : null,
          defaultPrevented: false,
        };
      }

      const file = new File([new Uint8Array([0, 1, 2, 3])], "paste.png", {
        type: "image/png",
      });
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(file);

      const event = new ClipboardEvent("paste", {
        clipboardData: dataTransfer,
        bubbles: true,
        cancelable: true,
      });
      active.dispatchEvent(event);

      return {
        pasted: true,
        elementTag: active.tagName,
        defaultPrevented: event.defaultPrevented,
      };
    });

    expect(result.pasted).toBe(true);
    expect(result.defaultPrevented).toBe(true);
    await expect(page.getByTestId("message-input-image-pill")).toHaveCount(1);
  } finally {
    await repo.cleanup();
  }
});
