const fs = require('fs');
let code = fs.readFileSync('src/actions/scaffold.ts', 'utf8');

// 1. Add import
code = code.replace(
  "import { getSecurityAuditScriptContent, getCiWorkflowContent, getPackageJsonContent, getVitestConfigContent, getPlaywrightConfigContent } from '@/lib/templates/project-files'",
  "import { getSecurityAuditScriptContent, getCiWorkflowContent, getPackageJsonContent, getVitestConfigContent, getPlaywrightConfigContent, getVercelJsonContent } from '@/lib/templates/project-files'"
);

// 2. Generate content
code = code.replace(
  "const playwrightConfig = getPlaywrightConfigContent()",
  "const playwrightConfig = getPlaywrightConfigContent()\n  const vercelJson = getVercelJsonContent()"
);

// 3. Add to tree
code = code.replace(
  "{ path: 'tsconfig.json'",
  "{ path: 'vercel.json', mode: '100644', type: 'blob', content: vercelJson },\n          { path: 'tsconfig.json'"
);

fs.writeFileSync('src/actions/scaffold.ts', code);
