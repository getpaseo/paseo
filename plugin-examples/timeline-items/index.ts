import type { PluginContext } from "@getpaseo/plugin";
import { PiTaskList } from "./pi-tasks.client";
import { piTaskListSchema, transformPiTodoToolCall } from "./pi-tasks";

export default function contribute(plugin: PluginContext) {
  plugin.addTimelineTransformer({
    id: "pi-tasks",
    query: { itemType: "tool_call" },
    transform: transformPiTodoToolCall,
  });
  plugin.addTimelineRenderer({
    kind: "pi-task-list",
    version: 1,
    schema: piTaskListSchema,
    Component: PiTaskList,
  });
  return () => {};
}
