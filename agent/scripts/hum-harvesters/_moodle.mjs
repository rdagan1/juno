// Shared Moodle setup for the moodle-* harvesters: loads .env and builds a
// client with agent/moodle-mcp's REST client. Returns null when Moodle isn't
// configured so harvesters can emit null quietly.

import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";
import { clientFromEnv } from "../../moodle-mcp/client.mjs";

const require = createRequire(import.meta.url);
export const MERLIN_HOME = process.env.MERLIN_HOME || path.join(os.homedir(), "Dev/merlin");
export const MOODLE_STATE_DIR = path.join(MERLIN_HOME, "data/moodle");

export function moodleClient() {
  require("../../../lib/load-env.js").loadEnv(path.join(MERLIN_HOME, ".env"));
  if (!process.env.MOODLE_URL) return null;
  return clientFromEnv();
}
