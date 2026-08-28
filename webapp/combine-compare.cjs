/**
 * 把两张 PNG 上下拼接，便于肉眼对照"3MF 切片" vs "2D 预览"。
 * 用法: node combine-compare.cjs <3mf-mask.png> <preview.png> <out.png>
 */
const { createCanvas, loadImage } = require('canvas')
const fs = require('node:fs')

async function main() {
  const [, , a, b, out] = process.argv
  if (!a || !b || !out) {
    console.error('usage: node combine-compare.cjs <a> <b> <out>')
    process.exit(2)
  }
  const [imgA, imgB] = await Promise.all([loadImage(a), loadImage(b)])
  const W = Math.max(imgA.width, imgB.width)
  const rowH = imgA.height + imgB.height + 60
  const c = createCanvas(W, rowH)
  const ctx = c.getContext('2d')
  ctx.fillStyle = '#f4f4f4'
  ctx.fillRect(0, 0, W, rowH)
  ctx.fillStyle = '#222'
  ctx.font = '18px sans-serif'
  ctx.fillText('3MF mask (extrudeMaskToMesh)', 12, 28)
  ctx.drawImage(imgA, 0, 40)
  ctx.fillText('Preview bitmap (new, embedded in SVG)', 12, imgA.height + 58)
  ctx.drawImage(imgB, 0, imgA.height + 70)
  fs.writeFileSync(out, c.toBuffer('image/png'))
  console.log('wrote', out)
}

main().catch((err) => { console.error(err); process.exit(1) })