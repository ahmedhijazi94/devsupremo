const fs = require('fs');
let code = fs.readFileSync('src/actions/scaffold.ts', 'utf8');

// 1. Add imports
code = code.replace(
  "import { getSecurityAuditScriptContent, getCiWorkflowContent, getPackageJsonContent, getVitestConfigContent, getPlaywrightConfigContent, getVercelJsonContent, getTailwindConfigContent, getPostcssConfigContent, getGlobalsCssContent, getUtilsTsContent } from '@/lib/templates/project-files'",
  "import { getSecurityAuditScriptContent, getCiWorkflowContent, getPackageJsonContent, getVitestConfigContent, getPlaywrightConfigContent, getVercelJsonContent, getTailwindConfigContent, getPostcssConfigContent, getGlobalsCssContent, getUtilsTsContent, getSupabaseClientContent, getSupabaseServerContent, getSupabaseMiddlewareContent, getNextMiddlewareContent } from '@/lib/templates/project-files'"
);

// 2. Generate content
code = code.replace(
  "const utilsTs = getUtilsTsContent()",
  `const utilsTs = getUtilsTsContent()
  const sbClient = getSupabaseClientContent()
  const sbServer = getSupabaseServerContent()
  const sbMiddleware = getSupabaseMiddlewareContent()
  const nextMiddleware = getNextMiddlewareContent()`
);

// 3. Add to tree
const nextFiles = `
          { path: 'lib/supabase/client.ts', mode: '100644', type: 'blob', content: sbClient },
          { path: 'lib/supabase/server.ts', mode: '100644', type: 'blob', content: sbServer },
          { path: 'lib/supabase/middleware.ts', mode: '100644', type: 'blob', content: sbMiddleware },
          { path: 'middleware.ts', mode: '100644', type: 'blob', content: nextMiddleware },
`;

code = code.replace(
  "{ path: 'app/layout.tsx'",
  nextFiles + "          { path: 'app/layout.tsx'"
);

fs.writeFileSync('src/actions/scaffold.ts', code);
