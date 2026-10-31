// Writes a dev home's config.json: pins an empty skill selection and, when given, the listen address.
// Shared by dev-home.sh and dev.ps1 so both dev entry points pin the same way.
import fs from "node:fs";

const [configPath, listen] = process.argv.slice(2);

let cfg = {};
try {
  cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
} catch {}
cfg.version = cfg.version || 1;
if (listen) {
  cfg.daemon = cfg.daemon || {};
  cfg.daemon.listen = listen;
  cfg.daemon.cors = cfg.daemon.cors || {};
  cfg.daemon.cors.allowedOrigins = ["*"];
}
cfg.agents = cfg.agents || {};
cfg.agents.skills = cfg.agents.skills || {};
cfg.agents.skills.selection = { mode: "custom", skills: [] };

// The daemon keeps config.json private (0600), and the seeded copy may hold provider credentials,
// so the temp file is created 0600 before it replaces the config.
const tmp = `${configPath}.tmp.${process.pid}`;
try {
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, configPath);
} catch (error) {
  fs.rmSync(tmp, { force: true });
  throw error;
}
