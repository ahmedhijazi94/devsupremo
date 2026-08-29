const fs = require('fs');
let code = fs.readFileSync('src/app/sandbox/page.tsx', 'utf8');

const fix = `
let webcontainerInstance: WebContainer | null = null
let bootPromise: Promise<WebContainer> | null = null
`;

code = code.replace(
  "let webcontainerInstance: WebContainer | null = null",
  fix
);

const bootLogic = `
        if (!webcontainerInstance) {
          if (!bootPromise) {
            log('Iniciando Máquina Virtual no Navegador...')
            bootPromise = WebContainer.boot()
          } else {
            log('Aguardando inicialização prévia...')
          }
          webcontainerInstance = await bootPromise
        }
`;

code = code.replace(
  `        if (!webcontainerInstance) {
          log('Iniciando Máquina Virtual no Navegador...')
          webcontainerInstance = await WebContainer.boot()
        }`,
  bootLogic
);

// We should also wrap the return with a div that fills the screen since we deleted layout.tsx
// But it's an iframe in PreviewPanel which sets height. We just need h-screen.
code = code.replace(
  '<div className="flex flex-col h-full w-full">',
  '<div className="flex flex-col h-screen w-full bg-white">'
);
code = code.replace(
  '<div className="flex flex-col h-full bg-red-50 text-red-600 p-8 font-mono text-sm">',
  '<div className="flex flex-col h-screen bg-red-50 text-red-600 p-8 font-mono text-sm">'
);

fs.writeFileSync('src/app/sandbox/page.tsx', code);
