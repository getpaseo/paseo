const MAX_CUSTOM_THEME_BYTES = 64 * 1024;

export function pickCustomThemeJson(): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "application/json,.json";
    input.style.display = "none";

    function finish(value: string | null) {
      input.remove();
      resolve(value);
    }

    input.addEventListener("change", async () => {
      const file = input.files?.[0];
      if (!file) {
        finish(null);
        return;
      }
      if (file.size > MAX_CUSTOM_THEME_BYTES) {
        input.remove();
        reject(new RangeError("Theme files must be smaller than 64 KB"));
        return;
      }
      try {
        finish(await file.text());
      } catch (error) {
        input.remove();
        reject(error);
      }
    });
    input.addEventListener("cancel", () => finish(null));
    document.body.appendChild(input);
    input.click();
  });
}
