import { Codex } from "@openai/codex-sdk";

const PROMPT =
  'Run this command exactly: ["curl", "-s", "https://httpbin.org/get"].\n' +
  "After the command runs, reply with done and stop.";

const CWD = process.cwd();
const TIMEOUT_MS = 90_000;

const CASES = [
  {
    name: "workspace-write + untrusted (like happy-cli default)",
    options: {
      workingDirectory: CWD,
      sandboxMode: "workspace-write",
      approvalPolicy: "untrusted",
      skipGitRepoCheck: true,
    },
  },
  {
    name: "workspace-write + on-request",
    options: {
      workingDirectory: CWD,
      sandboxMode: "workspace-write",
      approvalPolicy: "on-request",
      skipGitRepoCheck: true,
    },
  },
  {
    name: "read-only + untrusted (sandbox blocks before approval)",
    options: {
      workingDirectory: CWD,
      sandboxMode: "read-only",
      approvalPolicy: "untrusted",
      skipGitRepoCheck: true,
    },
  },
];

async function runCase({ name, options }) {
  console.log(`\n=== ${name} ===`);
  const codex = new Codex();
  const thread = codex.startThread(options);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const { events } = await thread.runStreamed(PROMPT, {
      signal: controller.signal,
    });
    for await (const event of events) {
      if (event.type?.startsWith("item.")) {
        console.log(`[event] ${event.type} item.type=${event.item?.type}`);
      } else {
        console.log(`[event] ${event.type}`);
      }
      console.log(JSON.stringify(event));
    }
  } catch (error) {
    console.error(`[error] ${name}:`, error);
  } finally {
    clearTimeout(timeout);
  }
}

for (const testCase of CASES) {
  await runCase(testCase);
}
