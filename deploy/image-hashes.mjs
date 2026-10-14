import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'

const root = process.argv[2] || '/opt/studio/app/dist'
const files = ['index.html', ...readdirSync(join(root, 'assets'), { recursive: true }).filter(name => /\.(js|css)$/.test(name)).map(name => join('assets', name))]
console.log(JSON.stringify(Object.fromEntries(files.map(name => {
  const file = join(root, name)
  return ['/' + relative(root, file).replaceAll('\\', '/'), createHash('sha256').update(readFileSync(file)).digest('hex')]
}))))