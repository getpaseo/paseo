import type { PluginServerContext } from "@getpaseo/plugin";
import { logHook } from "./server/log";

export default function contribute(server: PluginServerContext) {
  server.before("workspace.create", ({ request }) => {
    logHook("before workspace.create", { request });
    return request;
  });

  server.on("workspace.created", (event) => {
    logHook("workspace.created", event);
  });

  server.on("workspace.archived", (event) => {
    logHook("workspace.archived", event);
  });

  server.before("agent.create", ({ request }) => {
    logHook("before agent.create", { request });
    return request;
  });

  server.before("agent.session_open", ({ request }) => {
    logHook("before agent.session_open", { request });
    return request;
  });

  server.on("agent.created", (event) => {
    logHook("agent.created", event);
  });

  server.on("agent.turn_started", (event) => {
    logHook("agent.turn_started", event);
  });

  server.on("agent.turn_ended", (event) => {
    logHook("agent.turn_ended", event);
  });

  server.on("agent.permission_requested", (event) => {
    logHook("agent.permission_requested", event);
  });

  server.on("agent.permission_resolved", (event) => {
    logHook("agent.permission_resolved", event);
  });

  server.on("agent.archived", (event) => {
    logHook("agent.archived", event);
  });

  return () => {};
}
