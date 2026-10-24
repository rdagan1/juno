// mcp.mjs — thin MCP server exposing the WhatsApp channel's reply tool.
// Stateless: it forwards to the daemon's localhost API, so both agents can
// load it without opening a second WhatsApp connection.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const BASE = `http://127.0.0.1:${process.env.WHATSAPP_PORT || 9097}`;

const mcp = new Server(
  { name: "whatsapp", version: "1.0.0" },
  {
    capabilities: { tools: {} },
    instructions: `Messages that arrive "via WhatsApp" must be answered with the \`reply\` tool here (mcp__whatsapp__reply). Plain assistant text is NOT delivered. WhatsApp renders *bold*, _italic_, ~strike~ and \`\`\`mono\`\`\`; markdown is converted automatically. Keep replies phone-sized; long answers are split into several bubbles.`,
  },
);

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "reply",
      description: "Send a WhatsApp message to the user (their chat with Merlin). The ONLY way to answer a WhatsApp message. Call early with a short ack for slow tasks, then again with the answer.",
      inputSchema: { type: "object", properties: { message: { type: "string" } }, required: ["message"] },
    },
    {
      name: "status",
      description: "WhatsApp channel health: connected or not, linked number, owner, mode.",
      inputSchema: { type: "object", properties: {} },
    },
  ],
}));

mcp.setRequestHandler(CallToolRequestSchema, async (request) => {
  const text = (t, isError = false) => ({ content: [{ type: "text", text: t }], isError });
  try {
    if (request.params.name === "reply") {
      const res = await fetch(`${BASE}/send`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: request.params.arguments?.message }),
        signal: AbortSignal.timeout(30_000),
      });
      const body = await res.json();
      return res.ok ? text(`sent (${body.parts} message${body.parts === 1 ? "" : "s"})`) : text(`WhatsApp send failed: ${body.error}`, true);
    }
    if (request.params.name === "status") {
      const res = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(5000) });
      return text(JSON.stringify(await res.json(), null, 2));
    }
    return text(`Unknown tool: ${request.params.name}`, true);
  } catch (err) {
    return text(`WhatsApp channel unreachable (${err.message}) — is the whatsapp-channel daemon running?`, true);
  }
});

await mcp.connect(new StdioServerTransport());
