#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { createClient } from "@supabase/supabase-js";
import { Octokit } from "@octokit/rest";
import dotenv from "dotenv";
import path from "path";
import fs from "fs";

// Load environment variables
const envPath = path.resolve(process.cwd(), '.env.local');
if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
} else {
  console.error('.env.local not found at', envPath);
}

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  throw new Error("Missing Supabase credentials in .env.local");
}

const supabase = createClient(supabaseUrl, supabaseKey);

// Import crypto from the app (needs tsx to resolve path aliases)
import { decryptToken } from "../lib/crypto";

// Create the MCP Server
const server = new Server(
  {
    name: "Supremo MCP",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Helper to get GitHub token
async function getGithubOctokit(projectId: string): Promise<{ octokit: Octokit, owner: string, repo: string, branch: string }> {
  const { data: project, error } = await supabase
    .from("projects")
    .select("*, github_accounts(encrypted_token)")
    .eq("id", projectId)
    .single();

  if (error || !project) throw new Error("Projeto não encontrado.");
  if (!project.github_repo_full_name) throw new Error("Projeto não possui repositório GitHub vinculado.");
  
  const token = decryptToken(project.github_accounts.encrypted_token);
  const octokit = new Octokit({ auth: token });
  
  const [owner, repo] = project.github_repo_full_name.split("/");
  return { octokit, owner, repo, branch: project.active_branch || "main" };
}

// Helper to get active project
async function getActiveProject() {
  const { data, error } = await supabase
    .from("projects")
    .select("*")
    .eq("is_active", true)
    .single();
  if (error && error.code !== 'PGRST116') throw new Error(error.message);
  return data;
}

// Register Tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "get_active_project",
        description: "Returns the currently active project from the Supremo dashboard.",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "list_projects",
        description: "Lists all projects managed by Supremo.",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "switch_project",
        description: "Switches the active project in the dashboard.",
        inputSchema: {
          type: "object",
          properties: {
            projectId: { type: "string" },
          },
          required: ["projectId"],
        },
      },
      {
        name: "get_project_context",
        description: "Fetches context for the active project (Supabase ID, GitHub Repo, Branch).",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "read_github_file",
        description: "Reads the content of a file from the active project's GitHub repository.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "File path (e.g. src/app/page.tsx)" },
          },
          required: ["path"],
        },
      },
      {
        name: "write_github_files",
        description: "Commits new/modified files directly to the active branch in GitHub.",
        inputSchema: {
          type: "object",
          properties: {
            message: { type: "string", description: "Commit message" },
            files: {
              type: "array",
              description: "List of files to write",
              items: {
                type: "object",
                properties: {
                  path: { type: "string" },
                  content: { type: "string" }
                },
                required: ["path", "content"]
              }
            }
          },
          required: ["message", "files"],
        },
      },
      {
        name: "run_test_pipeline",
        description: "Triggers the CI pipeline (GitHub Actions) for the active branch.",
        inputSchema: { type: "object", properties: {} },
      }
    ],
  };
});

// Handle Tool Executions
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    if (name === "get_active_project") {
      const data = await getActiveProject();
      if (!data) return { content: [{ type: "text", text: "Nenhum projeto ativo." }] };
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }

    if (name === "list_projects") {
      const { data, error } = await supabase
        .from("projects")
        .select("id, name, description, is_active, status, github_repo_full_name")
        .order("updated_at", { ascending: false });
      if (error) throw new Error(error.message);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }

    if (name === "switch_project") {
      const projectId = (args as any).projectId;
      await supabase.from("projects").update({ is_active: false }).neq("id", projectId);
      const { data, error } = await supabase
        .from("projects")
        .update({ is_active: true })
        .eq("id", projectId)
        .select()
        .single();
      if (error) throw new Error(error.message);
      return { content: [{ type: "text", text: `Projeto ${data.name} ativado com sucesso.` }] };
    }

    if (name === "get_project_context") {
      const project = await getActiveProject();
      if (!project) throw new Error("Nenhum projeto ativo.");
      return {
        content: [{ type: "text", text: JSON.stringify({
          project: {
            id: project.id,
            name: project.name,
            github_repo: project.github_repo_full_name,
            active_branch: project.active_branch,
            supabase_project: project.supabase_project_ref
          },
          instructions: "Contexto base do projeto ativo recuperado do Supremo."
        }, null, 2) }],
      };
    }

    if (name === "read_github_file") {
      const project = await getActiveProject();
      if (!project) throw new Error("Nenhum projeto ativo.");
      const { octokit, owner, repo, branch } = await getGithubOctokit(project.id);
      
      const response = await octokit.repos.getContent({
        owner,
        repo,
        path: (args as any).path,
        ref: branch,
      });

      const data = response.data as any;
      if (data.type !== 'file' || !data.content) {
        throw new Error("Path is not a file or content is empty.");
      }

      const decoded = Buffer.from(data.content, 'base64').toString('utf8');
      return { content: [{ type: "text", text: decoded }] };
    }

    if (name === "write_github_files") {
      const project = await getActiveProject();
      if (!project) throw new Error("Nenhum projeto ativo.");
      const { octokit, owner, repo, branch } = await getGithubOctokit(project.id);
      
      const { message, files } = args as { message: string, files: Array<{path: string, content: string}> };
      
      // 1. Get branch ref
      const refRes = await octokit.git.getRef({ owner, repo, ref: `heads/${branch}` });
      const latestCommitSha = refRes.data.object.sha;
      
      // 2. Get latest commit
      const commitRes = await octokit.git.getCommit({ owner, repo, commit_sha: latestCommitSha });
      const baseTreeSha = commitRes.data.tree.sha;

      // 3. Create new tree
      const tree = files.map(f => ({
        path: f.path,
        mode: "100644" as const,
        type: "blob" as const,
        content: f.content
      }));

      const newTreeRes = await octokit.git.createTree({
        owner, repo,
        base_tree: baseTreeSha,
        tree
      });

      // 4. Create commit
      const newCommitRes = await octokit.git.createCommit({
        owner, repo,
        message,
        tree: newTreeRes.data.sha,
        parents: [latestCommitSha]
      });

      // 5. Update branch ref
      await octokit.git.updateRef({
        owner, repo,
        ref: `heads/${branch}`,
        sha: newCommitRes.data.sha
      });

      return { content: [{ type: "text", text: `✅ Commit criado com sucesso em ${branch}: ${message}` }] };
    }

    if (name === "run_test_pipeline") {
      const project = await getActiveProject();
      if (!project) throw new Error("Nenhum projeto ativo.");
      const { octokit, owner, repo, branch } = await getGithubOctokit(project.id);

      // Trigger repository dispatch for CI
      await octokit.repos.createDispatchEvent({
        owner, repo,
        event_type: 'trigger-ci'
      });

      return { content: [{ type: "text", text: `Pipeline CI disparado na branch ${branch}. Acompanhe no painel do GitHub Actions.` }] };
    }

    throw new McpError(ErrorCode.MethodNotFound, `Tool not found: ${name}`);
  } catch (error: any) {
    return {
      content: [{ type: "text", text: `Erro: ${error.message}` }],
      isError: true,
    };
  }
});

// Start the server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Supremo MCP Server is running via stdio");
}

main().catch(console.error);
