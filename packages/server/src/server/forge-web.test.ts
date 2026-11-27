import { expect, test } from "vitest";
import { defaultForgeRegistry } from "../services/forge-registry.js";
import { createGitHubService } from "../services/github-service.js";
import { forgeWebForResolution } from "./forge-web.js";

test("publishes a plugin forge's web host and discards entries from a replaced adapter", () => {
  const remoteUrl = "git@ssh.example.test:org/repo.git";
  const definition = {
    ...defaultForgeRegistry.definitionOrNeutral("custom"),
    cloudHosts: ["web.example.test", "ssh.example.test"],
  };
  const resolution = {
    forge: "custom",
    host: "SSH.example.test.",
    definition,
    adapterRevision: 1,
    service: createGitHubService(),
  };
  const first = forgeWebForResolution({ remoteUrl, resolution, previous: null, nowMs: 0 });
  expect(first.forgeWeb).toEqual({ host: "web.example.test" });

  const afterReplacement = forgeWebForResolution({
    remoteUrl,
    resolution: {
      ...resolution,
      adapterRevision: 2,
      definition: { ...definition, cloudHosts: ["new.example.test", "ssh.example.test"] },
    },
    previous: first,
    nowMs: 1,
  });
  expect(afterReplacement.forgeWeb).toEqual({ host: "new.example.test" });
});
