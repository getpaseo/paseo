import { setImmediate as nextTask } from "node:timers/promises";
import pino from "pino";
import { OmpAgentClient } from "../agent.js";
import { FakeOmp } from "./fake-omp.js";

if (!global.gc) throw new Error("Run with --expose-gc");
const runtime = new FakeOmp();
const client = new OmpAgentClient({ logger: pino({ level: "silent" }), runtime });
const notices: string[] = [];
const notice = {
  type: "notice",
  level: "info",
  source: "xdev",
  message: "xd://: mounted browser",
} as const;
const agentId = "a7969ccf-b200-429a-a36a-e61ac01e59ab";

async function closedSession(announce: boolean, id: string) {
  const session = await client.createSession(
    { provider: "omp", cwd: process.cwd() },
    { agentId: id },
  );
  session.subscribe((event) => {
    if (event.type === "timeline" && event.item.type === "notification") {
      notices.push(event.item.message);
    }
  });
  if (announce) runtime.latestSession().emit(notice);
  await nextTask();
  const persistence = session.describePersistence();
  if (!persistence) throw new Error("Session has no persistence handle");
  await session.close();
  return { reference: new WeakRef(session), persistence };
}

const withoutNotice = await closedSession(false, "cd39924e-3984-4d10-b2ec-8a4e4ba029f5");
const withNotice = await closedSession(true, agentId);
// Move to another job before collecting: WeakRef targets survive their creation job.
for (let i = 0; i < 5; i++) {
  await nextTask();
  global.gc();
}
const retained = {
  closedWithoutNoticeRetained: withoutNotice.reference.deref() !== undefined,
  closedWithNoticeRetained: withNotice.reference.deref() !== undefined,
};

const resumed = await client.resumeSession(withNotice.persistence, undefined, { agentId });
try {
  resumed.subscribe((event) => {
    if (event.type === "timeline" && event.item.type === "notification") {
      notices.push(event.item.message);
    }
  });
  runtime.latestSession().emit(notice);
  await nextTask();
  console.log(JSON.stringify({ ...retained, noticesAfterRelaunch: notices.length }));
} finally {
  await resumed.close();
}
