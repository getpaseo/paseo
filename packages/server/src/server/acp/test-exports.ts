#!/usr/bin/env tsx

import { AgentManager } from "./index.js";
import type { AgentStatus } from "./index.js";

console.log("✓ AgentManager imported successfully");
console.log(
  "✓ Methods:",
  Object.getOwnPropertyNames(AgentManager.prototype)
    .filter((m) => m !== "constructor")
    .join(", ")
);

const testStatus: AgentStatus = "ready";
console.log("✓ AgentStatus type works:", testStatus);

console.log("\n✓ All exports verified!");
