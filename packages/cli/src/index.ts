#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import fs from "fs";
import path from "path";
import https from "https";
import http from "http";

// Get project ID from local config
const cwd = process.cwd();
const configPath = path.join(cwd, '.supremo.json');
let projectId = '';
try {
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  projectId = config.projectId;
} catch (e) {
  console.error('Project not linked! Run "npx supremo link <projectId>" first.');
  process.exit(1);
}

// Supremo API endpoint
// In production this should be https://supremo-app.vercel.app/api/mcp
const SUPREMO_API = process.env.SUPREMO_API_URL || "http://localhost:3000/api/mcp";

const server = new Server({ name: "supremo-mcp", version: "1.0.0" }, { capabilities: { tools: {} } });

async function callSupremoAPI(action: string, params: any) {
  const url = new URL(SUPREMO_API);
  const reqModule = url.protocol === 'https:' ? https : http;
  
  return new Promise((resolve, reject) => {
    const req = reqModule.request(SUPREMO_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch(e) {
          reject(new Error('Invalid JSON response from Supremo API: ' + data));
        }
      });
    });
    req.on('error', reject);
    req.write(JSON.stringify({ projectId, action, params }));
    req.end();
  });
}

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "supremo_status",
      description: "Check the connection status with the Supremo cloud project.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "supabase_execute_sql",
      description: "Execute a SQL query directly against the linked Supabase database.",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
    },
    {
      name: "github_read_file",
      description: "Read a file directly from the linked GitHub repository.",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    },
    {
      name: "github_write_file",
      description: "Create or update a file directly in the linked GitHub repository.",
      inputSchema: {
        type: "object",
        properties: { 
          path: { type: "string" }, 
          content: { type: "string" },
          message: { type: "string", description: "Commit message" }
        },
        required: ["path", "content"],
      },
    }
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === "supremo_status") {
    return { content: [{ type: "text", text: `🟢 Conectado ao Projeto Supremo: ${projectId}` }] };
  }
  
  if (['supabase_execute_sql', 'github_read_file', 'github_write_file'].includes(request.params.name)) {
    try {
      const result: any = await callSupremoAPI(request.params.name, request.params.arguments);
      if (result.error) throw new Error(result.error);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `❌ Erro: ${e.message}` }] };
    }
  }

  throw new Error(`Tool not found: ${request.params.name}`);
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
