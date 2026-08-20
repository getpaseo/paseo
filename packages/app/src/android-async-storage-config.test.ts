import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("Android AsyncStorage configuration", () => {
  it("writes a 64 MiB database limit into Gradle properties", () => {
    const appDirectory = path.resolve(import.meta.dirname, "..");
    const output = execFileSync(
      process.execPath,
      [
        "-e",
        `
          const plugin = require("./plugins/with-android-async-storage-size");
          const config = plugin({ name: "Paseo", slug: "paseo" }, 64);
          const mod = config.mods.android.gradleProperties;
          mod({ ...config, modResults: [], modRequest: {}, modRawConfig: config })
            .then((result) => process.stdout.write(JSON.stringify(result.modResults)));
        `,
      ],
      { cwd: appDirectory, encoding: "utf8" },
    );

    expect(JSON.parse(output)).toEqual([
      { type: "property", key: "AsyncStorage_db_size_in_MB", value: "64" },
    ]);
  });
});
