import { piAskUser } from "./pi-ask-user/index.js";
import { piSubagents } from "./pi-subagents/index.js";
import { piMcpAdapter } from "./pi-mcp-adapter/index.js";
import { rpivTodo } from "./rpiv-todo/index.js";
import { piExampleTodo } from "./pi-example-todo/index.js";
import { piGoalX } from "./pi-goal-x/index.js";
import { tintinwebPiSubagents } from "./tintinweb-pi-subagents/index.js";
import { gotgenesPiSubagents } from "./gotgenes-pi-subagents/index.js";
import { rpivAskUserQuestion } from "./rpiv-ask-user-question/index.js";

export const piExtensions = [
  piAskUser, // Dialog correlation
  piSubagents, // Delegation calls
  tintinwebPiSubagents,
  gotgenesPiSubagents,
  piMcpAdapter, // MCP proxy names
  rpivTodo,
  piExampleTodo,
  piGoalX,
  rpivAskUserQuestion,
];
