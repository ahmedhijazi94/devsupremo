const fs = require('fs');
let code = fs.readFileSync('src/app/sandbox/page.tsx', 'utf8');
code = code.replace("export default function SandboxPage() {", "import { Suspense } from 'react'\n\nfunction SandboxContent() {");
code += "\n\nexport default function SandboxPage() {\n  return (\n    <Suspense fallback={<div className=\"p-4\">Loading Sandbox...</div>}>\n      <SandboxContent />\n    </Suspense>\n  )\n}\n";
fs.writeFileSync('src/app/sandbox/page.tsx', code);
