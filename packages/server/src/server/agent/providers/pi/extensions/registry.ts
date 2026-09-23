import { piAskUser } from "./pi-ask-user/index.js";
import { piSubagents } from "./pi-subagents/index.js";
import { ohMyPi } from "./oh-my-pi/index.js";
import { piMcpAdapter } from "./pi-mcp-adapter/index.js";
import { rpivTodo } from "./rpiv-todo/index.js";
import { piExampleTodo } from "./pi-example-todo/index.js";
import { piGoalX } from "./pi-goal-x/index.js";

export const piExtensions = [
  piAskUser, // Dialog correlation
  piSubagents, // Delegation calls
  ohMyPi, // Compatible runtime tools
  piMcpAdapter, // MCP proxy names
  rpivTodo,
  piExampleTodo,
  piGoalX,
];
