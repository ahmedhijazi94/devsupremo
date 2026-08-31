#!/usr/bin/env node
"use strict";

// src/index.ts
var import_node_readline = require("node:readline");
var endpoint = process.env.SUPREMO_URL;
var token = process.env.SUPREMO_TOKEN;
function logStderr(message) {
  process.stderr.write(`[supremo] ${message}
`);
}
if (!endpoint) {
  logStderr(
    "SUPREMO_URL n\xE3o definido. Copie a URL do MCP em /mcps (ex.: https://SEU-APP.vercel.app/api/mcp) e exporte antes de rodar a ponte."
  );
  process.exit(1);
}
if (!token) {
  logStderr(
    "SUPREMO_TOKEN n\xE3o definido. Gere um token em /mcps e exporte-o antes de rodar a ponte."
  );
  process.exit(1);
}
function protocolError(id, code, message) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}
function write(payload) {
  process.stdout.write(`${JSON.stringify(payload)}
`);
}
async function forward(message) {
  const id = message.id;
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify(message)
    });
    if (id === void 0) return;
    if (response.status === 401) {
      write(
        protocolError(
          id,
          -32001,
          "Token do Supremo inv\xE1lido, revogado ou expirado. Gere outro em /mcps."
        )
      );
      return;
    }
    const body = await response.text();
    if (!response.ok) {
      write(
        protocolError(
          id,
          -32603,
          `Supremo respondeu ${response.status}: ${body.slice(0, 400)}`
        )
      );
      return;
    }
    if (!body.trim()) return;
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("text/event-stream")) {
      for (const line of body.split("\n")) {
        const trimmed = line.trim();
        if (trimmed.startsWith("data:")) {
          const data = trimmed.slice(5).trim();
          if (data) process.stdout.write(`${data}
`);
        }
      }
      return;
    }
    process.stdout.write(`${body.trim()}
`);
  } catch (error) {
    if (id === void 0) return;
    const detail = error instanceof Error ? error.message : typeof error === "string" ? error : JSON.stringify(error);
    write(protocolError(id, -32603, `Falha ao falar com o Supremo em ${endpoint}: ${detail}`));
  }
}
function main() {
  const rl = (0, import_node_readline.createInterface)({ input: process.stdin, terminal: false });
  let queue = Promise.resolve();
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let message;
    try {
      message = JSON.parse(trimmed);
    } catch {
      write(protocolError(null, -32700, "JSON inv\xE1lido recebido via stdin."));
      return;
    }
    queue = queue.then(() => forward(message));
  });
  rl.on("close", () => {
    void queue.then(() => process.exit(0));
  });
  logStderr(`ponte ativa \u2192 ${endpoint}`);
}
main();
