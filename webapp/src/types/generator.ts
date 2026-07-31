export type PreviewMode = '原图' | '线稿' | '底板预览' | '分层预览' | '3D预览'
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

export interface PrintBedSettings {
  widthMm: number
  depthMm: number
  spacingMm: number
}

export interface ThreeMfTemplateProfile {
  sourceName: string
  applicationName: string
  projectSettings: Record<string, unknown>
  sliceInfoConfig: string
  filamentSequenceJson: string | null
  printBedWidthMm: number
  printBedDepthMm: number
  printerModel: string
  printerVariant: string
  printerSettingsId: string
  printSettingsId: string
  bedType: string
  compatiblePrinters: string[]
  filamentSlotCount: number
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

export interface PrintBedPlacementItem {
  id: string
  label: string
  widthMm: number
  heightMm: number
  previewDataUrl?: string
}

export interface PrintBedPlacement {
  id: string
  label: string
  xMm: number
  yMm: number
  widthMm: number
  heightMm: number
  previewDataUrl?: string
  fits: boolean
  plateIndex: number
}

export interface PrintBedPlate {
  plateIndex: number
  placements: PrintBedPlacement[]
}

export interface PrintBedLayout {
  widthMm: number
  depthMm: number
  spacingMm: number
  edgeMarginMm: number
  plates: PrintBedPlate[]
  placements: PrintBedPlacement[]
  overflowCount: number
}
