import { describe, expect, it, beforeAll } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { JSDOM } from 'jsdom'

/**
 * 调试 3MF 与预览线宽不一致问题。
 *
 * 使用 _testimg.png（与用户提供的 ChatGPT 图同为 1685×934，feature 结构近似），
 * 用 jsdom + canvas 包注入真实的 DOM/Canvas/Image，
 * 让 generator.ts 的真实 processArtwork 流程能在 Node 里完整跑通。
 *
 * 然后导出：preview 的真实 SVG（rasterize Loops → trace → 平滑），
 * 以及 3MF 用的 rasterize mask（同样 polygons 在更低 pixelsPerMm 下重新 rasterize）。
 *
 * 两者都 dump 成 PNG 文件到 `./line-debug-output/`，
 * 肉眼比较线粗是否一致。
 */

interface VectorPoint { x: number; y: number }
interface VectorLoop { closed: boolean; points: VectorPoint[] }

interface ProcessedArtwork {
  lineLoops: VectorLoop[]
  baseLoops: VectorLoop[]
  boardWidthMm: number
  boardHeightMm: number
  pixelsPerMm: number
  previews: {
    lineartDataUrl: string
    baseplateDataUrl: string
    compositeDataUrl: string
  }
}

interface LineartSettings {
  detail: number
  threshold: number
  thresholdAuto: boolean
  targetColor: string
  despeckle: number
  expandStrokeMm: number
  shrinkStrokeMm: number
  smoothing: number
  invert: boolean
  mirror: boolean
  autoOptimize: boolean
  protectFineDetail: boolean
  uploadPreprocess: boolean
  bezierFitting: boolean
  bezierStrength: number
}

interface BaseplateSettings {
  template: 'rectangle' | 'outline'
  expandMm: number
  widthMm: number
  heightMm: number
  rectangleSizeMode: string
  rectangleScalePercent: number
  diameterMm: number
  marginMm: number
  imagePlacement: string
  lineColor: string
  baseColor: string
}

const realSettings = {
  detail: 100,
  threshold: 100,
  thresholdAuto: false,
  targetColor: '#000000',
  despeckle: 49,
  expandStrokeMm: 0,
  shrinkStrokeMm: 0,
  smoothing: 10,
  invert: false,
  mirror: false,
  autoOptimize: false,
  protectFineDetail: true,
  uploadPreprocess: true,
  bezierFitting: true,
  bezierStrength: 100,
} as const satisfies LineartSettings

// 用户图像（用 _testimg.png 因为它与 ChatGPT 图同为 1685x934）
const baseSettings = {
  template: 'rectangle',
  expandMm: 0,
  widthMm: 150,
  heightMm: 100,
  rectangleSizeMode: 'manual',
  rectangleScalePercent: 100,
  diameterMm: 150,
  marginMm: 0,
  imagePlacement: 'fit',
  lineColor: '#111111',
  baseColor: '#f3f6fb',
} as const satisfies BaseplateSettings

const extrudeSettings = {
  baseThicknessMm: 0.2,
  lineThicknessMm: 0.2,
  lineHeightMm: 0.2,
  minLineWidthMm: 0.4,
}

const printBedSettings = { widthMm: 256, depthMm: 256, spacingMm: 8 }

let dom: JSDOM
beforeAll(async () => {
  const html = `<!doctype html><html><body></body></html>`
  dom = new JSDOM(html, {
    pretendToBeVisual: true,
    Canvas: (await import('canvas')).createCanvas,
    Image: (await import('canvas')).Image,
  })
  // 让 generator 模块拿到 document / window
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(global as any).window = dom.window
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(global as any).document = dom.window.document
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(global as any).Image = (await import('canvas')).Image
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(global as any).navigator = dom.window.navigator
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(global as any).HTMLElement = dom.window.HTMLElement
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(global as any).HTMLCanvasElement = dom.window.HTMLCanvasElement
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(global as any).CanvasRenderingContext2D = (await import('canvas')).CanvasRenderingContext2D
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(global as any).createCanvas = (await import('canvas')).createCanvas
})

describe('real-image line width consistency', () => {
  it('runs the full pipeline on _testimg.png and dumps mask side-by-side', async () => {
    console.log('[timing] test start')
    const t0 = Date.now()
    const imgPath = path.resolve(process.cwd(), '..', '_testimg.png')
    const exists = await fs.access(imgPath).then(() => true).catch(() => false)
    if (!exists) {
      console.warn('[skip] image not found')
      return
    }
    const imgBuf = await fs.readFile(imgPath)
    const dataUrl = `data:image/png;base64,${imgBuf.toString('base64')}`
    const { processArtwork, chooseSingleExportPixelsPerMm } = await import('@/utils/generator')
    const sourceImage = { name: '_testimg.png', width: 1685, height: 934, dataUrl }
    const result = await processArtwork({
      sourceImage,
      importedLineart: null,
      lineartSettings: realSettings as LineartSettings,
      baseplateSettings: baseSettings,
      extrudeSettings: extrudeSettings as any,
      workMode: 'filigree',
    })
    const wMm = result.boardWidthMm
    const hMm = result.boardHeightMm
    const pxPreview = result.pixelsPerMm
    const pxExport = chooseSingleExportPixelsPerMm(result) as number
    console.log('[diag] board=', wMm, 'x', hMm, 'mm')
    console.log('[timing] processArtwork done', Date.now() - t0, 'ms')
    console.log('[diag] pixelsPerMm preview=', pxPreview, '  3MF=', pxExport)
    console.log('[diag] lineLoops count=', result.lineLoops.length)
    console.log('[diag] source pixelsPerMm (preview) =', pxPreview)

    // 直接 dump mask
    const outDir = path.resolve(process.cwd(), 'line-debug-output')
    await fs.mkdir(outDir, { recursive: true })

    // 直接复用 generator 的 rasterize 函数
    const { createCanvas } = await import('canvas')
    const rasterize = (loops: VectorLoop[], pxPerMm: number, scale = 1, dilateRadius = 0): Buffer => {
      const W = Math.max(1, Math.ceil(wMm * pxPerMm))
      const H = Math.max(1, Math.ceil(hMm * pxPerMm))
      const c = createCanvas(W * scale, H * scale)
      const ctx = c.getContext('2d') as any
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, W * scale, H * scale)
      ctx.fillStyle = '#000000'
      ctx.beginPath()
      loops.forEach((loop) => {
        const [first, ...rest] = loop.points
        if (!first) return
        ctx.moveTo(first.x * pxPerMm * scale, first.y * pxPerMm * scale)
        rest.forEach((p) => ctx.lineTo(p.x * pxPerMm * scale, p.y * pxPerMm * scale))
        ctx.closePath()
      })
      ctx.fill('nonzero')
      if (dilateRadius > 0) {
        const origData = ctx.getImageData(0, 0, W * scale, H * scale).data
        const out = ctx.createImageData(W * scale, H * scale)
        for (let y = 0; y < H * scale; y += 1) {
          for (let x = 0; x < W * scale; x += 1) {
            let filled = false
            for (let oy = -dilateRadius; oy <= dilateRadius && !filled; oy += 1) {
              const sy = y + oy
              if (sy < 0 || sy >= H * scale) continue
              for (let ox = -dilateRadius; ox <= dilateRadius; ox += 1) {
                const sx = x + ox
                if (sx < 0 || sx >= W * scale) continue
                if (ox * ox + oy * oy > dilateRadius * dilateRadius) continue
                const idx = (sy * (W * scale) + sx) * 4 + 3
                if (origData[idx] >= 8) { filled = true; break }
              }
            }
            const i = (y * (W * scale) + x) * 4
            if (filled) { out.data[i] = 0; out.data[i + 1] = 0; out.data[i + 2] = 0; out.data[i + 3] = 255 }
            else { out.data[i + 3] = 0 }
          }
        }
        ctx.putImageData(out, 0, 0)
      }
      return c.toBuffer('image/png')
    }

    // 0.24mm / pxPerMm = 物理半径（像素）
    const rPreview = Math.max(0, Math.ceil((0.4 * pxPreview - 1) * 0.5))
    const rExport = Math.max(0, Math.ceil((0.4 * pxExport - 1) * 0.5))
    console.log('[diag] applyMinimumLineWidth 半径 (像素): preview=', rPreview, '  3MF=', rExport)
    // 形态学后的物理直径 (mm): radius*2 / pxPerMm
    console.log('[diag] 保底直径 (mm): preview=', (rPreview * 2 / pxPreview).toFixed(3),
      '  3MF=', (rExport * 2 / pxExport).toFixed(3))

    await fs.writeFile(path.join(outDir, 'preview-mask.png'), rasterize(result.lineLoops, pxPreview, 1))
    await fs.writeFile(path.join(outDir, 'export-mask.png'), rasterize(result.lineLoops, pxExport, 1))
    await fs.writeFile(path.join(outDir, 'preview-mask-2x.png'), rasterize(result.lineLoops, pxPreview, 2))
    await fs.writeFile(path.join(outDir, 'export-mask-2x.png'), rasterize(result.lineLoops, pxExport, 2))

    // 模拟 extrudeMaskToMesh 中的保底膨胀：用软件版 dilate
    await fs.writeFile(path.join(outDir, 'preview-after-floor-2x.png'), rasterize(result.lineLoops, pxPreview, 2, rPreview))
    await fs.writeFile(path.join(outDir, 'export-after-floor-2x.png'), rasterize(result.lineLoops, pxExport, 2, rExport))

    // 模拟 expand：再加 1px 看效果（这其实就是 applyMinimumLineWidth 最少 1 像素的事实）
    await fs.writeFile(path.join(outDir, 'preview-after-floor-plus1-2x.png'), rasterize(result.lineLoops, pxPreview, 2, rPreview + 1))
    await fs.writeFile(path.join(outDir, 'export-after-floor-plus1-2x.png'), rasterize(result.lineLoops, pxExport, 2, rExport + 1))

    // 模拟 export 用 preview 的分辨率（消除 pxPerMm 差异）
    await fs.writeFile(path.join(outDir, 'export-at-preview-res.png'), rasterize(result.lineLoops, pxPreview, 1))
    await fs.writeFile(path.join(outDir, 'export-at-preview-res-after-floor.png'), rasterize(result.lineLoops, pxPreview, 1, rPreview + 1))

    // 关键诊断：纯光栅化（不开任何 morphology）的 mask 面积
    const pureRaster = (loops: VectorLoop[], pxPerMm: number): { mask: Uint8Array; W: number; H: number } => {
      const W = Math.max(1, Math.ceil(wMm * pxPerMm))
      const H = Math.max(1, Math.ceil(hMm * pxPerMm))
      const c = createCanvas(W, H)
      const ctx = c.getContext('2d') as any
      ctx.fillStyle = '#000000'
      ctx.beginPath()
      loops.forEach((loop) => {
        const [first, ...rest] = loop.points
        if (!first) return
        ctx.moveTo(first.x * pxPerMm, first.y * pxPerMm)
        rest.forEach((p) => ctx.lineTo(p.x * pxPerMm, p.y * pxPerMm))
        ctx.closePath()
      })
      ctx.fill('nonzero')
      const { data } = ctx.getImageData(0, 0, W, H)
      const mask = new Uint8Array(W * H)
      for (let i = 0; i < mask.length; i += 1) mask[i] = data[i * 4 + 3] >= 8 ? 1 : 0
      return { mask, W, H }
    }
    const previewPure = pureRaster(result.lineLoops, pxPreview)
    const exportPure = pureRaster(result.lineLoops, pxExport)
    const previewPureFill = Array.from(previewPure.mask).reduce((s, v) => s + v, 0)
    const exportPureFill = Array.from(exportPure.mask).reduce((s, v) => s + v, 0)
    console.log('[KEY DIAG] 纯光栅化（无 morphology）:',
      'preview=', previewPureFill, 'pixels =', (previewPureFill / (pxPreview * pxPreview)).toFixed(2), 'mm²',
      ' | 3MF=', exportPureFill, 'pixels =', (exportPureFill / (pxExport * pxExport)).toFixed(2), 'mm²')

    const dumpMaskInner = (mask: Uint8Array, W: number, H: number, scale = 1): Buffer => {
      const c2 = createCanvas(W * scale, H * scale)
      const ctx2 = c2.getContext('2d') as any
      ctx2.fillStyle = '#ffffff'
      ctx2.fillRect(0, 0, W * scale, H * scale)
      const img = ctx2.createImageData(W * scale, H * scale)
      for (let y = 0; y < H; y += 1) {
        for (let x = 0; x < W; x += 1) {
          if (!mask[y * W + x]) continue
          for (let sy = 0; sy < scale; sy += 1) {
            for (let sx = 0; sx < scale; sx += 1) {
              const idx = ((y * scale + sy) * (W * scale) + (x * scale + sx)) * 4
              img.data[idx] = 0; img.data[idx + 1] = 0; img.data[idx + 2] = 0; img.data[idx + 3] = 255
            }
          }
        }
      }
      ctx2.putImageData(img, 0, 0)
      return c2.toBuffer('image/png')
    }
    await fs.writeFile(path.join(outDir, 'pure-preview-2x.png'), dumpMaskInner(previewPure.mask, previewPure.W, previewPure.H, 2))
    await fs.writeFile(path.join(outDir, 'pure-export-2x.png'), dumpMaskInner(exportPure.mask, exportPure.W, exportPure.H, 2))

    // 模拟 3MF 最终 mask（extrudeMaskToMesh 全流程：shrink/expand + applyMinimumLineWidth）
    const simFinalMask = (loops: VectorLoop[], pxPerMm: number) => {
      const W = Math.max(1, Math.ceil(wMm * pxPerMm))
      const H = Math.max(1, Math.ceil(hMm * pxPerMm))
      const r = pureRaster(loops, pxPerMm)
      // 1. applyMinimumLineWidth（min 0.4mm）
      const minimumRadius = Math.max(0, Math.ceil((0.4 * pxPerMm - 1) * 0.5))
      const enforced = minimumRadius > 0 ? dilateLocal(r.mask, W, H, minimumRadius) : r.mask
      return { width: W, height: H, mask: enforced }
    }
    function dilateLocal(mask: Uint8Array, W: number, H: number, r: number) {
      if (r <= 0) return mask
      const out = new Uint8Array(mask.length)
      for (let y = 0; y < H; y += 1) {
        for (let x = 0; x < W; x += 1) {
          let f = 0
          for (let oy = -r; oy <= r && !f; oy += 1) {
            const sy = y + oy
            if (sy < 0 || sy >= H) continue
            for (let ox = -r; ox <= r; ox += 1) {
              const sx = x + ox
              if (sx < 0 || sx >= W) continue
              if (ox * ox + oy * oy > r * r) continue
              if (mask[sy * W + sx]) { f = 1; break }
            }
          }
          out[y * W + x] = f
        }
      }
      return out
    }
    const finalPreview = simFinalMask(result.lineLoops, pxPreview)
    const finalExport = simFinalMask(result.lineLoops, pxExport)

    const dumpMask = (mask: Uint8Array, W: number, H: number, scale = 1, color = '#000000'): Buffer => {
      const c = createCanvas(W * scale, H * scale)
      const ctx = c.getContext('2d') as any
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, W * scale, H * scale)
      const img = ctx.createImageData(W * scale, H * scale)
      for (let y = 0; y < H; y += 1) {
        for (let x = 0; x < W; x += 1) {
          if (!mask[y * W + x]) continue
          for (let sy = 0; sy < scale; sy += 1) {
            for (let sx = 0; sx < scale; sx += 1) {
              const idx = ((y * scale + sy) * (W * scale) + (x * scale + sx)) * 4
              img.data[idx] = 0; img.data[idx + 1] = 0; img.data[idx + 2] = 0; img.data[idx + 3] = 255
            }
          }
        }
      }
      ctx.putImageData(img, 0, 0)
      return c.toBuffer('image/png')
    }

    await fs.writeFile(path.join(outDir, 'sim-preview-afterFloor.png'), dumpMask(finalPreview.mask, finalPreview.width, finalPreview.height, 2))
    await fs.writeFile(path.join(outDir, 'sim-export-afterFloor.png'), dumpMask(finalExport.mask, finalExport.width, finalExport.height, 2))

    // 统计每步的填充像素数和有效直径
    const stats = (mask: Uint8Array, W: number, H: number, pxPerMm: number) => {
      let count = 0
      for (let i = 0; i < mask.length; i += 1) if (mask[i]) count += 1
      const mm2 = count / (pxPerMm * pxPerMm)
      // 假定没有边框；总 polygon 厚度粗略算 mm2 / canvas_width_mm
      return { count, mm2: mm2.toFixed(2), avgThicknessMm: (mm2 / wMm).toFixed(3) }
    }
    console.log('[diag] after floor (无 printSafe):',
      'preview=', stats(finalPreview.mask, finalPreview.width, finalPreview.height, pxPreview),
      '  3MF=', stats(finalExport.mask, finalExport.width, finalExport.height, pxExport))

    // ===== 修复验证：2D 预览位图 vs 3MF 最终 mask 的面积一致性 =====
    // processArtwork 修复后 previews.lineartDataUrl 渲染的是"打印等效位图"：
    // 预览（shapeLoopsForPrintPreview）与 3MF（extrudeMaskToMesh）自 2026-08-28 起
    // 共用同一条 buildExportLineMask 管线（光栅化 → 缩小/加粗描边 → 最小线宽），
    // 二者的 mask 必须**逐像素一致**。这里用真实的 buildExportLineMask 生成
    // "3MF 侧"掩码（不再用本测试自绘的 canvas 模拟——之前 21% 的差异正是
    // 模拟光栅化与真实管线取样方式不同造成的测试假象），再与预览位图对比填充面积。
    const previewSvg = decodeURIComponent(result.previews.lineartDataUrl.split(',')[1])
    const hrefMatch = previewSvg.match(/href="(data:image\/png;base64,[^"]+)"/)
    const previewPngB64 = hrefMatch?.[1].replace(/^data:image\/png;base64,/, '') ?? null

    // 用 node 自带 canvas（已注入到 JSDOM 的 canvas 包）解码 PNG
    const { Image } = await import('canvas')
    let previewBitFill = 0
    let previewBitW = 0
    let previewBitH = 0
    if (previewPngB64) {
      const imgBuf = Buffer.from(previewPngB64, 'base64')
      const img = new Image()
      // node-canvas Image 接受 buffer
      await new Promise<void>((resolveImg, rejectImg) => {
        img.onload = () => resolveImg()
        img.onerror = rejectImg
        img.src = imgBuf
      })
      previewBitW = img.width
      previewBitH = img.height
      const c = createCanvas(previewBitW, previewBitH)
      const ctx = c.getContext('2d') as any
      ctx.drawImage(img, 0, 0)
      const { data } = ctx.getImageData(0, 0, previewBitW, previewBitH)
      const bitMask = new Uint8Array(previewBitW * previewBitH)
      for (let i = 0; i < bitMask.length; i += 1) bitMask[i] = data[i * 4 + 3] > 8 ? 1 : 0
      previewBitFill = bitMask.reduce((s, v) => s + v, 0)
      // 把 PNG 的 mask 也 dump 出来，肉眼对照 3MF mask
      await fs.writeFile(
        path.join(outDir, 'fixed-preview-shape.png'),
        dumpMask(bitMask, previewBitW, previewBitH, 2),
      )
    }

    // 3MF 侧：直接调用真实的导出管线（与 extrudeMaskToMesh 内部完全一致）
    const { buildExportLineMask } = await import('@/utils/generator')
    const realExportMask = buildExportLineMask(
      result.lineLoops,
      wMm,
      hMm,
      pxExport,
      0.4, // minLineWidthMm（与 extrudeSettings 一致）
      0,   // expandStrokeMm（realSettings 为 0）
      0,   // shrinkStrokeMm（realSettings 为 0）
    )
    const finalExportFill = Array.from(realExportMask.mask).reduce((s, v) => s + v, 0)

    const previewBitPxPerMm = previewBitW / wMm
    const diffPct = finalExportFill === 0
      ? 100
      : (100 * Math.abs(previewBitFill - finalExportFill) / finalExportFill)
    console.log('[KEY FIX] 预览位图尺寸=', previewBitW, 'x', previewBitH,
      `(${previewBitPxPerMm.toFixed(2)} px/mm) `,
      '填充像素=', previewBitFill,
      '=', (previewBitFill / (previewBitPxPerMm * previewBitPxPerMm)).toFixed(2), 'mm²',
      ' | 3MF真实管线mask=', (finalExportFill / (pxExport * pxExport)).toFixed(2), 'mm²',
      ' | 差异=', diffPct.toFixed(2) + '%')
    // 预览与 3MF 共用同一条管线 → 差异必须为 0（允许 0.01% 的解码圆整余量）
    expect(diffPct).toBeLessThan(0.01)
    // 尺寸也必须一致
    expect(previewBitW).toBe(realExportMask.width)
    expect(previewBitH).toBe(realExportMask.height)
    expect(previewBitW).toBeGreaterThan(0)
    expect(previewBitH).toBeGreaterThan(0)

    console.log('[ok] dumped masks to', outDir)
    expect(result.lineLoops.length).toBeGreaterThan(0)
  }, 300_000)
})
