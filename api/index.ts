import type { IncomingMessage, ServerResponse } from "node:http";
import { createApp } from "../src/app.js";

// One shared app (and in-memory database) per warm function instance.
let app: ReturnType<typeof createApp> | undefined;

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  app ??= createApp();
  return (await app)(req, res);
}
