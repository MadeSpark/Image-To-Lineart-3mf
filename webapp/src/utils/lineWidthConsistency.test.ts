import { describe, expect, it } from 'vitest'
import type { VectorLoop } from '@/types/generator'

/**
 * 调试 3MF 与预览线宽不一致问题。
 *
 * 关键问题：preview 和 3MF 都使用同一组 `artwork.lineLoops`，但 rasterize 时
 * 用了不同的 `pixelsPerMm`：
 *   - preview (finalizeLineLoops): `choosePixelsPerMm(boardW, boardH, detail)` —— detail=100, board=152mm → ~7 px/mm
 *   - 3MF       (extrudeMaskToMesh): `chooseSingleExportPixelsPerMm(artwork)` —— 4 项 min 时取 ~5 px/mm
 *
 * 同一 polygon 在更低分辨率下，每个像素面积更大，描边会被采样得"更厚"。
 * 同时 `applyMinimumLineWidth` 是按像素计算的，
 * 在更低分辨率下会被理解为物理上更细，从而强制 dilation 半径增大（绝对尺寸）。
 *
 * 同时，`dilateMask` 等形态学使用整数 radius，每个 radius 像素在不同分辨率下
 * 对应不同的物理尺寸。下面对比两组分辨率下的填充像素数。
 */

interface RasterResult {
  width: number
  height: number
  mask: Uint8Array
  fillRatio: number
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n))

function choosePixelsPerMmPreview(boardWidthMm: number, boardHeightMm: number, detail: number) {
  const desired = clamp(Math.round(5 + detail / 9), 6, 16)
  const maxAllowed = Math.max(4, Math.floor(1200 / Math.max(boardWidthMm, boardHeightMm, 1)))
  return clamp(Math.min(desired, maxAllowed), 4, 16)
}

function chooseSingleExportPixelsPerMm(boardWidthMm: number, boardHeightMm: number, sourcePixelsPerMm: number) {
  const pSrc = clamp(Math.max(sourcePixelsPerMm, 12), 10, 32)
  const longestSideMm = Math.max(boardWidthMm, boardHeightMm, 1)
  const areaMm = Math.max(boardWidthMm * boardHeightMm, 1)
  const byDimension = 960 / longestSideMm
  const byArea = Math.sqrt(420_000 / areaMm)
  return Math.max(1, Math.min(pSrc, byDimension, byArea))
}

/** 用 winding number 算法光栅化 loops（与 jsdom fallback 等同） */
function rasterizeLoops(
  loops: VectorLoop[],
  widthMm: number,
  heightMm: number,
  pixelsPerMm: number,
  paddingMm = 0,
): RasterResult {
  const width = Math.max(1, Math.ceil((widthMm + paddingMm * 2) * pixelsPerMm))
  const height = Math.max(1, Math.ceil((heightMm + paddingMm * 2) * pixelsPerMm))
  const mask = new Uint8Array(width * height)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const px = (x + 0.5) / pixelsPerMm - paddingMm
      const py = (y + 0.5) / pixelsPerMm - paddingMm
      let winding = 0
      for (const loop of loops) {
        winding += computeWindingNumber(px, py, loop.points)
      }
      if (winding !== 0) mask[y * width + x] = 1
    }
  }
  let filled = 0
  for (let i = 0; i < mask.length; i += 1) if (mask[i]) filled += 1
  return { width, height, mask, fillRatio: filled / mask.length }
}

function computeWindingNumber(px: number, py: number, points: VectorLoop['points']) {
  let wn = 0
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i]
    const b = points[(i + 1) % points.length]
    if (a.y <= py) {
      if (b.y > py) {
        const cross = (b.x - a.x) * (py - a.y) - (px - a.x) * (b.y - a.y)
        if (cross > 0) wn += 1
      }
    } else if (b.y < py) {
      const cross = (b.x - a.x) * (py - a.y) - (px - a.x) * (b.y - a.y)
      if (cross < 0) wn -= 1
    }
  }
  return wn
}

function dilateMask(mask: Uint8Array, width: number, height: number, radius: number) {
  if (radius <= 0) return mask.slice()
  const output = new Uint8Array(mask.length)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let filled = 0
      for (let offsetY = -radius; offsetY <= radius && !filled; offsetY += 1) {
        const sampleY = y + offsetY
        if (sampleY < 0 || sampleY >= height) continue
        for (let offsetX = -radius; offsetX <= radius; offsetX += 1) {
          const sampleX = x + offsetX
          if (sampleX < 0 || sampleX >= width) continue
          if (offsetX * offsetX + offsetY * offsetY > radius * radius) continue
          if (mask[sampleY * width + sampleX]) { filled = 1; break }
        }
      }
      output[y * width + x] = filled
    }
  }
  return output
}

function applyMinimumLineWidth(
  mask: Uint8Array,
  width: number,
  height: number,
  pixelsPerMm: number,
  minimumLineWidthMm: number,
) {
  if (minimumLineWidthMm <= 0) return mask
  const minimumRadius = Math.max(0, Math.ceil((minimumLineWidthMm * pixelsPerMm - 1) * 0.5))
  if (minimumRadius <= 0) return mask
  return dilateMask(mask, width, height, minimumRadius)
}

/** 一根穿过 152×84mm 板的水平细线（约 0.4mm 厚）模拟用户图像的线稿线条 */
function buildSingleThinLineAcrossBoard(thicknessMm = 0.4, boardWidthMm = 152, boardHeightMm = 84): VectorLoop[] {
  const cy = boardHeightMm / 2
  const half = thicknessMm / 2
  return [
    {
      closed: true,
      points: [
        { x: 0, y: cy - half },
        { x: boardWidthMm, y: cy - half },
        { x: boardWidthMm, y: cy + half },
        { x: 0, y: cy + half },
      ],
    },
  ]
}

describe('3MF vs preview line width consistency', () => {
  it('reports pixelsPerMm and physical minimum-line-width pixel-equivalent at both stages', () => {
    const boardW = 152, boardH = 84
    const detail = 100
    const previewPx = choosePixelsPerMmPreview(boardW, boardH, detail)
    const exportPx = chooseSingleExportPixelsPerMm(boardW, boardH, previewPx)

    console.log('[diag] pixelsPerMm: preview=', previewPx, '  3MF=', exportPx)
    expect(previewPx).toBeGreaterThan(exportPx)

    // 同样 minimumLineWidthMm=0.24 在两个分辨率下被强制 dilation 的物理半径
    const minLW = 0.24
    const rPreview = Math.max(0, Math.ceil((minLW * previewPx - 1) * 0.5))
    const rExport = Math.max(0, Math.ceil((minLW * exportPx - 1) * 0.5))
    console.log('[diag] applyMinimumLineWidth radius in mm:',
      'preview=', (rPreview / previewPx).toFixed(3),
      '  3MF=', (rExport / exportPx).toFixed(3))
  })

  it('同一 polygon 在两组分辨率下的填充像素数差异', () => {
    const boardW = 152, boardH = 84
    const detail = 100
    const previewPx = choosePixelsPerMmPreview(boardW, boardH, detail)
    const exportPx = chooseSingleExportPixelsPerMm(boardW, boardH, previewPx)

    // 0.4mm 细线
    const thinLine = buildSingleThinLineAcrossBoard(0.4, boardW, boardH)
    const previewMask = rasterizeLoops(thinLine, boardW, boardH, previewPx)
    const exportMask = rasterizeLoops(thinLine, boardW, boardH, exportPx)

    const previewFillMm2 = (previewMask.fillRatio) * boardW * boardH
    const exportFillMm2 = (exportMask.fillRatio) * boardW * boardH
    console.log('[diag] 单根 0.4mm 细线:',
      '\n  preview: pixels', previewMask.mask.reduce((s, v) => s + v, 0),
      ',  fillMm²=', previewFillMm2.toFixed(2),
      '\n  3MF:     pixels', exportMask.mask.reduce((s, v) => s + v, 0),
      ',  fillMm²=', exportFillMm2.toFixed(2))

    // 注意：填充区域理论 0.4mm × 152mm = 60.8 mm²。低分辨率下 0.4mm 细线栅格化
    // 量化误差大（preview 7px/mm 时 0.4mm ≈ 2.8px，ceil 取整后只有 2~3px），
    // 这里放宽到 30 mm² 容差承认量化误差，仅做诊断观察，不做强断言。
    expect(Math.abs(previewFillMm2 - 60.8)).toBeLessThan(30)
    expect(Math.abs(exportFillMm2 - 60.8)).toBeLessThan(30)
  })

  it('0.24mm floor 在低分辨率下把 0.2mm 原始线粗膨胀到接近 0.24mm 或更多', () => {
    const boardW = 152, boardH = 84
    const detail = 100
    const previewPx = choosePixelsPerMmPreview(boardW, boardH, detail)
    const exportPx = chooseSingleExportPixelsPerMm(boardW, boardH, previewPx)
    const minLW = 0.24

    // 0.2mm 原始线宽（实际线稿可能更细）
    const lin = buildSingleThinLineAcrossBoard(0.2, boardW, boardH)
    const previewRaw = rasterizeLoops(lin, boardW, boardH, previewPx)
    const exportRaw = rasterizeLoops(lin, boardW, boardH, exportPx)
    const previewEnforced = applyMinimumLineWidth(previewRaw.mask, previewRaw.width, previewRaw.height, previewPx, minLW)
    const exportEnforced = applyMinimumLineWidth(exportRaw.mask, exportRaw.width, exportRaw.height, exportPx, minLW)

    const previewAfterFill = previewEnforced.reduce((s, v) => s + v, 0) / previewEnforced.length
    const exportAfterFill = exportEnforced.reduce((s, v) => s + v, 0) / exportEnforced.length

    // 计算等效实际线宽 (假定线条跨整个板宽 152mm)
    const previewEffectiveMm = (previewAfterFill * boardW * boardH) / boardW
    const exportEffectiveMm = (exportAfterFill * boardW * boardH) / boardW
    console.log('[diag] 原始 0.2mm 线条 enforce 后实测线宽:',
      'preview=', previewEffectiveMm.toFixed(3), 'mm',
      ',  3MF=', exportEffectiveMm.toFixed(3), 'mm')
    // enforce 后两者都被拉到接近 minimumLineWidthMm=0.24mm 附近（再加 2*1px 物理半径），
    // 谁更粗取决于原始线条在栅格化时的像素取整，不一定有单调关系。仅做范围诊断。
    expect(Math.abs(previewEffectiveMm - exportEffectiveMm)).toBeLessThan(0.1)
  })

  it('极细线条在低分辨率下消失并被强制膨胀', () => {
    const boardW = 152, boardH = 84
    const detail = 100
    const previewPx = choosePixelsPerMmPreview(boardW, boardH, detail)
    const exportPx = chooseSingleExportPixelsPerMm(boardW, boardH, previewPx)

    // 模拟一个宽度 0.07mm 的"hairline"（远小于 0.24mm 保底）
    const hairline = buildSingleThinLineAcrossBoard(0.07, boardW, boardH)
    const previewRaw = rasterizeLoops(hairline, boardW, boardH, previewPx)
    const exportRaw = rasterizeLoops(hairline, boardW, boardH, exportPx)

    const previewPxCount = previewRaw.mask.reduce((s, v) => s + v, 0)
    const exportPxCount = exportRaw.mask.reduce((s, v) => s + v, 0)
    console.log('[diag] 0.07mm hairline raster pixels:',
      'preview=', previewPxCount, '  3MF=', exportPxCount)
  })
})
