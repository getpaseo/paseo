import { expect, it } from "vitest";
import { inertArtifactHtml } from "./html-policy";
it("keeps generated JavaScript inert and removes navigation and host/network entry points", () => {
  const result = inertArtifactHtml(
    '<html><body><script>fetch("https://evil")</script><a href="https://evil">go</a><form action="https://evil"><input></form><img src="https://evil"><meta http-equiv="refresh" content="0;url=https://evil"><iframe src="file:///etc/passwd"></iframe><div onclick="location.href=\'https://evil\'">ok</div></body></html>',
  );
  expect(result.scripted).toBe(true);
  expect(result.html).not.toContain("evil");
  expect(result.html).not.toContain("onclick");
  expect(result.html).not.toContain("<script");
  expect(result.html).toContain("script-src 'none'");
  expect(result.html).toContain("<div>ok</div>");
});
