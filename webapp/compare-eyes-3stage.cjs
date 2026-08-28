// 把 "修复前（黑块眼睛）"、"修复后（正常细节）" 两套图的眼睛区域做横向对比
const fs = require('fs')
const path = require('path')
const { createCanvas, loadImage } = require('canvas')

const outDir = path.join(__dirname, 'line-debug-output')

const beforePath = path.join(outDir, 'crop-export-step2-eyes.png')
const afterPreviewPath = path.join(outDir, 'crop-fixed-preview-eyes.png')
const afterExportPath = path.join(outDir, 'crop-export-afterFloor-eyes.png')

;(async () => {
  let before, afterPreview, afterExport
  try { before = await loadImage(beforePath) } catch (e) { console.error('load before failed:', e.message) }
  try { afterExport = await loadImage(afterExportPath) } catch (e) { console.error('load afterExport failed:', e.message) }
  try { afterPreview = await loadImage(afterPreviewPath) } catch (e) { console.error('load afterPreview failed:', e.message) }

  console.log('before:', before ? `${before.width}x${before.height}` : 'null')
  console.log('afterExport:', afterExport ? `${afterExport.width}x${afterExport.height}` : 'null')
  console.log('afterPreview:', afterPreview ? `${afterPreview.width}x${afterPreview.height}` : 'null')

  const cellW = 400
  const cellH = 400
  const margin = 10

  const totalW = cellW * 3 + margin * 4
  const totalH = cellH + 80

  const finalCanvas = createCanvas(totalW, totalH)
  const c = finalCanvas.getContext('2d')
  c.fillStyle = '#222'
  c.fillRect(0, 0, totalW, totalH)

  const items = [
    { label: '【修复前】 printSafe → 眼睛黑块', img: before },
    { label: '【修复后】 3MF mask (当前导出)', img: afterExport },
    { label: '【修复后】 预览位图', img: afterPreview },
  ]

  for (let i = 0; i < items.length; i++) {
    const it = items[i]
    const x = margin + i * (cellW + margin)
    c.fillStyle = '#fff'
    c.font = 'bold 24px sans-serif'
    c.fillText(it.label, x, 36)
    if (it.img) {
      const scale = Math.min(cellW / it.img.width, cellH / it.img.height) * 2 // 放大显示
      const w = it.img.width * scale
      const h = it.img.height * scale
      const drawX = x + (cellW - w) / 2
      const drawY = 60 + (cellH - h) / 2
      c.fillStyle = '#fff'
      c.fillRect(x, 60, cellW, cellH)
      c.drawImage(it.img, drawX, drawY, w, h)
    } else {
      c.fillStyle = '#999'
      c.font = '20px sans-serif'
      c.fillText('image missing', x + 10, 100)
    }
  }

  const outP = path.join(outDir, 'compare-eyes-3stage.png')
  fs.writeFileSync(outP, finalCanvas.toBuffer('image/png'))
  console.log('[OK] wrote', outP)
})().catch((e) => { console.error(e); process.exit(1) })
