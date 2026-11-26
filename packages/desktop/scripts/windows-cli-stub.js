const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const stubSource = path.join(__dirname, "..", "bin", "paseo-cli-stub.cs");
const probeSource = path.join(__dirname, "windows-cli-probe.cs");

function findCsc() {
  const windir = process.env.WINDIR || "C:\\Windows";
  const candidates = [
    path.join(windir, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe"),
    path.join(windir, "Microsoft.NET", "Framework", "v4.0.30319", "csc.exe"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error("csc.exe was not found. The Windows CLI stub needs the .NET Framework compiler.");
}

function compileCSharp(sourcePath, outPath, subsystem) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  // AnyCPU IL runs as 64-bit beside both the x64 and ARM64 Electron binaries.
  const target = subsystem === "windows" ? "/target:winexe" : "/target:exe";
  const result = spawnSync(
    findCsc(),
    ["/nologo", "/optimize+", target, "/platform:anycpu", `/out:${outPath}`, sourcePath],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(
      `csc failed for ${sourcePath} (status ${result.status})\n${result.stdout ?? ""}\n${result.stderr ?? ""}`,
    );
  }
}

function compileWindowsCliStub(outPath) {
  compileCSharp(stubSource, outPath);
}

function compileWindowsCliProbe(outPath, subsystem) {
  compileCSharp(probeSource, outPath, subsystem);
}

module.exports = {
  compileWindowsCliStub,
  compileWindowsCliProbe,
};
