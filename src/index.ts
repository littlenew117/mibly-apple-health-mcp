import express, { type ErrorRequestHandler } from "express";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { requireToken } from "./auth.js";
import { resolveConfig } from "./config.js";
import { ingestHandler, MALFORMED } from "./ingest.js";
import { createMcpServer } from "./mcp.js";
import { HealthStore } from "./store.js";

const { token, salt, host, freshStore } = resolveConfig();
if (freshStore) console.error("[mibly-apple-health-mcp] new or changed pairing token: starting with an empty store");
const store = new HealthStore(token, salt, freshStore);

const [bindHost, portRaw] = host.split(":");
const port = Number(portRaw) || 7345;

const app = express();
app.use(requireToken(token)); // every route needs the token, checked before the body is parsed
app.use(express.json({ limit: "2mb" }));

app.post("/ingest", ingestHandler(store));

app.get("/status", (_req, res) => {
  res.status(200).json(store.status());
});

// Stateless MCP Streamable HTTP: a fresh transport and server per request.
app.post("/mcp", async (req, res) => {
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  const mcpServer = createMcpServer(store);
  res.on("close", () => {
    transport.close();
    mcpServer.close();
  });
  await mcpServer.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

// Unparseable JSON from /ingest gets the documented 400 instead of Express's default page.
const onError: ErrorRequestHandler = (err, _req, res, next) => {
  if (err?.type === "entity.parse.failed") return void res.status(400).json(MALFORMED);
  next(err);
};
app.use(onError);

app.listen(port, bindHost || "0.0.0.0", () => {
  console.error(`[mibly-apple-health-mcp] listening on ${bindHost || "0.0.0.0"}:${port} (POST /ingest, GET /status, POST /mcp)`);
});

// Optional: also serve the same tools over stdio for agents that spawn MCP servers (e.g. Claude Desktop).
if (process.argv.includes("--stdio")) {
  await createMcpServer(store).connect(new StdioServerTransport());
}
