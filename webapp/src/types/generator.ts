export type PreviewMode = '原图' | '线稿' | '底板预览' | '分层预览'
export type BaseTemplate = 'outline' | 'rectangle' | 'circle'
export type SourceKind = 'image' | 'dxf'

export interface SourceImage {
  name: string
  width: number
  height: number
  dataUrl: string
}

export interface GifFrameSource extends SourceImage {
  frameIndex: number
  totalFrames: number
  delayMs: number
}

export interface VectorPoint {
  x: number
  y: number
}

export interface VectorLoop {
  points: VectorPoint[]
  closed: boolean
}

export interface ImportedLineart {
  name: string
  loops: VectorLoop[]
  widthMm: number
  heightMm: number
}

export interface BatchSourceItem {
  id: string
  sourceKind: SourceKind
  sourceImage: SourceImage | null
  importedLineart: ImportedLineart | null
  label: string
  shortLabel?: string
}

export interface LineartSettings {
  detail: number
  threshold: number
  targetColor: string
  despeckle: number
  strokeWidth: number
  smoothing: number
  invert: boolean
  mirror: boolean
}

export interface BaseplateSettings {
  template: BaseTemplate
  expandMm: number
  widthMm: number
  heightMm: number
  diameterMm: number
  marginMm: number
  lineColor: string
  baseColor: string
}

export interface ExtrudeSettings {
  baseThicknessMm: number
  lineThicknessMm: number
  lineHeightMm: number
}

export interface PreviewAssets {
  lineartDataUrl: string
  baseplateDataUrl: string
  compositeDataUrl: string
}

export interface GeometryStats {
  sourceKind: SourceKind
  sourceWidth: number
  sourceHeight: number
  lineLoopCount: number
  baseLoopCount: number
  lineSegments: number
  baseSegments: number
  boardWidthMm: number
  boardHeightMm: number
}

export interface ProcessedArtwork {
  sourceKind: SourceKind
  sourceWidth: number
  sourceHeight: number
  lineLoops: VectorLoop[]
  baseLoops: VectorLoop[]
  boardWidthMm: number
  boardHeightMm: number
  pixelsPerMm: number
  previews: PreviewAssets
  stats: GeometryStats
}
