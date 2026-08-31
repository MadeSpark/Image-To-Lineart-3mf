import fs from 'node:fs'
import path from 'node:path'

const rootDir = process.cwd()
const distDir = path.join(rootDir, 'dist')
const indexPath = path.join(distDir, 'index.html')

if (!fs.existsSync(indexPath)) {
  throw new Error(`找不到构建结果：${indexPath}`)
}

let html = fs.readFileSync(indexPath, 'utf8')

// 兜底：若入口模板重新引入 favicon link，也把它去掉（单文件不留外链）
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

// 2026-09-01：内联完成后清理 dist 中的所有散件（assets/、残留 map、favicon 等），
// 最终产物 = 仅一个可双击离线打开的 index.html。
// 前提：vite.config 已开 inlineDynamicImports（懒加载块合并）、worker 用 ?worker&inline、
// 预设 3MF 用 ?inline —— 这三者保证没有运行时外部文件依赖。
for (const entry of fs.readdirSync(distDir)) {
  if (entry === 'index.html') continue
  fs.rmSync(path.join(distDir, entry), { recursive: true, force: true })
}

console.log(`已内联 dist 资源到单文件：${indexPath}`)
