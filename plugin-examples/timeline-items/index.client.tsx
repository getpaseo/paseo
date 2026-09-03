import type { PluginClientContext } from "@getpaseo/plugin";
import { PiTaskList } from "./client/pi-tasks";
import { piTaskListSchema, transformPiTodoToolCall } from "./shared/pi-tasks";

export default function contribute(client: PluginClientContext) {
  client.addTimelineTransformer({
    id: "pi-tasks",
    query: { itemType: "tool_call" },
    transform: transformPiTodoToolCall,
  });
  client.addTimelineRenderer({
    kind: "pi-task-list",
    version: 1,
    schema: piTaskListSchema,
    Component: PiTaskList,
  });
  return () => {};
}
