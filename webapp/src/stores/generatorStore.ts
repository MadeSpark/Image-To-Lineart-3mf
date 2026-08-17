import { create } from 'zustand'
import type {
  BaseplateSettings,
  ExtrudeSettings,
  ImportedLineart,
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
const SHARED_STORAGE_KEY = 'lineart-baseplate-generator-settings-shared'
const DEFAULT_PREVIEW_MODE: PreviewMode = '分层预览'
const PREVIEW_MODES: PreviewMode[] = ['原图', '线稿', '底板预览', '分层预览', '3D预览']

export const defaultLineartSettings: LineartSettings = {
  detail: 100,
  threshold: 160,
  targetColor: '#000000',
  despeckle: 24,
  strokeWidth: 0,
  smoothing: 36,
  invert: false,
  mirror: false,
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
  lineColor: '#111111',
  baseColor: '#f3f6fb',
}

export const defaultExtrudeSettings: ExtrudeSettings = {
  baseThicknessMm: 0.2,
  lineThicknessMm: 0.2,
  lineHeightMm: 0.2,
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
  engravingHeightDiffMm: 1,
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

interface SharedSettings {
  printBedSettings: PrintBedSettings
  customThreeMfProfile: ThreeMfTemplateProfile | null
}

interface GeneratorState {
  workMode: WorkMode
  sourceImage: SourceImage | null
  importedLineart: ImportedLineart | null
  previewMode: PreviewMode
  lineartSettings: LineartSettings
  baseplateSettings: BaseplateSettings
  extrudeSettings: ExtrudeSettings
  numberingSettings: NumberingSettings
  sealSettings: SealSettings
  printBedSettings: PrintBedSettings
  customThreeMfProfile: ThreeMfTemplateProfile | null
  setSourceImage: (sourceImage: SourceImage | null) => void
  setImportedLineart: (importedLineart: ImportedLineart | null) => void
  setPreviewMode: (mode: PreviewMode) => void
  setWorkMode: (mode: WorkMode) => void
  updateLineartSettings: (patch: Partial<LineartSettings>) => void
  updateBaseplateSettings: (patch: Partial<BaseplateSettings>) => void
  updateExtrudeSettings: (patch: Partial<ExtrudeSettings>) => void
  updatePrintBedSettings: (patch: Partial<PrintBedSettings>) => void
  updateNumberingSettings: (patch: Partial<NumberingSettings>) => void
  updateSealSettings: (patch: Partial<SealSettings>) => void
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
    baseplateSettings: { ...defaultBaseplateSettings, ...parsed.baseplateSettings },
    sealSettings: { ...defaultSealSettings, ...parsed.sealSettings },
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

function loadSharedSettings(): SharedSettings {
  const stored = loadJson<Partial<SharedSettings>>(SHARED_STORAGE_KEY)
  return normalizeSharedSettings(stored ?? {})
}

function saveSharedSettings(settings: SharedSettings) {
  saveJson(SHARED_STORAGE_KEY, settings)
}

function saveCurrentModeSettings(state: GeneratorState) {
  if (state.workMode === 'filigree') {
    saveFiligreeSettings({
      lineartSettings: state.lineartSettings,
      baseplateSettings: state.baseplateSettings,
      extrudeSettings: state.extrudeSettings,
      numberingSettings: state.numberingSettings,
    })
  } else {
    saveSealSettings({
      lineartSettings: state.lineartSettings,
      baseplateSettings: state.baseplateSettings,
      sealSettings: state.sealSettings,
    })
  }
  saveSharedSettings({
    printBedSettings: state.printBedSettings,
    customThreeMfProfile: state.customThreeMfProfile,
  })
}

const storedFiligree = loadFiligreeSettings()
const storedSeal = loadSealSettings()
const storedShared = loadSharedSettings()

export const useGeneratorStore = create<GeneratorState>((set, get) => ({
  workMode: 'filigree',
  sourceImage: null,
  importedLineart: null,
  previewMode: DEFAULT_PREVIEW_MODE,
  lineartSettings: storedFiligree.lineartSettings,
  baseplateSettings: storedFiligree.baseplateSettings,
  extrudeSettings: storedFiligree.extrudeSettings,
  numberingSettings: storedFiligree.numberingSettings,
  sealSettings: storedSeal.sealSettings,
  printBedSettings: storedShared.printBedSettings,
  customThreeMfProfile: storedShared.customThreeMfProfile,

  setSourceImage: (sourceImage) => set({ sourceImage, importedLineart: null }),
  setImportedLineart: (importedLineart) => set({ importedLineart, sourceImage: null }),
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
    } else {
      const seal = loadSealSettings()
      set({
        workMode: 'seal',
        lineartSettings: seal.lineartSettings,
        baseplateSettings: seal.baseplateSettings,
        sealSettings: seal.sealSettings,
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
        customThreeMfProfile: normalized.customThreeMfProfile,
      }))
    } else {
      const seal = loadSealSettings()
      saveSealSettings({
        lineartSettings: normalized.lineartSettings,
        baseplateSettings: normalized.baseplateSettings,
        sealSettings: normalized.sealSettings,
      })
      set({
        workMode: 'seal',
        previewMode: isPreviewMode(settings.previewMode) ? settings.previewMode : get().previewMode,
        lineartSettings: normalized.lineartSettings,
        baseplateSettings: normalized.baseplateSettings,
        printBedSettings: normalized.printBedSettings,
        sealSettings: normalized.sealSettings,
        customThreeMfProfile: normalized.customThreeMfProfile,
      })
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
    } else {
      saveSealSettings({
        lineartSettings: defaultSealLineartSettings,
        baseplateSettings: defaultBaseplateSettings,
        sealSettings: defaultSealSettings,
      })
      set({
        workMode: 'seal',
        previewMode: DEFAULT_PREVIEW_MODE,
        lineartSettings: defaultSealLineartSettings,
        baseplateSettings: defaultBaseplateSettings,
        sealSettings: defaultSealSettings,
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