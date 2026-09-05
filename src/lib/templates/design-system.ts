import fs from 'node:fs'
import path from 'node:path'
import type { FileEntry } from './project-files'

export function designSystemFiles(): FileEntry[] {
  const root = path.join(process.cwd(), 'src/lib/templates/assets/design')
  return fs.readdirSync(root, { recursive: true, encoding: 'utf8' })
    .filter((name) => name.endsWith('.txt')).sort().map((name) => ({
      path: name.slice(0, -4).split(path.sep).join('/'),
      content: fs.readFileSync(path.join(root, name), 'utf8'),
    }))
}
