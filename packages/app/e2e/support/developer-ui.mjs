/** @param {import('@playwright/test').Page} page */
export async function hideDeveloperToasts(page) {
  // Developer chrome must not cover app actions or move the test's pointer/focus.
  // Console errors remain in the runner's logs. Hiding the toast, instead of clicking it away,
  // leaves no race with a toast that closes or is replaced between matching and clicking.
  await page.addInitScript(() => {
    const style = document.createElement("style");
    style.textContent = "#error-toast { display: none !important; }";
    document.addEventListener("DOMContentLoaded", () => document.head.append(style));
  });
}
