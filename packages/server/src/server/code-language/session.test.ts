import { unpackLanguageRuntimePath } from "./process.js";
import { afterEach, expect, test } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { CodeLanguageSession } from "./session.js";
import { contentIdentity } from "./content.js";

const sessions: CodeLanguageSession[] = [];
const roots: string[] = [];
afterEach(async () => {
  for (const host of sessions.splice(0)) host.dispose();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
function session() {
  const value = new CodeLanguageSession(pino({ level: "silent" }));
  sessions.push(value);
  return value;
}
async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), "paseo-language-"));
  roots.push(cwd);
  await writeFile(
    join(cwd, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: { strict: true, baseUrl: ".", paths: { "@lib/*": ["*"] }, jsx: "preserve" },
      include: ["*.ts", "*.tsx"],
    }),
  );
  await writeFile(join(cwd, "lib.ts"), "export const answer = 42;\n");
  const content = 'import { answer } from "@lib/lib";\nconst result = answer;\n';
  await writeFile(join(cwd, "main.ts"), content);
  return { cwd, content, path: join(cwd, "main.ts"), position: { line: 1, character: 17 } };
}
test("real bundled server resolves types, aliases, definitions and usages", async () => {
  const input = await fixture();
  const host = session();
  await host.sync({ ...input, version: 1, content: input.content });
  const query = { ...input, version: 1, operation: "hover" as const };
  const hover = await host.query(query);
  expect(hover.result.kind).toBe("hover");
  if (hover.result.kind === "hover") expect(hover.result.text).toContain("42");
  const definition = await host.query({ ...query, operation: "definition" });
  expect(definition.result.kind).toBe("locations");
  if (definition.result.kind === "locations")
    expect(definition.result.locations[0]?.path).toBe(join(input.cwd, "lib.ts"));
  const references = await host.query({ ...query, operation: "references" });
  expect(references.result.kind).toBe("locations");
  if (references.result.kind === "locations")
    expect(
      references.result.locations.every((location) => location.path !== join(input.cwd, "lib.ts")),
    ).toBe(true);
  if (references.result.kind === "locations")
    expect(references.result.locations.some((location) => location.range.start.line === 1)).toBe(
      true,
    );
});
test("isolates unsaved buffers and rejects a diff whose full content differs", async () => {
  const input = await fixture();
  const first = session();
  const second = session();
  const content = 'const answer = "changed";\nconst result = answer;\n';
  await first.sync({ ...input, version: 2, content });
  await second.sync({ ...input, version: 1, content: input.content });
  const query = { ...input, version: 2, operation: "hover" as const };
  const changed = await first.query(query);
  if (changed.result.kind === "hover") expect(changed.result.text).toContain('"changed"');
  else expect.fail(JSON.stringify(changed));
  const original = await second.query({ ...query, version: 1 });
  if (original.result.kind === "hover") expect(original.result.text).toContain("42");
  else expect.fail(JSON.stringify(original));
  const stale = await first.query({ ...query, targetContentId: contentIdentity(input.content) });
  expect(stale.result.kind).toBe("stale");
  expect((await first.query({ ...query, version: 1 })).result.kind).toBe("stale");
});
test("analyzes matching disk snapshots and rejects external changes", async () => {
  const input = await fixture();
  const host = session();
  const query = {
    ...input,
    version: null,
    operation: "hover" as const,
    targetContentId: contentIdentity(input.content),
  };
  expect((await host.query(query)).result.kind).toBe("hover");
  await writeFile(input.path, `// changed above the query\n${input.content}`);
  expect((await host.query(query)).result.kind).toBe("stale");
});

test("supports inferred TSX, declaration dependencies and project references", async () => {
  const { cwd } = await fixture();
  const host = session();
  await mkdir(join(cwd, "lib"));
  await mkdir(join(cwd, "app"));
  await writeFile(
    join(cwd, "lib/tsconfig.json"),
    JSON.stringify({ compilerOptions: { composite: true }, files: ["value.ts"] }),
  );
  await writeFile(join(cwd, "lib/value.ts"), 'export const label = "project-reference";');
  await writeFile(
    join(cwd, "app/tsconfig.json"),
    JSON.stringify({
      compilerOptions: { composite: true, jsx: "preserve" },
      references: [{ path: "../lib" }],
      files: ["view.tsx"],
    }),
  );
  const path = join(cwd, "app/view.tsx");
  await writeFile(path, 'import { label } from "../lib/value";\nconst view = <div>{label}</div>;');
  const query = {
    cwd,
    path,
    version: null,
    operation: "hover" as const,
    position: { line: 1, character: 20 },
  };
  const hover = await host.query(query);
  expect(hover.result.kind).toBe("hover");
  if (hover.result.kind === "hover") expect(hover.result.text).toContain("project-reference");
  await mkdir(join(cwd, "node_modules/fixture-types"), { recursive: true });
  await writeFile(
    join(cwd, "node_modules/fixture-types/package.json"),
    JSON.stringify({ name: "fixture-types", types: "index.d.ts" }),
  );
  const declaration = join(cwd, "node_modules/fixture-types/index.d.ts");
  await writeFile(declaration, 'export declare const external: "dependency";');
  const inferred = join(cwd, "inferred.mts");
  await writeFile(inferred, 'import { external } from "fixture-types";\nexternal;');
  const definition = await host.query({
    ...query,
    path: inferred,
    operation: "definition",
    position: { line: 1, character: 2 },
  });
  if (definition.result.kind === "locations")
    expect(definition.result.locations[0]?.path).toBe(await realpath(declaration));
  else expect.fail(JSON.stringify(definition));
});

test("observes changes to unopened dependencies and survives closing and reopening the workspace", async () => {
  const input = await fixture();
  const host = session();
  const query = { ...input, version: null, operation: "hover" as const };
  expect((await host.query(query)).result.kind).toBe("hover");
  await writeFile(join(input.cwd, "lib.ts"), 'export const answer = "updated-by-agent";');
  await expect
    .poll(
      async () => {
        const result = (await host.query(query)).result;
        return result.kind === "hover" ? result.text : "";
      },
      { timeout: 10000, interval: 100 },
    )
    .toContain("updated-by-agent");
  host.closeWorkspace(input.cwd);
  const reopened = await host.query(query);
  if (reopened.result.kind === "hover") expect(reopened.result.text).toContain("updated-by-agent");
  else expect.fail(JSON.stringify(reopened));
});

test("cancels a query before starting language analysis", async () => {
  const input = await fixture();
  const host = session();
  const pending = host.query({ ...input, version: null, operation: "hover" }, "cancel-me");
  await host.handle(
    { type: "code.language.cancel.request", requestId: "cancel", queryId: "cancel-me" },
    () => {},
  );
  expect((await pending).result.kind).toBe("stale");
});

test("resolves real subprocess files inside packaged Electron resources", () => {
  expect(
    unpackLanguageRuntimePath(
      "/Paseo.app/Contents/Resources/app.asar/node_modules/typescript/lib/tsserver.js",
    ),
  ).toBe("/Paseo.app/Contents/Resources/app.asar.unpacked/node_modules/typescript/lib/tsserver.js");
  expect(
    unpackLanguageRuntimePath(
      "C:\\Paseo\\app.asar\\node_modules\\typescript-language-server\\lib\\cli.mjs",
    ),
  ).toBe("C:\\Paseo\\app.asar.unpacked\\node_modules\\typescript-language-server\\lib\\cli.mjs");
  expect(unpackLanguageRuntimePath("/repo/node_modules/typescript/lib/tsserver.js")).toBe(
    "/repo/node_modules/typescript/lib/tsserver.js",
  );
});
