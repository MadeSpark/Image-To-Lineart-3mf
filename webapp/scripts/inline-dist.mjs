import fs from 'node:fs'
import path from 'node:path'

const rootDir = process.cwd()
const distDir = path.join(rootDir, 'dist')
const indexPath = path.join(distDir, 'index.html')

if (!fs.existsSync(indexPath)) {
  throw new Error(`找不到构建结果：${indexPath}`)
}

let html = fs.readFileSync(indexPath, 'utf8')

html = html.replace(/<link rel="icon"[^>]*>/i, '')

html = html.replace(
  /<link rel="stylesheet"[^>]*href="\.\/([^"]+)"[^>]*>/i,
  (_, assetPath) => {
    const cssPath = path.join(distDir, assetPath.replaceAll('/', path.sep))
    const css = fs.readFileSync(cssPath, 'utf8')
    return `<style>\n${css}\n</style>`
  },
)

html = html.replace(
  /<script type="module" crossorigin src="\.\/([^"]+)"><\/script>/i,
  (_, assetPath) => {
    const scriptPath = path.join(distDir, assetPath.replaceAll('/', path.sep))
    const script = fs.readFileSync(scriptPath, 'utf8')
    return `<script type="module">\n${script}\n</script>`
  },
)

fs.writeFileSync(indexPath, html, 'utf8')
console.log(`已内联 dist 资源到单文件：${indexPath}`)
