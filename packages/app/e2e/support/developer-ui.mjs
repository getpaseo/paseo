const HIDE_DEVELOPER_TOASTS = "#error-toast { display: none !important; }";

/** @param {import('@playwright/test').Page} page */
export async function hideDeveloperToasts(page) {
  // Developer chrome must not cover app actions or move the test's pointer/focus.
  // Console errors remain in the runner's logs. Hiding the toast, instead of clicking it away,
  // leaves no race with a toast that closes or is replaced between matching and clicking.
  await page.addInitScript((css) => {
    const style = document.createElement("style");
    style.textContent = css;
    document.addEventListener("DOMContentLoaded", () => document.head.append(style));
  }, HIDE_DEVELOPER_TOASTS);
  // A page attached after it loaded (Electron over CDP) runs no init script until it navigates.
  await page.addStyleTag({ content: HIDE_DEVELOPER_TOASTS });
}
