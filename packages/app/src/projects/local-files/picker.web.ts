import type { LocalFileSelection } from "./picker-types";

export function pickLocalFiles(): Promise<LocalFileSelection[] | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.hidden = true;
    function finish(files: LocalFileSelection[] | null) {
      input.remove();
      resolve(files);
    }
    input.addEventListener(
      "change",
      () => {
        const files = Array.from(input.files ?? []);
        finish(
          files.map((file) => ({
            path: file.name,
            size: file.size,
            status: "ready",
            read: async () => new Uint8Array(await file.arrayBuffer()),
          })),
        );
      },
      { once: true },
    );
    input.addEventListener("cancel", () => finish(null), { once: true });
    document.body.appendChild(input);
    input.click();
  });
}
