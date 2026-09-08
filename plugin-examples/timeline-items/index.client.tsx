import type { PluginClientContext } from "@getpaseo/plugin/client";
import { PiTaskList } from "./client/pi-tasks";
import { piTaskListSchema } from "./shared/pi-tasks";
import { transformPiTodoToolCall } from "./client/transform-pi-tasks";

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
