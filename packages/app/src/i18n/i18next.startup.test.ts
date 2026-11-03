import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";
import { beforeAll, describe, expect, it } from "vitest";

let bundle: string;

// Exercise the bundled entry in fresh processes so the test runner's module cache
// cannot hide eager evaluation. The probe only records resource module execution.
beforeAll(async () => {
  const result = await build({
    entryPoints: [path.join(import.meta.dirname, "i18next.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    external: ["i18next", "react-i18next"],
    write: false,
    plugins: [
      {
        name: "observe-translation-evaluation",
        setup(builder) {
          builder.onLoad(
            { filter: /[/\\]i18n[/\\]resources[/\\][a-z]{2}(?:-[A-Z]{2})?\.ts$/ },
            async ({ path: file }) => ({
              contents: `globalThis.evaluatedLocales.push(${JSON.stringify(path.basename(file, ".ts"))});\n${await readFile(file, "utf8")}`,
              loader: "ts",
            }),
          );
        },
      },
    ],
  });
  bundle = result.outputFiles[0].text;
});

function runStartupProbe(actions = "") {
  return JSON.parse(
    execFileSync(process.execPath, ["-"], {
      cwd: path.resolve(import.meta.dirname, "../.."),
      encoding: "utf8",
      input: `globalThis.evaluatedLocales = [];
         (function () { ${bundle} })();
         const { i18n } = module.exports;
         ${actions}
         console.log(JSON.stringify({
           evaluated: globalThis.evaluatedLocales,
           registered: Object.keys(i18n.store.data),
           language: i18n.language,
           cancel: i18n.t("common.actions.cancel"),
           fallback: i18n.t("startupProbeOnlyInEnglish"),
         }));`,
    }),
  );
}

describe("bundled translation startup", () => {
  it("evaluates and registers only English before a language is selected", () => {
    expect(runStartupProbe()).toMatchObject({
      evaluated: ["en"],
      registered: ["en"],
      language: "en",
      cancel: "Cancel",
    });
  });

  it.each([
    ["ar", "يلغي"],
    ["es", "Cancelar"],
    ["fr", "Annuler"],
    ["ja", "キャンセル"],
    ["ko", "취소"],
    ["pt-BR", "Cancelar"],
    ["ru", "Отмена"],
    ["zh-CN", "取消"],
  ])("loads %s synchronously on selection and reuses it", (locale, cancel) => {
    const result = runStartupProbe(`
      i18n.addResource("en", "translation", "startupProbeOnlyInEnglish", "English fallback");
      i18n.changeLanguage(${JSON.stringify(locale)});
      if (i18n.language !== ${JSON.stringify(locale)}) throw new Error("Language selection became asynchronous");
      i18n.changeLanguage("en");
      i18n.changeLanguage(${JSON.stringify(locale)});
    `);
    expect(result).toEqual({
      evaluated: ["en", locale],
      registered: ["en", locale],
      language: locale,
      cancel,
      fallback: "English fallback",
    });
  });
});
