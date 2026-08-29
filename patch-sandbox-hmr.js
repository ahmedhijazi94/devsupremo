const fs = require('fs');
let code = fs.readFileSync('src/app/sandbox/page.tsx', 'utf8');

// 1. Add new imports
code = code.replace(
  "import { fetchGithubProjectTree } from '@/actions/github-tree'",
  "import { fetchGithubProjectTree } from '@/actions/github-tree'\nimport { getLatestCommitSha, getChangedFilesContent } from '@/actions/github-sync'"
);

// 2. Add HMR tracking variables
const hmrVars = `
  const [url, setUrl] = useState<string | null>(null)
  const currentSha = useRef<string | null>(null)
  const isSyncing = useRef(false)
`;
code = code.replace("const [url, setUrl] = useState<string | null>(null)", hmrVars);

// 3. Capture initial SHA
const captureSha = `
        log('Conectando ao GitHub (Buscando código seguro)...')
        currentSha.current = await getLatestCommitSha(projectId!)
        const tree = await fetchGithubProjectTree(projectId!)
`;
code = code.replace(
  `        log('Conectando ao GitHub (Buscando código seguro)...')
        const tree = await fetchGithubProjectTree(projectId!)`,
  captureSha
);

// 4. Setup polling after server-ready
const pollingLogic = `
        webcontainerInstance.on('server-ready', (port, previewUrl) => {
          log('✅ Servidor Online! HMR Ativado.')
          setUrl(previewUrl)
          
          // Iniciar HMR Polling
          setInterval(async () => {
            if (isSyncing.current || !currentSha.current || !webcontainerInstance) return
            isSyncing.current = true
            try {
              const latestSha = await getLatestCommitSha(projectId!)
              if (latestSha !== currentSha.current) {
                terminal.current?.writeln('\\x1b[1;33m[Supremo HMR]\\x1b[0m Detectado novo commit. Sincronizando...')
                const changedFiles = await getChangedFilesContent(projectId!, currentSha.current, latestSha)
                
                for (const file of changedFiles) {
                  if (file.status === 'removed') {
                    await webcontainerInstance.fs.rm(file.path, { force: true })
                    terminal.current?.writeln('\\x1b[1;31m[Supremo HMR]\\x1b[0m Apagou ' + file.path)
                  } else {
                    // Make sure directory exists
                    const dir = file.path.split('/').slice(0, -1).join('/')
                    if (dir) {
                      await webcontainerInstance.fs.mkdir(dir, { recursive: true })
                    }
                    await webcontainerInstance.fs.writeFile(file.path, file.content)
                    terminal.current?.writeln('\\x1b[1;32m[Supremo HMR]\\x1b[0m Atualizou ' + file.path)
                  }
                }
                currentSha.current = latestSha
              }
            } catch (e) {
              console.error('HMR Sync Error:', e)
            } finally {
              isSyncing.current = false
            }
          }, 3000)
        })
`;
code = code.replace(
  `        webcontainerInstance.on('server-ready', (port, previewUrl) => {
          log('✅ Servidor Online!')
          setUrl(previewUrl)
        })`,
  pollingLogic
);

fs.writeFileSync('src/app/sandbox/page.tsx', code);
