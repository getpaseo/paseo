import { describe, expect, it } from "vitest";
import { renderWindowsCliShim, windowsShimPathExpression } from "./windows-shim";

const env = {
  USERPROFILE: "C:\\Users\\卢泓锦",
  LOCALAPPDATA: "C:\\Users\\卢泓锦\\AppData\\Local",
  APPDATA: "C:\\Users\\卢泓锦\\AppData\\Roaming",
  PROGRAMFILES: "C:\\Program Files",
};

describe("windowsShimPathExpression", () => {
  it("expresses a per-user install through %LOCALAPPDATA%", () => {
    expect(
      windowsShimPathExpression(
        "C:\\Users\\卢泓锦\\AppData\\Local\\Programs\\Paseo\\resources\\bin\\paseo.cmd",
        env,
      ),
    ).toBe("%LOCALAPPDATA%\\Programs\\Paseo\\resources\\bin\\paseo.cmd");
  });

  it("prefers the most specific root and compares case-insensitively", () => {
    expect(
      windowsShimPathExpression("c:\\users\\卢泓锦\\appdata\\roaming\\Paseo\\bin\\paseo.cmd", env),
    ).toBe("%APPDATA%\\Paseo\\bin\\paseo.cmd");
    expect(windowsShimPathExpression("C:\\Users\\卢泓锦\\Paseo\\bin\\paseo.cmd", env)).toBe(
      "%USERPROFILE%\\Paseo\\bin\\paseo.cmd",
    );
  });

  it("leaves a path outside every known root as it is", () => {
    expect(windowsShimPathExpression("D:\\Tools\\Paseo\\resources\\bin\\paseo.cmd", env)).toBe(
      "D:\\Tools\\Paseo\\resources\\bin\\paseo.cmd",
    );
  });

  it("does not treat a sibling directory with a common prefix as the root", () => {
    expect(windowsShimPathExpression("C:\\Users\\卢泓锦2\\Paseo\\bin\\paseo.cmd", env)).toBe(
      "C:\\Users\\卢泓锦2\\Paseo\\bin\\paseo.cmd",
    );
  });
});

describe("renderWindowsCliShim", () => {
  it("writes an ASCII-only, CRLF-terminated trampoline for a per-user install", () => {
    const content = renderWindowsCliShim(
      "C:\\Users\\卢泓锦\\AppData\\Local\\Programs\\Paseo\\resources\\bin\\paseo.cmd",
      env,
    );
    // cmd.exe reads batch files in the OEM code page; any non-ASCII byte is mojibake.
    expect([...content].every((char) => char.charCodeAt(0) < 128)).toBe(true);
    expect(content.split("\r\n")).toEqual([
      "@echo off",
      'set "BUNDLED_CLI=%LOCALAPPDATA%\\Programs\\Paseo\\resources\\bin\\paseo.cmd"',
      'if not exist "%BUNDLED_CLI%" (',
      "  echo Paseo CLI not found at %BUNDLED_CLI% - is Paseo installed? 1>&2",
      "  exit /b 1",
      ")",
      'call "%BUNDLED_CLI%" %*',
      "exit /b %errorlevel%",
    ]);
    expect(content).not.toContain("\n\n");
  });

  it("keeps an ASCII path outside every root free of the code-page switch", () => {
    const content = renderWindowsCliShim("D:\\Tools\\Paseo\\resources\\bin\\paseo.cmd", env);
    expect(content).not.toContain("chcp");
    expect(content).toContain('set "BUNDLED_CLI=D:\\Tools\\Paseo\\resources\\bin\\paseo.cmd"');
  });

  it("switches to UTF-8 around a non-ASCII path that lies outside every root", () => {
    const content = renderWindowsCliShim("D:\\软件\\Paseo\\resources\\bin\\paseo.cmd", env);
    const lines = content.split("\r\n");
    expect(lines.slice(0, 7)).toEqual([
      "@echo off",
      'for /f "tokens=2 delims=:." %%c in (\'chcp\') do set "PASEO_CODEPAGE=%%c"',
      ">nul chcp 65001",
      'set "BUNDLED_CLI=D:\\软件\\Paseo\\resources\\bin\\paseo.cmd"',
      ">nul chcp %PASEO_CODEPAGE%",
      'set "PASEO_CODEPAGE="',
      'if not exist "%BUNDLED_CLI%" (',
    ]);
    // The path is the only non-ASCII content; the caller writes the file as UTF-8 without a BOM.
    expect(lines.filter((line) => /[\u0080-\uffff]/.test(line))).toEqual([lines[3]]);
  });
});
