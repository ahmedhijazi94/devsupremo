const fs = require('fs');
let code = fs.readFileSync('src/app/sandbox/page.tsx', 'utf8');

code = code.replace(
  "import { fetchGithubProjectTree } from '@/actions/github-tree'",
  "import { fetchGithubProjectTree } from '@/actions/github-tree'\nimport { getProjectEnvVars } from '@/actions/env-vars'"
);

const envLogic = `
        const envContent = await getProjectEnvVars(projectId!)
        if (envContent) {
          tree['.env.local'] = { file: { contents: envContent } }
        }
        
        log(\`Montando sistema de arquivos (\${Object.keys(tree).length} root items)...\`)
`;

code = code.replace(
  "log(`Montando sistema de arquivos (${Object.keys(tree).length} root items)...`)",
  envLogic
);

fs.writeFileSync('src/app/sandbox/page.tsx', code);
