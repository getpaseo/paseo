import { createRelayServer } from "@paseo/relay/node";

const port = Number(process.env.PORT ?? "7778");
const host = process.env.HOST ?? "0.0.0.0";

async function main() {
  const server = createRelayServer({ port, host });
  await server.start();
  console.log(`[relay-local] ready host=${host} port=${port}`);

  const stop = async () => {
    try {
      await server.stop();
    } finally {
      process.exit(0);
    }
  };

  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  setInterval(() => {}, 1e9);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

