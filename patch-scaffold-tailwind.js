const fs = require('fs');
let code = fs.readFileSync('src/actions/scaffold.ts', 'utf8');

// 1. Add imports
code = code.replace(
  "import { getSecurityAuditScriptContent, getCiWorkflowContent, getPackageJsonContent, getVitestConfigContent, getPlaywrightConfigContent, getVercelJsonContent } from '@/lib/templates/project-files'",
  "import { getSecurityAuditScriptContent, getCiWorkflowContent, getPackageJsonContent, getVitestConfigContent, getPlaywrightConfigContent, getVercelJsonContent, getTailwindConfigContent, getPostcssConfigContent, getGlobalsCssContent, getUtilsTsContent } from '@/lib/templates/project-files'"
);

// 2. Generate content
code = code.replace(
  "const vercelJson = getVercelJsonContent()",
  `const vercelJson = getVercelJsonContent()
  const tailwindConfig = getTailwindConfigContent()
  const postcssConfig = getPostcssConfigContent()
  const globalsCss = getGlobalsCssContent()
  const utilsTs = getUtilsTsContent()`
);

// 3. Add to tree
const nextFiles = `
          { path: 'tailwind.config.ts', mode: '100644', type: 'blob', content: tailwindConfig },
          { path: 'postcss.config.js', mode: '100644', type: 'blob', content: postcssConfig },
          { path: 'app/globals.css', mode: '100644', type: 'blob', content: globalsCss },
          { path: 'lib/utils.ts', mode: '100644', type: 'blob', content: utilsTs },
`;

code = code.replace(
  "{ path: 'app/layout.tsx'",
  nextFiles + "          { path: 'app/layout.tsx'"
);

// Also fix layout to import globals.css
code = code.replace(
  `content: "export default function RootLayout({ children }: { children: React.ReactNode }) { return ( <html lang='en'><body>{children}</body></html> ); }"`,
  `content: "import './globals.css';\\n\\nexport default function RootLayout({ children }: { children: React.ReactNode }) { return ( <html lang='en'><body>{children}</body></html> ); }"`
);

fs.writeFileSync('src/actions/scaffold.ts', code);
