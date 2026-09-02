export type PreviewMode = '原图' | '线稿' | 'DXF预览' | '底板预览' | '分层预览' | '3D预览'
export type BaseTemplate = 'outline' | 'rectangle' | 'circle'
export type RectangleSizeMode = 'ratio' | 'manual'
/**
 * 底板图片放置规则：
 * - 'fit': 等比缩放完整显示在安全边距内（默认，原有行为）
 * - 'center': 保持原比例，在不被裁剪、不超过画布（画板）的情况下最大化居中（忽略安全边距）
 * - 'stretch': 非等比拉伸铺满安全边距内区域（比例可能变形）
 * - 'crop': 从图片中间裁剪一块与安全区等比的区域，等比缩放铺满安全区（不变形）
 */
export type ImagePlacement = 'fit' | 'center' | 'stretch' | 'crop'
export type SourceKind = 'image' | 'dxf'
export type WorkMode = 'filigree' | 'seal' | 'light-relief'
export type CarvingMode = 'intaglio' | 'relief'

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
  thresholdAuto: boolean
  targetColor: string
  despeckle: number
  /** 加粗描边（膨胀），默认0；与 shrinkStrokeMm 互斥 */
  expandStrokeMm: number
  /** 缩小描边（腐蚀），默认0；与 expandStrokeMm 互斥；不低于 minLineWidthMm */
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

export interface BaseplateSettings {
  template: BaseTemplate
  expandMm: number
  widthMm: number
  heightMm: number
  rectangleSizeMode: RectangleSizeMode
  rectangleScalePercent: number
  diameterMm: number
  marginMm: number
  imagePlacement: ImagePlacement
  lineColor: string
  baseColor: string
}

export interface ExtrudeSettings {
  baseThicknessMm: number
  lineThicknessMm: number
  lineHeightMm: number
  /** 最小线宽，缩小描边的下限；可由3MF导入读取 */
  minLineWidthMm: number
}

export interface PrintBedSettings {
  widthMm: number
  depthMm: number
  spacingMm: number
}

export interface NumberingSettings {
  enabled: boolean
  startNumber: number
  fontSizeMm: number
  marginMm: number
  horizontalAlign: 'left' | 'center' | 'right'
  verticalAlign: 'top' | 'center' | 'bottom'
}

export interface SealSettings {
  strokeEnabled: boolean
  strokeWidthMm: number
  carvingMode: CarvingMode
  sealHeightMm: number
  engravingHeightDiffMm: number
}

/**
 * 光映浮雕 B 面模式。
 * - 'auto': 自动检测——图片同时含黑(0,0,0)和红(255,0,0)时走 lineart，否则走 halftone（默认）
 * - 'lineart': 同图双色提取，A 面提取黑(0,0,0)、B 面提取红(255,0,0)，B 面按线稿阴刻处理
 * - 'halftone': 透光浮雕，用户单独导入 B 面图片；将图像转为灰度，按深浅打印厚度，
 *   深色区域厚（透光后呈黑线条），浅色区域薄
 */
export type LightReliefBFaceMode = 'auto' | 'lineart' | 'halftone'

/**
 * 光映浮雕模式参数。
 * - totalHeightMm: 模型总厚度
 * - faceAZMm / faceAHeightMm: A 面（耗材1/黑）线稿所在 Z 区间 [faceAZMm, faceAZMm+faceAHeightMm]
 * - faceBZMm / faceBHeightMm: B 面 Z 区间 [faceBZMm, faceBZMm+faceBHeightMm]
 *   - lineart 模式：该区间内 B 面线稿区域为空（不打印）
 *   - halftone 模式：该区间内按灰度打印厚度，灰度值映射到 [0, faceBHeightMm]
 * - bFaceMode: B 面处理模式（默认 'auto'）
 * - bFaceExposure: halftone 模式下的曝光值（0~200，100 为原始亮度），用于调整图片过暗时的厚度分布
 * - bFaceInvert: halftone 模式下是否反转灰度（深色变浅、浅色变深）
 *
 * 【B 面透光浮雕几何唯一解（2026-08-30 第 12 轮定案，勿再改回去）】
 * 浮雕柱体**坐在背景下层上**：底面齐平贴死 faceBZMm（与底座全接触、零空腔），
 * 顶面随灰度起伏，凹凸面裸露朝上 → 横截面随 Z 单调收缩（SHRINKING）→ 0% 悬垂、免支撑。
 * 曾存在的「bFaceReverseStack 反向堆叠」（柱体吊挂、尖端朝 A 面 + 倒扣打印）已被证明不可打印并移除：
 *   正打 → 柱底悬空 GROWING；倒扣 180° → 背景下层变悬顶（实测第一层 87.5% 悬空）。
 * 同理，背景顶层（顶盖）已永久删除：它盖在凹凸面上方，谷底上方全是空腔 → 悬顶 + 挡光。
 *
 * 其余区域一律用耗材2（白）填充。
 */
export interface LightReliefSettings {
  totalHeightMm: number
  faceAZMm: number
  faceAHeightMm: number
  faceBZMm: number
  faceBHeightMm: number
  bFaceMode: LightReliefBFaceMode
  bFaceExposure: number
  bFaceInvert: boolean
}

/**
 * 底板预设：一键应用整组配置（底板部分 + 可选的光映浮雕 Z 轴分层部分）。
 * 目前仅光映浮雕模式在 UI 上暴露（PalettePanel「底板模板选择」上方的预设区块）。
 */
export interface BaseplatePreset {
  /** 预设名，如 "3:2"，卡片上只显示这个名字 */
  name: string
  /** 应用到底板设置的补丁 */
  baseplate: Partial<BaseplateSettings>
  /** 应用到光映浮雕设置的补丁（可选；仅光映浮雕模式） */
  lightRelief?: Partial<LightReliefSettings>
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
  /** 打印层高（mm），从 project_settings.config 的 layer_height 读取 */
  layerHeightMm: number | null
  /** 挤出线宽（mm），从 project_settings.config 的 line_width 读取 */
  lineWidthMm: number | null
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
  strokeLoops?: VectorLoop[]
  /** 光映浮雕模式下的 B 面线稿（A 面仍存于 lineLoops）。lineart 模式使用。 */
  lineLoopsB?: VectorLoop[]
  /**
   * 光映浮雕 halftone 模式下的 B 面灰度高度图。
   * - width/height: 像素尺寸（与 boardWidthMm/boardHeightMm + pixelsPerMm 对应）
   * - data: 每个像素的归一化高度 [0,1]，1 = 最厚（最深色），0 = 最薄（最浅色）
   * - 已应用曝光和反相处理，导出时映射到 [faceBZMm, faceBZMm+faceBHeightMm]
   */
  bFaceHeightMap?: { width: number; height: number; data: Float32Array }
  /** 光映浮雕模式下实际生效的 B 面模式（auto 检测后的结果）。非光映模式为 undefined。 */
  effectiveBFaceMode?: 'lineart' | 'halftone'
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
