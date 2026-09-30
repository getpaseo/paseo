export const GOTGENES_CHILD_SESSION_MARKER = "PASEO_GOTGENES_CHILD_SESSION";

/** Runs inside Pi, where the extension's public service owns the live path. */
export const gotgenesRuntimeBridge = `
  let gotgenesContext;
  pi.on("session_start", (_event, ctx) => { gotgenesContext = ctx; });
  pi.events.on("subagents:child:session-created", (event) => {
    let attempts = 0;
    const report = () => {
      const service = globalThis[Symbol.for("@gotgenes/pi-subagents:service")];
      const record = service?.listAgents().find((agent) =>
        agent.outputFile?.includes(event.sessionId),
      );
      if (record?.outputFile && gotgenesContext) {
        gotgenesContext.ui.notify(
          "${GOTGENES_CHILD_SESSION_MARKER} " +
            JSON.stringify({ agentId: record.id, file: record.outputFile }),
          "info",
        );
      } else if (++attempts < 20) {
        setTimeout(report, 50);
      }
    };
    setTimeout(report, 0);
  });
`;
