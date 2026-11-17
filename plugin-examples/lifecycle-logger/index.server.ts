import type { PluginServerContext } from "@getpaseo/plugin/server";
import { logHook } from "./server/log";

export default function contribute(server: PluginServerContext) {
  server.addHook("workspace.create.before", async ({ request }) => {
    logHook("workspace.create.before", { request });
    return request;
  });

  server.addHook("workspace.create.after", async (event) => {
    logHook("workspace.create.after", event);
  });

  server.addHook("workspace.archive.after", async (event) => {
    logHook("workspace.archive.after", event);
  });

  server.addHook("worktree.create.after", async (event) => {
    logHook("worktree.create.after", event);
  });

  server.addHook("agent.create.before", async ({ request }) => {
    logHook("agent.create.before", { request });
    return request;
  });

  server.addHook("agent.open.before", async ({ request }) => {
    logHook("agent.open.before", { request });
    return request;
  });

  server.addHook("agent.create.after", async (event) => {
    logHook("agent.create.after", event);
  });

  server.addHook("agent.close.after", async (event) => {
    logHook("agent.close.after", event);
  });

  server.addHook("agent.turn.before", async (event) => {
    logHook("agent.turn.before", event);
  });

  server.addHook("agent.turn.after", async (event) => {
    logHook("agent.turn.after", event);
  });

  server.addHook("agent.permission.before", async (event) => {
    logHook("agent.permission.before", event);
  });

  server.addHook("agent.permission.after", async (event) => {
    logHook("agent.permission.after", event);
  });

  server.addHook("agent.archive.after", async (event) => {
    logHook("agent.archive.after", event);
  });

  return () => {};
}
