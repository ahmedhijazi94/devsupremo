#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import https from "https";
import http from "http";

const SUPREMO_API = process.env.SUPREMO_API_URL || "http://localhost:3000/api/mcp";

const server = new Server({ name: "supremo-mcp", version: "2.0.0" }, { capabilities: { tools: {} } });

async function callSupremoAPI(action: string, params: any = {}, projectId?: string) {
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
          reject(new Error('Invalid JSON response from Supremo API'));
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
      name: "supremo_list_projects",
      description: "Lista todos os projetos criados no Supremo. Retorna o ID e nome do repositório.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "supabase_execute_sql",
      description: "Execute a SQL query against the linked Supabase database.",
      inputSchema: {
        type: "object",
        properties: { 
          projectId: { type: "string" },
          query: { type: "string" } 
        },
        required: ["projectId", "query"],
      },
    },
    {
      name: "github_read_file",
      description: "Read a file directly from the linked GitHub repository.",
      inputSchema: {
        type: "object",
        properties: { 
          projectId: { type: "string" },
          path: { type: "string" } 
        },
        required: ["projectId", "path"],
      },
    },
    {
      name: "github_write_file",
      description: "Create or update a file directly in the linked GitHub repository.",
      inputSchema: {
        type: "object",
        properties: { 
          projectId: { type: "string" },
          path: { type: "string" }, 
          content: { type: "string" },
          message: { type: "string", description: "Commit message" }
        },
        required: ["projectId", "path", "content"],
      },
    }
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const name = request.params.name;
  const args = request.params.arguments || {};
  
  if (['supremo_list_projects', 'supabase_execute_sql', 'github_read_file', 'github_write_file'].includes(name)) {
    try {
      const result: any = await callSupremoAPI(name, args, (args as any).projectId);
      if (result.error) throw new Error(result.error);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `❌ Erro: ${e.message}` }] };
    }
  }

  throw new Error(`Tool not found: ${name}`);
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
