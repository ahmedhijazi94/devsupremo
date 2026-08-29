const fs = require('fs');
let code = fs.readFileSync('src/actions/scaffold.ts', 'utf8');

const cronContent = `import { NextResponse } from 'next/server'\\n\\nexport async function GET(request: Request) {\\n  const authHeader = request.headers.get('authorization')\\n  if (authHeader !== \`Bearer \${process.env.CRON_SECRET}\`) {\\n    return new NextResponse('Unauthorized', { status: 401 })\\n  }\\n\\n  console.log('Executando tarefa de CRON...')\\n  return NextResponse.json({ success: true })\\n}`;

const replaceStr = "{ path: 'app/layout.tsx'";
const newStr = `{ path: 'app/api/cron/route.ts', mode: '100644', type: 'blob', content: "${cronContent}" },\n          { path: 'app/layout.tsx'`;

code = code.replace(replaceStr, newStr);

fs.writeFileSync('src/actions/scaffold.ts', code);
