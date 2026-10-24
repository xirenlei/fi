import { createApp } from "./app";
import { startWeb } from "./web/server";

const app = createApp();
await app.start();
startWeb(app);

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    await app.stop();
    process.exit(0);
  });
}
