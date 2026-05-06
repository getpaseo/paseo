import { createE2ETestContext } from "../helpers/test-daemon.js";

async function main() {
  const ctx = await createE2ETestContext({ timeout: 180000 });
  try {
    const run = await ctx.paseo(
      [
        "run",
        "--provider",
        "opencode",
        "--mode",
        "default",
        "--model",
        "opencode/kimi-k2.5-free",
        "Say hello in one short sentence.",
      ],
      { timeout: 180000 },
    );
    console.log("EXIT", run.exitCode);
    console.log("STDOUT\n" + run.stdout);
    console.log("STDERR\n" + run.stderr);
  } finally {
    await ctx.stop();
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
