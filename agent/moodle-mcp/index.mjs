// moodle-mcp — read-only MCP server over a Moodle site's Web Services API.
//
// Env (from .env, see docs/integrations/moodle.md):
//   MOODLE_URL        site root, e.g. https://moodle.example.edu
//   MOODLE_TOKEN      web-service token (preferred; required on SSO sites)
//   MOODLE_USERNAME / MOODLE_PASSWORD   alternative: exchanged for a token
//   MOODLE_SERVICE    service shortname (default moodle_mobile_app)
//   MOODLE_TIMEZONE   IANA zone for rendered dates (default: host zone)

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createRequire } from "node:module";
import path from "node:path";
import { clientFromEnv } from "./client.mjs";
import { buildTools } from "./tools.mjs";

const require = createRequire(import.meta.url);
const MERLIN_HOME = process.env.MERLIN_HOME || `${process.env.HOME}/Dev/merlin`;
require("../../lib/load-env.js").loadEnv(path.join(MERLIN_HOME, ".env"));

const env = process.env;
let client = null;
let configError = null;
try {
  client = clientFromEnv(env);
} catch (err) {
  // Stay up and list the tools anyway, so the agent sees a clear
  // "not configured" error instead of a silently missing server.
  configError = err.message;
}
const tools = buildTools(client, {
  filesDir: path.join(MERLIN_HOME, "data/moodle/files"),
  stateDir: path.join(MERLIN_HOME, "data/moodle"),
  timeZone: env.MOODLE_TIMEZONE,
});

const mcp = new Server(
  { name: "moodle", version: "1.0.0" },
  {
    capabilities: { tools: {} },
    instructions: `Read-only access to the student's Moodle (courses, materials, deadlines, grades, announcements).

Typical flow: moodle_courses → moodle_course_contents(course_id) → moodle_get_file(file_url) to read slides/PDFs.
For "anything new?": moodle_changes (diffs against the last check).
For "what's due": moodle_upcoming first (timeline across all courses), then moodle_assignments / moodle_assignment_status for detail.
Dates are already rendered in the student's timezone. Nothing here can submit, post, or change anything on Moodle.`,
  },
);

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.schema })),
}));

mcp.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (configError) {
    return { content: [{ type: "text", text: `Moodle not configured: ${configError}. See docs/integrations/moodle.md.` }], isError: true };
  }
  const tool = tools.find((t) => t.name === request.params.name);
  if (!tool) {
    return { content: [{ type: "text", text: `Unknown tool: ${request.params.name}` }], isError: true };
  }
  try {
    const result = await tool.run(request.params.arguments || {});
    return { content: [{ type: "text", text: result }] };
  } catch (err) {
    return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
  }
});

await mcp.connect(new StdioServerTransport());
