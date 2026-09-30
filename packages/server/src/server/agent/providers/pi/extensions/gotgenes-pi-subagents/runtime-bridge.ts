export const GOTGENES_CHILD_SESSION_MARKER = "PASEO_GOTGENES_CHILD_SESSION";

/**
 * Runs inside Pi. The spawn result omits the child's session file, so the parent's public service
 * is the live source. Each child session loads its own copy of gotgenes, which republishes the
 * global service and deletes it on exit, so the parent's service is captured at session_start.
 */
export const gotgenesRuntimeBridge = `
  let gotgenesParent;
  pi.on("session_start", (_event, ctx) => {
    gotgenesParent = { ctx, service: globalThis[Symbol.for("@gotgenes/pi-subagents:service")] };
  });
  pi.events.on("subagents:child:session-created", (event) => {
    const parent = gotgenesParent;
    let attempts = 0;
    // The record gets its session file after the child's extensions bind.
    const report = () => {
      const record = parent?.service?.listAgents().find((agent) =>
        agent.outputFile?.includes(event.sessionId),
      );
      if (record) {
        parent.ctx.ui.notify(
          "${GOTGENES_CHILD_SESSION_MARKER} " +
            JSON.stringify({ agentId: record.id, file: record.outputFile }),
          "info",
        );
      } else if (++attempts < 240) {
        setTimeout(report, 250);
      }
    };
    setTimeout(report, 0);
  });
`;
