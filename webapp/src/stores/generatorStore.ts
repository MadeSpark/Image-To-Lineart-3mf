import { create } from 'zustand'
import type {
  BaseplateSettings,
  ExtrudeSettings,
  ImportedLineart,
  LightReliefSettings,
  LineartSettings,
  NumberingSettings,
  PrintBedSettings,
  PreviewMode,
  SealSettings,
  SourceImage,
  ThreeMfTemplateProfile,
  WorkMode,
} from '@/types/generator'

const FILIGREE_STORAGE_KEY = 'lineart-baseplate-generator-settings-filigree'
const SEAL_STORAGE_KEY = 'lineart-baseplate-generator-settings-seal'
const LIGHT_RELIEF_STORAGE_KEY = 'lineart-baseplate-generator-settings-light-relief'
const SHARED_STORAGE_KEY = 'lineart-baseplate-generator-settings-shared'
const DEFAULT_PREVIEW_MODE: PreviewMode = '分层预览'
const PREVIEW_MODES: PreviewMode[] = ['原图', '线稿', 'DXF预览', '底板预览', '分层预览', '3D预览']

// 设置快照 schema 版本：用于一次性迁移历史 localStorage 快照。
const SCHEMA_VERSION_KEY = 'lineart-baseplate-generator-settings-schema-version'
const SETTINGS_SCHEMA_VERSION = 3
// 旧版线条平滑默认值。迁移时若快照仍为此值，视作"用户未修改过"，回落到新默认值。
const LEGACY_SMOOTHING_DEFAULT = 36
const MODE_STORAGE_KEYS = [FILIGREE_STORAGE_KEY, SEAL_STORAGE_KEY, LIGHT_RELIEF_STORAGE_KEY] as const

export const defaultLineartSettings: LineartSettings = {
  detail: 100,
  threshold: 160,
  thresholdAuto: true,
  targetColor: '#000000',
  despeckle: 24,
  expandStrokeMm: 0,
  shrinkStrokeMm: 0,
  smoothing: 10,
  invert: false,
  mirror: false,
  // 2026-08-27：移除"根据图片分辨率自动调整 detail/smoothing 等"功能。
// 已删除 calculateAutoLineartParams 与 Home.tsx 的两处调用，并从 UI 移除"自动识别优化"开关。
// 老用户带 autoOptimize=true 的快照强制改为 false，避免迁过去又被自动调参覆盖。
  autoOptimize: false,
  protectFineDetail: true,
  uploadPreprocess: true,
  bezierFitting: true,
  bezierStrength: 45,
}

export const defaultSealLineartSettings: LineartSettings = {
  ...defaultLineartSettings,
  mirror: true,
}

export const defaultBaseplateSettings: BaseplateSettings = {
  template: 'outline',
  expandMm: 2,
  widthMm: 50,
  heightMm: 50,
  rectangleSizeMode: 'ratio',
  rectangleScalePercent: 100,
  diameterMm: 50,
  marginMm: 4,
  imagePlacement: 'fit',
  lineColor: '#111111',
  baseColor: '#f3f6fb',
}

export const defaultSealBaseplateSettings: BaseplateSettings = {
  template: 'rectangle',
  expandMm: 2,
  widthMm: 30,
  heightMm: 30,
  rectangleSizeMode: 'manual',
  rectangleScalePercent: 100,
  diameterMm: 30,
  marginMm: 4,
  imagePlacement: 'fit',
  lineColor: '#111111',
  baseColor: '#f3f6fb',
}

// 光映浮雕：矩形画板，支持比例/长宽两种模式（参考掐丝模式）。
export const defaultLightReliefBaseplateSettings: BaseplateSettings = {
  template: 'rectangle',
  expandMm: 2,
  widthMm: 50,
  heightMm: 50,
  rectangleSizeMode: 'ratio',
  rectangleScalePercent: 100,
  diameterMm: 50,
  marginMm: 4,
  imagePlacement: 'fit',
  // 耗材1=黑（A 面线稿），耗材2=白（背景）。沿用 lineColor/baseColor，导出时槽位互换。
  lineColor: '#111111',
  baseColor: '#f3f6fb',
}

export const defaultExtrudeSettings: ExtrudeSettings = {
  baseThicknessMm: 0.2,
  lineThicknessMm: 0.2,
  lineHeightMm: 0.2,
  minLineWidthMm: 0.24,
}

export const defaultPrintBedSettings: PrintBedSettings = {
  widthMm: 256,
  depthMm: 256,
  spacingMm: 8,
}

export const defaultNumberingSettings: NumberingSettings = {
  enabled: false,
  startNumber: 1,
  fontSizeMm: 5,
  marginMm: 3,
  horizontalAlign: 'right',
  verticalAlign: 'bottom',
}

export const defaultSealSettings: SealSettings = {
  strokeEnabled: false,
  strokeWidthMm: 1,
  carvingMode: 'relief',
  sealHeightMm: 30,
  engravingHeightDiffMm: 0.5,
}

// 默认：总高1mm，A面[0,0.4]，B面[0.6,0.8]。
// bFaceMode 默认 lineart（同图双色提取），无红色时自动回退 halftone。
// halftone 模式下 B 面高度默认 1mm（透光浮雕需要足够厚度呈现深浅层次）。
export const defaultLightReliefSettings: LightReliefSettings = {
  totalHeightMm: 1,
  faceAZMm: 0,
  faceAHeightMm: 0.4,
  faceBZMm: 0.6,
  faceBHeightMm: 0.2,
  bFaceMode: 'auto',
  bFaceExposure: 100,
  bFaceInvert: false,
  bFaceReverseStack: false,
}

interface FiligreeModeSettings {
  lineartSettings: LineartSettings
  baseplateSettings: BaseplateSettings
  extrudeSettings: ExtrudeSettings
  numberingSettings: NumberingSettings
}

interface SealModeSettings {
  lineartSettings: LineartSettings
  baseplateSettings: BaseplateSettings
  sealSettings: SealSettings
}

interface LightReliefModeSettings {
  lineartSettings: LineartSettings
  baseplateSettings: BaseplateSettings
  lightReliefSettings: LightReliefSettings
}

interface SharedSettings {
  printBedSettings: PrintBedSettings
  customThreeMfProfile: ThreeMfTemplateProfile | null
}

interface GeneratorState {
  workMode: WorkMode
  sourceImage: SourceImage | null
  importedLineart: ImportedLineart | null
  /** 光映浮雕 halftone 模式下 B 面独立图片源（lineart 模式忽略） */
  sourceImageB: SourceImage | null
  previewMode: PreviewMode
  lineartSettings: LineartSettings
  baseplateSettings: BaseplateSettings
  extrudeSettings: ExtrudeSettings
  numberingSettings: NumberingSettings
  sealSettings: SealSettings
  lightReliefSettings: LightReliefSettings
  printBedSettings: PrintBedSettings
  customThreeMfProfile: ThreeMfTemplateProfile | null
  setSourceImage: (sourceImage: SourceImage | null) => void
  setImportedLineart: (importedLineart: ImportedLineart | null) => void
  setSourceImageB: (sourceImageB: SourceImage | null) => void
  setPreviewMode: (mode: PreviewMode) => void
  setWorkMode: (mode: WorkMode) => void
  updateLineartSettings: (patch: Partial<LineartSettings>) => void
  updateBaseplateSettings: (patch: Partial<BaseplateSettings>) => void
  updateExtrudeSettings: (patch: Partial<ExtrudeSettings>) => void
  updatePrintBedSettings: (patch: Partial<PrintBedSettings>) => void
  updateNumberingSettings: (patch: Partial<NumberingSettings>) => void
  updateSealSettings: (patch: Partial<SealSettings>) => void
  updateLightReliefSettings: (patch: Partial<LightReliefSettings>) => void
  setCustomThreeMfProfile: (profile: ThreeMfTemplateProfile | null) => void
  applyImportedSettings: (settings: GeneratorSettingsPatch) => void
  resetAllSettings: (defaultBedPatch?: Partial<PrintBedSettings>) => void
}

export interface PersistedGeneratorSettings {
  lineartSettings: LineartSettings
  baseplateSettings: BaseplateSettings
  extrudeSettings: ExtrudeSettings
  printBedSettings: PrintBedSettings
  numberingSettings?: NumberingSettings
  sealSettings?: SealSettings
  lightReliefSettings?: LightReliefSettings
  customThreeMfProfile?: ThreeMfTemplateProfile | null
  workMode?: WorkMode
}

export interface GeneratorSettingsPayload extends PersistedGeneratorSettings {
  previewMode?: PreviewMode
}

export interface GeneratorSettingsPatch {
  previewMode?: PreviewMode
  lineartSettings?: Partial<LineartSettings>
  baseplateSettings?: Partial<BaseplateSettings>
  extrudeSettings?: Partial<ExtrudeSettings>
  printBedSettings?: Partial<PrintBedSettings>
  numberingSettings?: Partial<NumberingSettings>
  sealSettings?: Partial<SealSettings>
  lightReliefSettings?: Partial<LightReliefSettings>
  customThreeMfProfile?: ThreeMfTemplateProfile | null
  workMode?: WorkMode
}

function isPreviewMode(value: unknown): value is PreviewMode {
  return PREVIEW_MODES.includes(value as PreviewMode)
}

function normalizeFiligreeSettings(parsed: Partial<FiligreeModeSettings>): FiligreeModeSettings {
  return {
    lineartSettings: { ...defaultLineartSettings, ...parsed.lineartSettings },
    baseplateSettings: { ...defaultBaseplateSettings, ...parsed.baseplateSettings },
    extrudeSettings: { ...defaultExtrudeSettings, ...parsed.extrudeSettings },
    numberingSettings: { ...defaultNumberingSettings, ...parsed.numberingSettings },
  }
}

function normalizeSealSettings(parsed: Partial<SealModeSettings>): SealModeSettings {
  return {
    lineartSettings: { ...defaultSealLineartSettings, ...parsed.lineartSettings },
    baseplateSettings: { ...defaultSealBaseplateSettings, ...parsed.baseplateSettings },
    sealSettings: { ...defaultSealSettings, ...parsed.sealSettings },
  }
}

/** 统一归一化光映浮雕参数：限制硬上限，并保证 A/B 面 (Z + height) 不超过总高度。 */
function sanitizeLightReliefSettings(settings: LightReliefSettings): LightReliefSettings {
  let s = { ...settings }
  if (typeof s.totalHeightMm === 'number') {
    s.totalHeightMm = Math.max(0.2, Math.min(20, s.totalHeightMm))
  }
  if (typeof s.faceBHeightMm === 'number') {
    s.faceBHeightMm = Math.max(0.1, Math.min(10, s.faceBHeightMm))
  }
  if (typeof s.faceAHeightMm === 'number' && s.faceAHeightMm < 0.1) {
    s.faceAHeightMm = 0.1
  }
  if (typeof s.faceAZMm === 'number' && s.faceAZMm < 0) s.faceAZMm = 0
  if (typeof s.faceBZMm === 'number' && s.faceBZMm < 0) s.faceBZMm = 0
  const aTop = s.faceAZMm + s.faceAHeightMm
  if (aTop > s.totalHeightMm) {
    s = { ...s, faceAZMm: Math.max(0, s.totalHeightMm - s.faceAHeightMm) }
  }
  const bTop = s.faceBZMm + s.faceBHeightMm
  if (bTop > s.totalHeightMm) {
    s = { ...s, faceBZMm: Math.max(0, s.totalHeightMm - s.faceBHeightMm) }
  }
  if (typeof s.bFaceExposure === 'number') {
    s.bFaceExposure = Math.max(0, Math.min(500, s.bFaceExposure))
  }
  return s
}

function normalizeLightReliefSettings(parsed: Partial<LightReliefModeSettings>): LightReliefModeSettings {
  const mergedSettings = sanitizeLightReliefSettings({
    ...defaultLightReliefSettings,
    ...parsed.lightReliefSettings,
  })
  return {
    lineartSettings: { ...defaultLineartSettings, ...parsed.lineartSettings },
    baseplateSettings: { ...defaultLightReliefBaseplateSettings, ...parsed.baseplateSettings },
    lightReliefSettings: mergedSettings,
  }
}

function normalizeSharedSettings(parsed: Partial<SharedSettings>): SharedSettings {
  return {
    printBedSettings: { ...defaultPrintBedSettings, ...parsed.printBedSettings },
    customThreeMfProfile: parsed.customThreeMfProfile ?? null,
  }
}

function normalizePersistedSettings(parsed: GeneratorSettingsPatch) {
  return {
    previewMode: isPreviewMode(parsed.previewMode) ? parsed.previewMode : DEFAULT_PREVIEW_MODE,
    lineartSettings: {
      ...defaultLineartSettings,
      ...parsed.lineartSettings,
    },
    baseplateSettings: {
      ...defaultBaseplateSettings,
      ...parsed.baseplateSettings,
    },
    extrudeSettings: {
      ...defaultExtrudeSettings,
      ...parsed.extrudeSettings,
    },
    printBedSettings: {
      ...defaultPrintBedSettings,
      ...parsed.printBedSettings,
    },
    numberingSettings: {
      ...defaultNumberingSettings,
      ...parsed.numberingSettings,
    },
    sealSettings: {
      ...defaultSealSettings,
      ...parsed.sealSettings,
    },
    lightReliefSettings: sanitizeLightReliefSettings({
      ...defaultLightReliefSettings,
      ...parsed.lightReliefSettings,
    }),
    customThreeMfProfile: parsed.customThreeMfProfile ?? null,
    workMode: parsed.workMode ?? 'filigree',
  }
}

export function buildPersistedSettingsSnapshot(settings: PersistedGeneratorSettings) {
  return {
    lineartSettings: settings.lineartSettings,
    baseplateSettings: settings.baseplateSettings,
    extrudeSettings: settings.extrudeSettings,
    printBedSettings: settings.printBedSettings,
    numberingSettings: settings.numberingSettings ?? defaultNumberingSettings,
    sealSettings: settings.sealSettings ?? defaultSealSettings,
    lightReliefSettings: settings.lightReliefSettings ?? defaultLightReliefSettings,
    customThreeMfProfile: settings.customThreeMfProfile ?? null,
    workMode: settings.workMode ?? 'filigree',
  }
}

function loadJson<T>(key: string): T | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(key)
    if (!raw) return null
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

function saveJson(key: string, value: unknown) {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // Ignore storage failures
  }
}

function loadFiligreeSettings(): FiligreeModeSettings {
  const stored = loadJson<Partial<FiligreeModeSettings>>(FILIGREE_STORAGE_KEY)
  return normalizeFiligreeSettings(stored ?? {})
}

function saveFiligreeSettings(settings: FiligreeModeSettings) {
  saveJson(FILIGREE_STORAGE_KEY, settings)
}

function loadSealSettings(): SealModeSettings {
  const stored = loadJson<Partial<SealModeSettings>>(SEAL_STORAGE_KEY)
  return normalizeSealSettings(stored ?? {})
}

function saveSealSettings(settings: SealModeSettings) {
  saveJson(SEAL_STORAGE_KEY, settings)
}

function loadLightReliefSettings(): LightReliefModeSettings {
  const stored = loadJson<Partial<LightReliefModeSettings>>(LIGHT_RELIEF_STORAGE_KEY)
  return normalizeLightReliefSettings(stored ?? {})
}

function saveLightReliefSettings(settings: LightReliefModeSettings) {
  saveJson(LIGHT_RELIEF_STORAGE_KEY, settings)
}

function loadSharedSettings(): SharedSettings {
  const stored = loadJson<Partial<SharedSettings>>(SHARED_STORAGE_KEY)
  return normalizeSharedSettings(stored ?? {})
}

function saveSharedSettings(settings: SharedSettings) {
  saveJson(SHARED_STORAGE_KEY, settings)
}

/**
 * 迁移历史快照：
 * - schema v2 → v3：移除自动调参功能。老用户带 autoOptimize=true 的快照强制改为 false，
 *   这样即使旧 UI 显示"自动识别优化"开着，新 UI 也不会触发（开关已隐藏）。
 * - schema v1 → v2：线条平滑曾默认 36，现改为 10。
 *   若某模式快照的 smoothing 仍为旧默认 36，视作"用户未修改过"，移除该字段
 *   使其回落到新默认值 10；若 smoothing 为其他值，视作"用户已显式修改"，保留不动。
 */
function migrateStoredSettings() {
  if (typeof window === 'undefined') return
  let version = 0
  try {
    version = Number(window.localStorage.getItem(SCHEMA_VERSION_KEY)) || 0
  } catch {
    version = 0
  }
  if (version >= SETTINGS_SCHEMA_VERSION) return

  for (const key of MODE_STORAGE_KEYS) {
    try {
      const raw = window.localStorage.getItem(key)
      if (!raw) continue
      const parsed = JSON.parse(raw) as {
        lineartSettings?: { smoothing?: number; autoOptimize?: boolean }
      }
      const ls = parsed?.lineartSettings
      let mutated = false
      if (version < 2 && ls && ls.smoothing === LEGACY_SMOOTHING_DEFAULT) {
        delete ls.smoothing
        mutated = true
      }
      if (version < 3 && ls && ls.autoOptimize === true) {
        ls.autoOptimize = false
        mutated = true
      }
      if (mutated) {
        window.localStorage.setItem(key, JSON.stringify(parsed))
      }
    } catch {
      // 损坏的存储条目交给后续 normalize 兜底，跳过迁移
    }
  }

  try {
    window.localStorage.setItem(SCHEMA_VERSION_KEY, String(SETTINGS_SCHEMA_VERSION))
  } catch {
    // 忽略写入失败
  }
}

function saveCurrentModeSettings(state: GeneratorState) {
  if (state.workMode === 'filigree') {
    saveFiligreeSettings({
      lineartSettings: state.lineartSettings,
      baseplateSettings: state.baseplateSettings,
      extrudeSettings: state.extrudeSettings,
      numberingSettings: state.numberingSettings,
    })
  } else if (state.workMode === 'seal') {
    saveSealSettings({
      lineartSettings: state.lineartSettings,
      baseplateSettings: state.baseplateSettings,
      sealSettings: state.sealSettings,
    })
  } else {
    saveLightReliefSettings({
      lineartSettings: state.lineartSettings,
      baseplateSettings: state.baseplateSettings,
      lightReliefSettings: state.lightReliefSettings,
    })
  }
  saveSharedSettings({
    printBedSettings: state.printBedSettings,
    customThreeMfProfile: state.customThreeMfProfile,
  })
}

migrateStoredSettings()

const storedFiligree = loadFiligreeSettings()
const storedSeal = loadSealSettings()
const storedLightRelief = loadLightReliefSettings()
const storedShared = loadSharedSettings()

export const useGeneratorStore = create<GeneratorState>((set, get) => ({
  workMode: 'filigree',
  sourceImage: null,
  importedLineart: null,
  sourceImageB: null,
  previewMode: DEFAULT_PREVIEW_MODE,
  lineartSettings: storedFiligree.lineartSettings,
  baseplateSettings: storedFiligree.baseplateSettings,
  extrudeSettings: storedFiligree.extrudeSettings,
  numberingSettings: storedFiligree.numberingSettings,
  sealSettings: storedSeal.sealSettings,
  lightReliefSettings: storedLightRelief.lightReliefSettings,
  printBedSettings: storedShared.printBedSettings,
  customThreeMfProfile: storedShared.customThreeMfProfile,

  setSourceImage: (sourceImage) => set({ sourceImage, importedLineart: null }),
  setImportedLineart: (importedLineart) => set({ importedLineart, sourceImage: null }),
  setSourceImageB: (sourceImageB) => set({ sourceImageB }),
  setPreviewMode: (previewMode) => set({ previewMode }),

  setWorkMode: (mode) => {
    const currentState = get()
    if (mode === currentState.workMode) return
    saveCurrentModeSettings(currentState)

    if (mode === 'filigree') {
      const filigree = loadFiligreeSettings()
      set({
        workMode: 'filigree',
        lineartSettings: filigree.lineartSettings,
        baseplateSettings: filigree.baseplateSettings,
        extrudeSettings: filigree.extrudeSettings,
        numberingSettings: filigree.numberingSettings,
      })
    } else if (mode === 'seal') {
      const seal = loadSealSettings()
      set({
        workMode: 'seal',
        lineartSettings: seal.lineartSettings,
        baseplateSettings: seal.baseplateSettings,
        sealSettings: seal.sealSettings,
      })
    } else {
      const lightRelief = loadLightReliefSettings()
      set({
        workMode: 'light-relief',
        lineartSettings: lightRelief.lineartSettings,
        baseplateSettings: lightRelief.baseplateSettings,
        lightReliefSettings: lightRelief.lightReliefSettings,
      })
    }
  },

  updateLineartSettings: (patch) => set((state) => {
    const lineartSettings = { ...state.lineartSettings, ...patch }
    const next = { ...state, lineartSettings }
    saveCurrentModeSettings(next)
    return { lineartSettings }
  }),

  updateBaseplateSettings: (patch) => set((state) => {
    const baseplateSettings = { ...state.baseplateSettings, ...patch }
    const next = { ...state, baseplateSettings }
    saveCurrentModeSettings(next)
    return { baseplateSettings }
  }),

  updateExtrudeSettings: (patch) => set((state) => {
    const extrudeSettings = { ...state.extrudeSettings, ...patch }
    const next = { ...state, extrudeSettings }
    saveCurrentModeSettings(next)
    return { extrudeSettings }
  }),

  updatePrintBedSettings: (patch) => set((state) => {
    const printBedSettings = { ...state.printBedSettings, ...patch }
    saveSharedSettings({
      printBedSettings,
      customThreeMfProfile: state.customThreeMfProfile,
    })
    return { printBedSettings }
  }),

  updateNumberingSettings: (patch) => set((state) => {
    const numberingSettings = { ...state.numberingSettings, ...patch }
    const next = { ...state, numberingSettings }
    saveCurrentModeSettings(next)
    return { numberingSettings }
  }),

  updateSealSettings: (patch) => set((state) => {
    const sealSettings = { ...state.sealSettings, ...patch }
    const next = { ...state, sealSettings }
    saveCurrentModeSettings(next)
    return { sealSettings }
  }),

  updateLightReliefSettings: (patch) => set((state) => {
    const lightReliefSettings = sanitizeLightReliefSettings({
      ...state.lightReliefSettings,
      ...patch,
    })
    const next = { ...state, lightReliefSettings }
    saveCurrentModeSettings(next)
    return { lightReliefSettings }
  }),

  setCustomThreeMfProfile: (customThreeMfProfile) => {
    saveSharedSettings({
      printBedSettings: get().printBedSettings,
      customThreeMfProfile,
    })
    set({ customThreeMfProfile })
  },

  applyImportedSettings: (settings) => {
    const normalized = normalizePersistedSettings(settings)
    const targetMode = settings.workMode ?? get().workMode
    const currentState = get()
    saveCurrentModeSettings(currentState)

    if (targetMode === 'filigree') {
      saveFiligreeSettings({
        lineartSettings: normalized.lineartSettings,
        baseplateSettings: normalized.baseplateSettings,
        extrudeSettings: normalized.extrudeSettings,
        numberingSettings: normalized.numberingSettings,
      })
      set((state) => ({
        workMode: 'filigree',
        previewMode: isPreviewMode(settings.previewMode) ? settings.previewMode : state.previewMode,
        lineartSettings: normalized.lineartSettings,
        baseplateSettings: normalized.baseplateSettings,
        extrudeSettings: normalized.extrudeSettings,
        numberingSettings: normalized.numberingSettings,
        printBedSettings: normalized.printBedSettings,
        sealSettings: state.sealSettings,
        lightReliefSettings: state.lightReliefSettings,
        customThreeMfProfile: normalized.customThreeMfProfile,
      }))
    } else if (targetMode === 'seal') {
      const seal = loadSealSettings()
      saveSealSettings({
        lineartSettings: normalized.lineartSettings,
        baseplateSettings: normalized.baseplateSettings,
        sealSettings: normalized.sealSettings,
      })
      set((state) => ({
        workMode: 'seal',
        previewMode: isPreviewMode(settings.previewMode) ? settings.previewMode : state.previewMode,
        lineartSettings: normalized.lineartSettings,
        baseplateSettings: normalized.baseplateSettings,
        printBedSettings: normalized.printBedSettings,
        sealSettings: normalized.sealSettings,
        lightReliefSettings: state.lightReliefSettings,
        customThreeMfProfile: normalized.customThreeMfProfile,
      }))
    } else {
      const lightRelief = loadLightReliefSettings()
      saveLightReliefSettings({
        lineartSettings: normalized.lineartSettings,
        baseplateSettings: normalized.baseplateSettings,
        lightReliefSettings: normalized.lightReliefSettings,
      })
      set((state) => ({
        workMode: 'light-relief',
        previewMode: isPreviewMode(settings.previewMode) ? settings.previewMode : state.previewMode,
        lineartSettings: normalized.lineartSettings,
        baseplateSettings: normalized.baseplateSettings,
        printBedSettings: normalized.printBedSettings,
        sealSettings: state.sealSettings,
        lightReliefSettings: normalized.lightReliefSettings,
        customThreeMfProfile: normalized.customThreeMfProfile,
      }))
    }
    saveSharedSettings({
      printBedSettings: normalized.printBedSettings,
      customThreeMfProfile: normalized.customThreeMfProfile,
    })
  },

  resetAllSettings: (defaultBedPatch) => {
    const printBedSettings = {
      ...defaultPrintBedSettings,
      ...defaultBedPatch,
    }
    const currentState = get()
    const currentMode = currentState.workMode
    saveCurrentModeSettings(currentState)

    if (currentMode === 'filigree') {
      saveFiligreeSettings({
        lineartSettings: defaultLineartSettings,
        baseplateSettings: defaultBaseplateSettings,
        extrudeSettings: defaultExtrudeSettings,
        numberingSettings: defaultNumberingSettings,
      })
      set({
        workMode: 'filigree',
        previewMode: DEFAULT_PREVIEW_MODE,
        lineartSettings: defaultLineartSettings,
        baseplateSettings: defaultBaseplateSettings,
        extrudeSettings: defaultExtrudeSettings,
        numberingSettings: defaultNumberingSettings,
        printBedSettings,
        customThreeMfProfile: null,
      })
    } else if (currentMode === 'seal') {
      saveSealSettings({
        lineartSettings: defaultSealLineartSettings,
        baseplateSettings: defaultSealBaseplateSettings,
        sealSettings: defaultSealSettings,
      })
      set({
        workMode: 'seal',
        previewMode: DEFAULT_PREVIEW_MODE,
        lineartSettings: defaultSealLineartSettings,
        baseplateSettings: defaultSealBaseplateSettings,
        sealSettings: defaultSealSettings,
        printBedSettings,
        customThreeMfProfile: null,
      })
    } else {
      saveLightReliefSettings({
        lineartSettings: defaultLineartSettings,
        baseplateSettings: defaultLightReliefBaseplateSettings,
        lightReliefSettings: defaultLightReliefSettings,
      })
      set({
        workMode: 'light-relief',
        previewMode: DEFAULT_PREVIEW_MODE,
        lineartSettings: defaultLineartSettings,
        baseplateSettings: defaultLightReliefBaseplateSettings,
        lightReliefSettings: defaultLightReliefSettings,
        printBedSettings,
        customThreeMfProfile: null,
      })
    }
    saveSharedSettings({
      printBedSettings,
      customThreeMfProfile: null,
    })
  },
}))