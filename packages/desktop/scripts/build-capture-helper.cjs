const { execFileSync } = require("node:child_process");
const { mkdirSync } = require("node:fs");
const path = require("node:path");

function buildCaptureHelper(outputDirectory, arch) {
  if (!["arm64", "x64", "universal"].includes(arch))
    throw new Error("Unsupported capture helper architecture");
  mkdirSync(outputDirectory, { recursive: true });
  const source = path.join(__dirname, "../native/desktop-capture");
  const output = path.join(outputDirectory, "paseo-desktop-capture");
  const architectures = arch === "universal" ? ["arm64", "x64"] : [arch];
  const outputs = architectures.map((architecture) => {
    const target = architecture === "x64" ? "x86_64" : "arm64";
    const binary = architectures.length === 1 ? output : `${output}-${architecture}`;
    execFileSync(
      "xcrun",
      [
        "swiftc",
        "-O",
        "-target",
        `${target}-apple-macosx14.0`,
        path.join(source, "ModifierShortcut.swift"),
        path.join(source, "GestureOverlay.swift"),
        path.join(source, "main.swift"),
        "-o",
        binary,
      ],
      { stdio: "inherit" },
    );
    return binary;
  });
  if (outputs.length > 1)
    execFileSync("xcrun", ["lipo", "-create", ...outputs, "-output", output], { stdio: "inherit" });
  return output;
}
module.exports = { buildCaptureHelper };
if (require.main === module && process.platform === "darwin") {
  buildCaptureHelper(path.join(__dirname, "../dist/native"), process.arch);
}
