import {
  getDocument,
  PasswordResponses,
  type PDFDocumentProxy,
  type RenderTask,
} from "pdfjs-dist/legacy/build/pdf.mjs";
import { WorkerMessageHandler } from "pdfjs-dist/legacy/build/pdf.worker.mjs";
Object.assign(globalThis, { pdfjsWorker: { WorkerMessageHandler } });

// This viewer is bundled with the application. Documents never leave the device.
let document: PDFDocumentProxy | null = null;
let page = 1;
let scale = 1;
let rendering: RenderTask | null = null;
let generation = 0;
const canvas = window.document.querySelector<HTMLCanvasElement>("canvas")!;
const status = window.document.querySelector<HTMLElement>("#status")!;
const pageInput = window.document.querySelector<HTMLInputElement>("#page")!;
const searchInput = window.document.querySelector<HTMLInputElement>("#search")!;
const errorBox = window.document.querySelector<HTMLElement>("#error")!;
const passwordForm = window.document.querySelector<HTMLFormElement>("#password-form")!;
let submitPassword: ((value: string) => void) | null = null;
declare const PASEO_PDF_RESOURCES: { maps: Record<string, string>; fonts: Record<string, string> };
function decodeResource(value: string | undefined): Uint8Array {
  if (!value) throw new Error("Missing bundled PDF font resource");
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}
class BundledBinaryData {
  async fetch({ kind, filename }: { kind: string; filename: string }) {
    if (kind === "cMapUrl")
      return decodeResource(PASEO_PDF_RESOURCES.maps[filename.replace(/\.bcmap$/, "")]);
    if (kind === "standardFontDataUrl") return decodeResource(PASEO_PDF_RESOURCES.fonts[filename]);
    throw new Error("This PDF requires an unsupported decoder");
  }
}

async function render() {
  if (!document) return;
  const current = ++generation;
  rendering?.cancel();
  const pdfPage = await document.getPage(page);
  if (current !== generation) return;
  const initial = pdfPage.getViewport({ scale: 1 });
  const fitted = Math.min(1.5, (window.innerWidth - 24) / initial.width);
  const viewport = pdfPage.getViewport({ scale: Math.max(0.2, fitted) * scale });
  const ratio = Math.min(
    window.devicePixelRatio || 1,
    2,
    Math.sqrt(16_000_000 / (viewport.width * viewport.height)),
    16384 / Math.max(viewport.width, viewport.height),
  );
  canvas.width = Math.floor(viewport.width * ratio);
  canvas.height = Math.floor(viewport.height * ratio);
  canvas.style.width = `${viewport.width}px`;
  canvas.style.height = `${viewport.height}px`;
  rendering = pdfPage.render({ canvas, viewport, transform: [ratio, 0, 0, ratio, 0, 0] });
  try {
    await rendering.promise;
  } catch (error) {
    if (!(error instanceof Error && error.name === "RenderingCancelledException")) throw error;
  }
  if (current !== generation) return;
  status.textContent = `/ ${document.numPages} · ${Math.round(scale * 100)}%`;
  pageInput.value = String(page);
}
function handleError(error: unknown) {
  errorBox.textContent = error instanceof Error ? error.message : String(error);
}
function navigate(next: number) {
  if (!document) return;
  page = Math.max(1, Math.min(document.numPages, next));
  void render().catch(handleError);
}
window.document.querySelector("#previous")!.addEventListener("click", () => navigate(page - 1));
window.document.querySelector("#next")!.addEventListener("click", () => navigate(page + 1));
pageInput.addEventListener("change", () => navigate(Number(pageInput.value) || page));
window.document.querySelector("#zoom-in")!.addEventListener("click", () => {
  scale = Math.min(4, scale + 0.25);
  void render().catch(handleError);
});
window.document.querySelector("#zoom-out")!.addEventListener("click", () => {
  scale = Math.max(0.25, scale - 0.25);
  void render().catch(handleError);
});
window.addEventListener("resize", () => {
  void render().catch(handleError);
});
window.document.querySelector("#search-form")!.addEventListener("submit", (event) => {
  event.preventDefault();
  void (async () => {
    if (!document || !searchInput.value) return;
    const needle = searchInput.value.toLocaleLowerCase();
    const activeDocument = document;
    for (let offset = 1; offset <= activeDocument.numPages; offset++) {
      const next = ((page + offset - 1) % activeDocument.numPages) + 1;
      const text = await (await activeDocument.getPage(next)).getTextContent();
      if (document !== activeDocument) return;
      if (
        text.items
          .map((item) => ("str" in item ? item.str : ""))
          .join(" ")
          .toLocaleLowerCase()
          .includes(needle)
      ) {
        navigate(next);
        return;
      }
    }
    status.textContent = "∅";
  })().catch(handleError);
});
passwordForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const password = window.document.querySelector<HTMLInputElement>("#password")!;
  submitPassword?.(password.value);
  password.value = "";
  passwordForm.hidden = true;
});

interface OpenInput {
  uri?: string;
  data?: Uint8Array;
  background: string;
  foreground: string;
  border: string;
  search: string;
  password: string;
  loading: string;
}
async function open(input: OpenInput) {
  errorBox.textContent = "";
  status.textContent = input.loading;
  window.document.body.style.setProperty("--background", input.background);
  window.document.body.style.setProperty("--foreground", input.foreground);
  window.document.body.style.setProperty("--border", input.border);
  searchInput.placeholder = input.search;
  window.document.querySelector<HTMLInputElement>("#password")!.placeholder = input.password;
  const loading = getDocument({
    ...(input.data ? { data: input.data } : { url: input.uri }),
    enableXfa: false,
    useWasm: false,
    BinaryDataFactory: BundledBinaryData,
    useWorkerFetch: false,
  });
  loading.onPassword = (updatePassword: (password: string) => void, reason: number) => {
    submitPassword = updatePassword;
    passwordForm.hidden = false;
    if (reason === PasswordResponses.INCORRECT_PASSWORD) errorBox.textContent = input.password;
  };
  document = await loading.promise;
  page = 1;
  scale = 1;
  await render();
}
Object.assign(window, {
  PaseoPdf: {
    open: (input: OpenInput) => {
      void open(input).catch(handleError);
    },
  },
});
window.addEventListener("message", (event) => {
  if (event.source !== window.parent || event.data?.type !== "paseo-pdf-open") return;
  void open(event.data.input).catch(handleError);
});
