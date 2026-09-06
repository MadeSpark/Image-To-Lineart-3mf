import type { ProcessedArtwork, SourceImage, StringArtData, StringArtSettings, VectorLoop, VectorPoint } from '@/types/generator'
import { clamp } from './color'

const SAMPLE_SIDE = 160
const STRING_ART_ANCHOR_COUNT = 160
const STRING_ART_CHORDS_PER_LAYER = 28
const STRING_ART_MINIMUM_GAP = 6
const STRING_ART_LINE_STRENGTH = 0.18
// The supplied, successfully sliced 3MF uses a 2 mm annular frame. Keeping
// this independent of the nozzle width gives strand ends a stable landing area.
const STRING_ART_WALL_THICKNESS_MM = 2
const MIN_STRAND_SEPARATION_FACTOR = 2.5

/**
 * Anchor placement is adapted directly from the MIT-licensed `getNailPositions`
 * in github.com/omar-abdelgawad/string-art-app (Copyright 2024 Omar Abdelgawad).
 * The residual scoring approach follows the MIT-licensed StringArt.jl project
 * by neumann-mlucas, adapted here for a browser-side grayscale raster.
 */
export function getStringArtAnchorPositions(count: number, boardWidthMm: number, boardHeightMm: number, radiusMm: number): VectorPoint[] {
  const centerX = boardWidthMm / 2
  const centerY = boardHeightMm / 2
  const radiusX = Math.min(Math.max(1, radiusMm), boardWidthMm / 2)
  const radiusY = Math.min(Math.max(1, radiusMm), boardHeightMm / 2)
  const anchors: VectorPoint[] = []
  for (let index = 0; index < count; index += 1) {
    const angle = (2 * Math.PI * index) / count - Math.PI / 2
    anchors.push({ x: centerX + radiusX * Math.cos(angle), y: centerY + radiusY * Math.sin(angle) })
  }
  return anchors
}

export function chooseStringArtChords(darkness: Float32Array, width: number, height: number, anchors: VectorPoint[], layerCount: number, minimumSeparationMm: number): { chords: Array<[number, number]>; layerChordCounts: number[] } {
  const residual = darkness.slice()
  const bounds = anchorsBounds(anchors)
  const anchorPixels = anchors.map((anchor) => ({ x: (anchor.x - bounds.minX) / bounds.width * (width - 1), y: (anchor.y - bounds.minY) / bounds.height * (height - 1) }))
  const candidates: Array<[number, number]> = []
  let current = 0
  const minimumGap = Math.min(STRING_ART_MINIMUM_GAP, Math.floor(anchors.length / 2) - 1)
  const candidateCount = layerCount * STRING_ART_CHORDS_PER_LAYER * 2

  for (let step = 0; step < candidateCount; step += 1) {
    let best = -1
    let bestScore = 0
    for (let candidate = 0; candidate < anchors.length; candidate += 1) {
      const circularGap = Math.min(Math.abs(candidate - current), anchors.length - Math.abs(candidate - current))
      if (candidate === current || circularGap < minimumGap) continue
      const score = scoreChord(residual, width, height, anchorPixels[current], anchorPixels[candidate])
      if (score > bestScore) {
        bestScore = score
        best = candidate
      }
    }
    if (best < 0 || bestScore <= 0.00001) break
    applyChord(residual, width, height, anchorPixels[current], anchorPixels[best], STRING_ART_LINE_STRENGTH)
    candidates.push([current, best])
    current = best
  }
  return distributeNonCrossingChords(candidates, anchors, layerCount, minimumSeparationMm)
}

export async function processStringArtArtwork(sourceImage: SourceImage, settings: StringArtSettings, strandWidthMm: number, layerHeightMm: number): Promise<ProcessedArtwork> {
  const { boardWidthMm, boardHeightMm, baseLoops } = getStringArtBoard(settings)
  const anchors = getStringArtAnchorPositions(
    STRING_ART_ANCHOR_COUNT,
    boardWidthMm,
    boardHeightMm,
    getStringArtEndpointRadius(settings.radiusMm, strandWidthMm),
  )
  const darkness = await readDarkness(sourceImage, SAMPLE_SIDE, SAMPLE_SIDE)
  const minimumSeparationMm = Math.max(1, strandWidthMm * MIN_STRAND_SEPARATION_FACTOR)
  const { chords, layerChordCounts } = chooseStringArtChords(darkness, SAMPLE_SIDE, SAMPLE_SIDE, anchors, settings.layerCount, minimumSeparationMm)
  const stringArt: StringArtData = { anchors, chords, layerChordCounts, settings, strandWidthMm, layerHeightMm }
  const previews = buildStringArtPreviews(boardWidthMm, boardHeightMm, baseLoops, stringArt)
  return {
    sourceKind: 'image', sourceWidth: sourceImage.width, sourceHeight: sourceImage.height,
    lineLoops: [], baseLoops, stringArt, boardWidthMm, boardHeightMm, pixelsPerMm: 8, previews,
    stats: { sourceKind: 'image', sourceWidth: sourceImage.width, sourceHeight: sourceImage.height, lineLoopCount: chords.length, baseLoopCount: baseLoops.length, lineSegments: chords.length, baseSegments: baseLoops.reduce((sum, loop) => sum + loop.points.length, 0), boardWidthMm, boardHeightMm },
  }
}

/**
 * The chord end face is buried in the middle of the annular frame, rather than
 * merely touching its inner edge. This matches the working reference model's
 * connection geometry and leaves a substantial printable overlap on both sides.
 */
export function getStringArtEndpointRadius(radiusMm: number, strandWidthMm: number) {
  const wallThicknessMm = getStringArtWallThickness()
  const outerRadiusMm = radiusMm + wallThicknessMm / 2
  const penetrationMm = Math.max(strandWidthMm * 2.5, wallThicknessMm * 0.4)
  return outerRadiusMm - penetrationMm
}

export function getStringArtWallThickness() {
  return STRING_ART_WALL_THICKNESS_MM
}

/**
 * Each layer is a planar non-crossing chord set. Chords may cross only after
 * being placed on distinct Z layers, so a slicer sees isolated straight bars
 * rather than an intersecting, path-reorderable web.
 */
export function distributeNonCrossingChords(candidates: Array<[number, number]>, anchors: VectorPoint[], layerCount: number, minimumSeparationMm: number) {
  const layers: Array<Array<[number, number]>> = Array.from({ length: layerCount }, () => [])
  for (const candidate of candidates) {
    const layer = layers.find((current) => current.length < STRING_ART_CHORDS_PER_LAYER && current.every((existing) =>
      !chordsCross(candidate, existing, anchors.length)
      && !chordsAreTooClose(candidate, existing, anchors, minimumSeparationMm),
    ))
    if (layer) layer.push(candidate)
  }
  return { chords: layers.flat(), layerChordCounts: layers.map((layer) => layer.length) }
}

function chordsAreTooClose([a, b]: [number, number], [c, d]: [number, number], anchors: VectorPoint[], minimumSeparationMm: number) {
  // Sharing an endpoint creates a dense branch at the wall, so it is not
  // allowed within one layer even though it is not a geometric crossing.
  if (a === c || a === d || b === c || b === d) return true
  return segmentDistance(anchors[a], anchors[b], anchors[c], anchors[d]) < minimumSeparationMm
}

function segmentDistance(a: VectorPoint, b: VectorPoint, c: VectorPoint, d: VectorPoint) {
  if (segmentsIntersect(a, b, c, d)) return 0
  return Math.min(
    pointToSegmentDistance(a, c, d), pointToSegmentDistance(b, c, d),
    pointToSegmentDistance(c, a, b), pointToSegmentDistance(d, a, b),
  )
}

function segmentsIntersect(a: VectorPoint, b: VectorPoint, c: VectorPoint, d: VectorPoint) {
  const cross = (origin: VectorPoint, left: VectorPoint, right: VectorPoint) =>
    (left.x - origin.x) * (right.y - origin.y) - (left.y - origin.y) * (right.x - origin.x)
  const abC = cross(a, b, c)
  const abD = cross(a, b, d)
  const cdA = cross(c, d, a)
  const cdB = cross(c, d, b)
  return abC * abD <= 0 && cdA * cdB <= 0
}

function pointToSegmentDistance(point: VectorPoint, from: VectorPoint, to: VectorPoint) {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const lengthSquared = dx * dx + dy * dy
  if (lengthSquared === 0) return Math.hypot(point.x - from.x, point.y - from.y)
  const ratio = Math.max(0, Math.min(1, ((point.x - from.x) * dx + (point.y - from.y) * dy) / lengthSquared))
  return Math.hypot(point.x - (from.x + ratio * dx), point.y - (from.y + ratio * dy))
}

function chordsCross([a, b]: [number, number], [c, d]: [number, number], anchorCount: number) {
  if (a === c || a === d || b === c || b === d) return false
  return isInsideArc(c, a, b, anchorCount) !== isInsideArc(d, a, b, anchorCount)
}

function isInsideArc(point: number, start: number, end: number, count: number) {
  const span = (end - start + count) % count
  const offset = (point - start + count) % count
  return offset > 0 && offset < span
}

function anchorsBounds(anchors: VectorPoint[]) {
  const xs = anchors.map((anchor) => anchor.x)
  const ys = anchors.map((anchor) => anchor.y)
  const minX = Math.min(...xs)
  const minY = Math.min(...ys)
  return { minX, minY, width: Math.max(1, Math.max(...xs) - minX), height: Math.max(1, Math.max(...ys) - minY) }
}

function scoreChord(residual: Float32Array, width: number, height: number, from: VectorPoint, to: VectorPoint) {
  const samples = sampleLine(from, to)
  let score = 0
  for (const point of samples) {
    const x = Math.round(point.x); const y = Math.round(point.y)
    if (x >= 0 && y >= 0 && x < width && y < height) {
      const value = residual[y * width + x]
      score += value * Math.abs(value)
    }
  }
  return score / Math.max(samples.length, 1)
}

function applyChord(residual: Float32Array, width: number, height: number, from: VectorPoint, to: VectorPoint, strength: number) {
  for (const point of sampleLine(from, to)) {
    const x = Math.round(point.x); const y = Math.round(point.y)
    if (x >= 0 && y >= 0 && x < width && y < height) residual[y * width + x] -= strength
  }
}

function sampleLine(from: VectorPoint, to: VectorPoint) {
  const steps = Math.max(1, Math.ceil(Math.hypot(to.x - from.x, to.y - from.y)))
  return Array.from({ length: steps + 1 }, (_, step) => ({ x: from.x + (to.x - from.x) * step / steps, y: from.y + (to.y - from.y) * step / steps }))
}

function getStringArtBoard(settings: StringArtSettings) {
  const wallThicknessMm = getStringArtWallThickness()
  const outerRadiusMm = settings.radiusMm + wallThicknessMm / 2
  const boardWidthMm = outerRadiusMm * 2
  const boardHeightMm = outerRadiusMm * 2
  const circle = (radius: number) => Array.from({ length: 96 }, (_, index) => {
    const angle = 2 * Math.PI * index / 96
    return { x: outerRadiusMm + radius * Math.cos(angle), y: outerRadiusMm + radius * Math.sin(angle) }
  })
  const baseLoops: VectorLoop[] = [
    { closed: true, points: circle(outerRadiusMm) },
    { closed: true, points: circle(Math.max(0.1, settings.radiusMm - wallThicknessMm / 2)) },
  ]
  return { boardWidthMm, boardHeightMm, baseLoops }
}

async function readDarkness(source: SourceImage, width: number, height: number) {
  const image = await loadImage(source.dataUrl)
  const canvas = document.createElement('canvas')
  canvas.width = width; canvas.height = height
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) throw new Error('浏览器无法读取图片像素，不能生成弦丝画。')
  context.fillStyle = '#ffffff'; context.fillRect(0, 0, width, height)
  const scale = Math.max(width / image.naturalWidth, height / image.naturalHeight)
  const drawWidth = image.naturalWidth * scale; const drawHeight = image.naturalHeight * scale
  context.drawImage(image, (width - drawWidth) / 2, (height - drawHeight) / 2, drawWidth, drawHeight)
  const pixels = context.getImageData(0, 0, width, height).data
  const darkness = new Float32Array(width * height)
  for (let index = 0; index < darkness.length; index += 1) {
    const offset = index * 4
    darkness[index] = clamp(1 - (pixels[offset] * 0.2126 + pixels[offset + 1] * 0.7152 + pixels[offset + 2] * 0.0722) / 255, 0, 1)
  }
  return darkness
}

function loadImage(url: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('图片读取失败，不能生成弦丝画。'))
    image.src = url
  })
}

function buildStringArtPreviews(width: number, height: number, baseLoops: VectorLoop[], art: StringArtData) {
  const strings = art.chords.map(([from, to]) => `<line x1="${art.anchors[from].x}" y1="${art.anchors[from].y}" x2="${art.anchors[to].x}" y2="${art.anchors[to].y}"/>`).join('')
  const loops = baseLoops.map((loop) => loop.points.map((point, index) => `${index ? 'L' : 'M'}${point.x} ${point.y}`).join(' ') + ' Z').join(' ')
  const svg = (showWall: boolean) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}">${showWall ? `<path d="${loops}" fill="#e2e8f0" fill-rule="evenodd"/>` : ''}<g fill="none" stroke="#111111" stroke-width="${art.strandWidthMm}" stroke-linecap="round" opacity="0.78">${strings}</g></svg>`)}`
  return { lineartDataUrl: svg(false), baseplateDataUrl: svg(true), compositeDataUrl: svg(true) }
}
