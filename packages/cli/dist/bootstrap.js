// src/bootstrap.ts
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
function buildEnvFile(env) {
  return Object.entries(env).map(([k, v]) => `${k}=${v}`).join("\n") + "\n";
}
function targetDir(repoFullName, baseDir) {
  const name = repoFullName.split("/").pop() || "projeto";
  return path.join(baseDir ?? path.join(os.homedir(), "Supremo"), name);
}
function cleanRemoteUrl(repoFullName) {
  return `https://github.com/${repoFullName}.git`;
}
function gitCloneArgs(repoFullName, branch, dest) {
  const helper = `!f() { test "$1" = get && printf 'username=x-access-token\\npassword=%s\\n' "$SUPREMO_GIT_TOKEN"; }; f`;
  return [
    "-c",
    "credential.helper=",
    "-c",
    `credential.helper=${helper}`,
    "clone",
    "--branch",
    branch,
    cleanRemoteUrl(repoFullName),
    dest
  ];
}
var sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function startDeviceFlow(baseUrl, projectId) {
  const res = await fetch(`${baseUrl}/api/bootstrap/device/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ projectId })
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error ?? `N\xE3o iniciou o bootstrap (${res.status}).`);
  }
  return await res.json();
}
async function pollForConfig(baseUrl, deviceCode, intervalSec, expiresAt) {
  const deadline = Date.parse(expiresAt);
  while (Date.now() < deadline) {
    await sleep(intervalSec * 1e3);
    const res = await fetch(`${baseUrl}/api/bootstrap/device/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deviceCode })
    });
    const data = await res.json().catch(() => ({}));
    if (data.status === "ready" && data.config) return data.config;
    if (data.status === "pending") continue;
    if (data.status === "expired") throw new Error("Autoriza\xE7\xE3o expirou.");
    if (data.status === "denied") throw new Error("Autoriza\xE7\xE3o negada.");
    if (data.status === "error") throw new Error(data.error ?? "Falha no bootstrap.");
    throw new Error("Autoriza\xE7\xE3o inv\xE1lida. Rode o comando de novo.");
  }
  throw new Error("Tempo de autoriza\xE7\xE3o esgotado.");
}
var run = (cmd, args, cwd, env) => execFileSync(cmd, args, { cwd, env, stdio: "inherit" });
var ok = (label) => console.log(`\u2713 ${label}`);
async function runBootstrap(opts) {
  const baseUrl = opts.url.replace(/\/$/, "");
  console.log("\nSupremo Bootstrap\n");
  const flow = await startDeviceFlow(baseUrl, opts.projectId);
  console.log("Abra este link no navegador para autorizar esta m\xE1quina:\n");
  console.log(`  ${flow.verificationUriComplete}`);
  console.log(`
  C\xF3digo: ${flow.userCode}
`);
  console.log("Aguardando autoriza\xE7\xE3o\u2026");
  const config = await pollForConfig(
    baseUrl,
    flow.deviceCode,
    flow.intervalSec,
    flow.expiresAt
  );
  ok("Autoriza\xE7\xE3o concedida");
  ok(`Projeto: ${config.project.name}`);
  const dest = targetDir(config.repo.fullName, opts.dir);
  if (fs.existsSync(dest)) {
    throw new Error(`J\xE1 existe ${dest} \u2014 remova ou use --dir para outro caminho.`);
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  run("git", gitCloneArgs(config.repo.fullName, config.repo.branch, dest), void 0, {
    ...process.env,
    SUPREMO_GIT_TOKEN: config.gitToken
  });
  ok(`Repository clonado (token ${config.gitTokenScope}, ef\xEAmero)`);
  fs.writeFileSync(path.join(dest, ".env.local"), buildEnvFile(config.env), {
    mode: 384
  });
  ok(
    `Environment configurado (${Object.keys(config.env).length} vari\xE1vel(is) p\xFAblica(s))`
  );
  run("npm", ["ci"], dest);
  ok("Depend\xEAncias instaladas");
  try {
    run("npm", ["run", "setup:local"], dest);
    ok("Setup local + baseline");
  } catch {
    console.log('\u2022 setup:local pulado (rode "npm run setup:local" manualmente)');
  }
  console.log(`
Projeto pronto:

  ${dest}
`);
  if (opts.start) {
    console.log("Iniciando o dev server (Ctrl+C para sair)\u2026\n");
    run("npm", ["run", "dev"], dest);
  } else {
    console.log(`Agora:

  cd ${dest}
  npm run dev
`);
  }
}
export {
  buildEnvFile,
  cleanRemoteUrl,
  gitCloneArgs,
  runBootstrap,
  targetDir
};
