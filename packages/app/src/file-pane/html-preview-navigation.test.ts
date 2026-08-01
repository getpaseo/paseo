import { describe, expect, it } from "vitest";
import { htmlPreviewNavigationKind } from "@/file-pane/html-preview-navigation";

describe("htmlPreviewNavigationKind", () => {
  it("allows the WebView's initial document URLs", () => {
    expect(htmlPreviewNavigationKind("about:blank")).toBe("initialDocument");
    expect(htmlPreviewNavigationKind("about:srcdoc")).toBe("initialDocument");
    expect(htmlPreviewNavigationKind("")).toBe("initialDocument");
  });

  it("allows same-document fragment navigation", () => {
    expect(htmlPreviewNavigationKind("about:blank#decision-table")).toBe("fragment");
    expect(htmlPreviewNavigationKind("about:srcdoc#decision-table")).toBe("fragment");
  });

  it("blocks documents that could escape the injected policy", () => {
    expect(htmlPreviewNavigationKind("https://example.com/leak")).toBe("blocked");
    expect(
      htmlPreviewNavigationKind("data:text/html,<script>location='https://example.com'</script>"),
    ).toBe("blocked");
    expect(htmlPreviewNavigationKind("blob:https://example.com/document-id")).toBe("blocked");
  });
});
