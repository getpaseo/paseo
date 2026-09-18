#!/usr/bin/env node
import { providerDiagnostic, runFixtureTask } from "../dist/agent.js";
import { resolveVercelCredentials } from "../dist/auth.js";
import { getSandbox } from "../dist/lifecycle.js";
import { loadState } from "../dist/state.js";
import { validateProviderSelection } from "../dist/providers.js";

const [sessionId, prompt] = process.argv.slice(2);
if (!sessionId) {
  console.error("Usage: node scripts/verify-providers.mjs <session-id> [prompt]");
  process.exit(2);
}

const state = loadState(sessionId);
validateProviderSelection(state.agentProvider, state.agentModel);
const credentials = await resolveVercelCredentials({
  team: state.teamId,
  project: state.projectId,
});
const sandbox = await getSandbox(credentials, state, false);
const diagnostic = await providerDiagnostic(sandbox, state);
console.log(JSON.stringify(diagnostic, null, 2));

if (prompt) {
  const output = await runFixtureTask(sandbox, state, prompt);
  console.log(output);
}

if (!diagnostic.ok) process.exitCode = 1;
