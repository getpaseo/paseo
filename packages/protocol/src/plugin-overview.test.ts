import { describe, expect, it } from "vitest";
import { pluginOverviewUrl } from "./plugin-overview.js";

describe("plugin overview destinations", () => {
  it.each([
    undefined,
    "",
    "./docs",
    "../docs",
    "/login",
    "//example.com",
    "#section",
    "?login",
    "http://example.com",
    "mailto:hello@example.com",
    "ftp://example.com",
    "javascript:alert(1)",
    "data:image/png;base64,AAAA",
    "vbscript:msgbox(1)",
    "javascript&#58;alert(1)",
    "javascript%3Aalert(1)",
    "javascript%253Aalert(1)",
    "java\tscript:alert(1)",
    " https://example.com",
    "https://example.com\n",
    "https:example.com",
    "https:///example.com",
    "https://paseo.sh@evil.example",
    "https://example.com\\@evil.example",
    "https://",
  ])("leaves %s as text", (url) => {
    expect(pluginOverviewUrl(url)).toBeUndefined();
  });

  it.each([
    "https://example.com/path?q=a&b=c#section",
    "HTTPS://example.com/path",
    "https://example.com/%3Cscript%3E",
  ])("allows %s without decoding it again", (url) => {
    expect(pluginOverviewUrl(url)).toBe(url);
  });
});
