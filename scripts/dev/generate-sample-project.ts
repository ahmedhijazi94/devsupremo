/**
 * Gera um projeto a partir do template num diretório qualquer.
 *
 * Usado pelo teste de integração do scaffold: o único jeito honesto de
 * afirmar que o template compila é gerar e rodar os gates de verdade.
 *
 *   npx tsx scripts/dev/generate-sample-project.ts /caminho/de/saida
 */
import fs from 'node:fs'
import path from 'node:path'
import { buildProjectFiles } from '../../src/lib/templates/project-files'

const out = process.argv[2]
if (!out) {
  console.error('Uso: tsx scripts/dev/generate-sample-project.ts <diretório>')
  process.exit(1)
}

const kind = process.argv[3] ?? 'solo'
if (!['public', 'solo', 'team'].includes(kind)) throw new Error('Tipo inválido: public, solo ou team.')
const files = buildProjectFiles({
  kind: kind as 'public' | 'solo' | 'team',
  projectName: 'app-de-teste',
  description: 'Prova de que o template compila e passa nos próprios gates',
})

for (const file of files) {
  const full = path.join(out, file.path)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, file.content, {
    mode: file.mode === '100755' ? 0o755 : 0o644,
  })
}

console.log(`${files.length} arquivos gerados em ${out}`)
