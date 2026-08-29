const fs = require('fs');
let code = fs.readFileSync('src/app/sandbox/page.tsx', 'utf8');

code = code.replace(
  "log('Montando sistema de arquivos...')\n        await webcontainerInstance.mount(tree)",
  "log(`Montando sistema de arquivos (${Object.keys(tree).length} root items)...`)\n        await webcontainerInstance.mount(tree)"
);

fs.writeFileSync('src/app/sandbox/page.tsx', code);
