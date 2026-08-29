const fs = require('fs');
let code = fs.readFileSync('src/actions/github-tree.ts', 'utf8');
code = code.replace(
  "const tokenHex = (Array.isArray(project.github_accounts) ? project.github_accounts[0] : project.github_accounts).access_token_encrypted as string",
  "const acc = (Array.isArray(project.github_accounts) ? project.github_accounts[0] : project.github_accounts) as any;\n  const tokenHex = acc.access_token_encrypted as string;"
);
fs.writeFileSync('src/actions/github-tree.ts', code);
