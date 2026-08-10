export const FILMSTRIP_COLS = 5
export const FILMSTRIP_MAX_ROWS = 5
export const FILMSTRIP_CELL_SIZE = 512
const CONTENT_THRESHOLD = 240

export const AI_PROMPT_TEXT = `Convert the input image into a pristine, high-contrast black-and-white line art vectorization template. Strictly preserve the original pose, anatomical proportions, costume structures, and all intricate details without any creative redesign.

Line quality: Clean, professional anime key-animation style (Genga). Lines must be dynamic with subtle natural weight variations (thicker at intersections/corners, thinner at ends), but rendered as 100% opaque, solid black ink lines. Strictly prohibit pencil-like textures, grainy noise, hollow interiors, or broken strokes.

Cleanliness: Completely erase all rough sketches, construction grids, joint circles, overlapping drafts, and stray messy marks. Facial features must be delicate and soft; eyes detailed with refined lashes, expressing a natural, gentle emotion.

Technical specs for Vectorization: Pure matte white background (RGB 255,255,255). Zero shadows, zero grayscale, zero halftones, zero color saturation. Ensure extreme binary contrast (pure black vs. pure white). All primary outlines and internal folds must form closed, uninterrupted loops to allow seamless auto-tracing and infill path generation in 3D slicing software.`

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('图片解码失败'))
    image.src = dataUrl
  })
}

export function dataUrlToBlob(dataUrl: string): Blob {
  const [header, base64] = dataUrl.split(',')
  const mime = header.match(/:(.*?);/)?.[1] ?? 'image/png'
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i)
  }
  return new Blob([bytes], { type: mime })
}

export function dataUrlToFile(dataUrl: string, filename: string): File {
  const blob = dataUrlToBlob(dataUrl)
  return new File([blob], filename, { type: blob.type })
}

export function downloadDataUrl(dataUrl: string, filename: string) {
  const blob = dataUrlToBlob(dataUrl)
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(url)
}

export async function copyTextToClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text)
    return
  }
  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  document.body.appendChild(textarea)
  textarea.select()
  try {
    document.execCommand('copy')
  } finally {
    document.body.removeChild(textarea)
  }
}

/**
 * 将多张图片按顺序每行 5 张排列成胶卷图，最多 5×5=25 张，
 * 超出的写入下一张胶卷图。每格为正方形，图片等比缩放居中，白底。
 */
export async function mergeImagesToFilmstrip(
  dataUrls: string[],
  cellSize = FILMSTRIP_CELL_SIZE,
): Promise<string[]> {
  if (!dataUrls.length) return []
  const images = await Promise.all(dataUrls.map(loadImage))
  const maxPerSheet = FILMSTRIP_COLS * FILMSTRIP_MAX_ROWS
  const sheets: string[] = []

  for (let start = 0; start < images.length; start += maxPerSheet) {
    const chunk = images.slice(start, start + maxPerSheet)
    const rows = Math.ceil(chunk.length / FILMSTRIP_COLS)
    const canvas = document.createElement('canvas')
    canvas.width = FILMSTRIP_COLS * cellSize
    canvas.height = rows * cellSize
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('无法初始化画布')
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)

    chunk.forEach((img, index) => {
      const col = index % FILMSTRIP_COLS
      const row = Math.floor(index / FILMSTRIP_COLS)
      const cellX = col * cellSize
      const cellY = row * cellSize
      const scale = Math.min(cellSize / img.naturalWidth, cellSize / img.naturalHeight)
      const drawW = img.naturalWidth * scale
      const drawH = img.naturalHeight * scale
      ctx.drawImage(img, cellX + (cellSize - drawW) / 2, cellY + (cellSize - drawH) / 2, drawW, drawH)
    })

    sheets.push(canvas.toDataURL('image/png'))
  }

  return sheets
}

interface BoundingBox {
  x: number
  y: number
  width: number
  height: number
}

interface ContentRange {
  start: number
  end: number
}

/**
 * 找出连续的内容区间。
 * minGap：间隙小于此值的相邻区间会被合并（视为同一帧内部的留白）。
 * minRangeSize：宽度小于此值的区间被丢弃（视为细线噪点）。
 */
function findContentRanges(hasContent: Uint8Array, minGap: number, minRangeSize: number): ContentRange[] {
  const rawRanges: ContentRange[] = []
  let start = -1
  for (let i = 0; i < hasContent.length; i += 1) {
    if (hasContent[i] && start === -1) {
      start = i
    } else if (!hasContent[i] && start !== -1) {
      rawRanges.push({ start, end: i - 1 })
      start = -1
    }
  }
  if (start !== -1) {
    rawRanges.push({ start, end: hasContent.length - 1 })
  }

  if (!rawRanges.length) return []

  const merged: ContentRange[] = [{ start: rawRanges[0].start, end: rawRanges[0].end }]
  for (let i = 1; i < rawRanges.length; i += 1) {
    const prev = merged[merged.length - 1]
    const gap = rawRanges[i].start - prev.end - 1
    if (gap < minGap) {
      prev.end = rawRanges[i].end
    } else {
      merged.push({ start: rawRanges[i].start, end: rawRanges[i].end })
    }
  }

  return merged.filter((r) => r.end - r.start + 1 >= minRangeSize)
}

function findContentBoundingBox(imageData: ImageData): BoundingBox | null {
  const { data, width, height } = imageData
  let minX = width
  let minY = height
  let maxX = -1
  let maxY = -1

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4
      const alpha = data[i + 3]
      if (alpha === 0) continue
      if (data[i] < CONTENT_THRESHOLD || data[i + 1] < CONTENT_THRESHOLD || data[i + 2] < CONTENT_THRESHOLD) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }

  if (maxX < 0) return null

  const padding = 4
  const px = Math.max(0, minX - padding)
  const py = Math.max(0, minY - padding)
  const pw = Math.min(width, maxX + 1 + padding) - px
  const ph = Math.min(height, maxY + 1 + padding) - py
  return { x: px, y: py, width: pw, height: ph }
}

function cropToDataUrl(img: HTMLImageElement, x: number, y: number, w: number, h: number): string {
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) return ''
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, w, h)
  ctx.drawImage(img, x, y, w, h, 0, 0, w, h)
  return canvas.toDataURL('image/png')
}

function regionHasContent(data: Uint8ClampedArray, imgW: number, x: number, y: number, w: number, h: number): boolean {
  for (let py = y; py < y + h; py += 1) {
    const rowOffset = py * imgW
    for (let px = x; px < x + w; px += 1) {
      const i = (rowOffset + px) * 4
      if (data[i] < CONTENT_THRESHOLD || data[i + 1] < CONTENT_THRESHOLD || data[i + 2] < CONTENT_THRESHOLD) {
        return true
      }
    }
  }
  return false
}

/**
 * 将胶卷图自动裁剪回单张小图片。
 * 优先扫描白色间隙确定实际行列布局（合并帧内小间隙、过滤细线噪点），
 * 当图片无列间隙（内容铺满整行）时回退到 5 列网格方式。
 * 空格子跳过，返回裁剪后的 dataUrl 数组。
 */
export async function autoCropFilmstrip(
  dataUrl: string,
  cols = FILMSTRIP_COLS,
): Promise<string[]> {
  const img = await loadImage(dataUrl)
  const w = img.naturalWidth
  const h = img.naturalHeight

  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('无法初始化画布')
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, w, h)
  ctx.drawImage(img, 0, 0)

  const { data } = ctx.getImageData(0, 0, w, h)

  const colContent = new Uint8Array(w)
  const rowContent = new Uint8Array(h)
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const i = (y * w + x) * 4
      if (data[i] < CONTENT_THRESHOLD || data[i + 1] < CONTENT_THRESHOLD || data[i + 2] < CONTENT_THRESHOLD) {
        colContent[x] = 1
        rowContent[y] = 1
      }
    }
  }

  // 间隙阈值：图片维度的 1%（最少 4px），小于此值的间隙视为帧内留白合并
  // 区间最小尺寸：图片维度的 5%（最少 20px），小于此值的区间视为细线噪点丢弃
  const minColGap = Math.max(4, Math.floor(w * 0.01))
  const minRowGap = Math.max(4, Math.floor(h * 0.01))
  const minColWidth = Math.max(20, Math.floor(w * 0.05))
  const minRowHeight = Math.max(20, Math.floor(h * 0.05))

  const colRanges = findContentRanges(colContent, minColGap, minColWidth)
  const rowRanges = findContentRanges(rowContent, minRowGap, minRowHeight)
  const padding = 4

  // 有列间隙时用间隙切分；否则回退到固定列数网格
  if (colRanges.length > 1) {
    const results: string[] = []
    for (const rowR of rowRanges) {
      for (const colR of colRanges) {
        const x = Math.max(0, colR.start - padding)
        const y = Math.max(0, rowR.start - padding)
        const cw = Math.min(w, colR.end + 1 + padding) - x
        const ch = Math.min(h, rowR.end + 1 + padding) - y
        if (!regionHasContent(data, w, x, y, cw, ch)) continue
        const result = cropToDataUrl(img, x, y, cw, ch)
        if (result) results.push(result)
      }
    }
    if (results.length) return results
  }

  // 回退：固定列数网格
  const cellW = Math.floor(w / cols)
  if (cellW < 1) return []
  const cellH = cellW
  const rows = Math.ceil(h / cellH)
  const results: string[] = []

  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const cellX = col * cellW
      const cellY = row * cellH
      const cellWidth = Math.min(cellW, w - cellX)
      const cellHeight = Math.min(cellH, h - cellY)
      if (cellWidth < 1 || cellHeight < 1) continue
      const imageData = ctx.getImageData(cellX, cellY, cellWidth, cellHeight)
      const bbox = findContentBoundingBox(imageData)
      if (!bbox) continue
      const result = cropToDataUrl(img, cellX + bbox.x, cellY + bbox.y, bbox.width, bbox.height)
      if (result) results.push(result)
    }
  }

  return results
}
