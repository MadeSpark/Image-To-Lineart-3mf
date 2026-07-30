import { create } from 'zustand'
import type {
  BaseplateSettings,
  ExtrudeSettings,
  ImportedLineart,
  LineartSettings,
  PrintBedSettings,
  PreviewMode,
  SourceImage,
  ThreeMfTemplateProfile,
} from '@/types/generator'

const SETTINGS_STORAGE_KEY = 'lineart-baseplate-generator-settings'

export const defaultLineartSettings: LineartSettings = {
  detail: 100,
  threshold: 160,
  targetColor: '#000000',
  despeckle: 24,
  strokeWidth: 0.4,
  smoothing: 36,
  invert: false,
  mirror: false,
}

export const defaultBaseplateSettings: BaseplateSettings = {
  template: 'outline',
  expandMm: 2,
  widthMm: 50,
  heightMm: 50,
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

interface GeneratorState {
  sourceImage: SourceImage | null
  importedLineart: ImportedLineart | null
  previewMode: PreviewMode
  lineartSettings: LineartSettings
  baseplateSettings: BaseplateSettings
  extrudeSettings: ExtrudeSettings
  printBedSettings: PrintBedSettings
  customThreeMfProfile: ThreeMfTemplateProfile | null
  setSourceImage: (sourceImage: SourceImage | null) => void
  setImportedLineart: (importedLineart: ImportedLineart | null) => void
  setPreviewMode: (mode: PreviewMode) => void
  updateLineartSettings: (patch: Partial<LineartSettings>) => void
  updateBaseplateSettings: (patch: Partial<BaseplateSettings>) => void
  updateExtrudeSettings: (patch: Partial<ExtrudeSettings>) => void
  updatePrintBedSettings: (patch: Partial<PrintBedSettings>) => void
  setCustomThreeMfProfile: (profile: ThreeMfTemplateProfile | null) => void
  resetAllSettings: (defaultBedPatch?: Partial<PrintBedSettings>) => void
}

interface PersistedGeneratorSettings {
  lineartSettings: LineartSettings
  baseplateSettings: BaseplateSettings
  extrudeSettings: ExtrudeSettings
  printBedSettings: PrintBedSettings
  customThreeMfProfile?: ThreeMfTemplateProfile | null
}

function loadPersistedSettings(): PersistedGeneratorSettings | null {
  if (typeof window === 'undefined') {
    return null
  }

  try {
    const raw = window.localStorage.getItem(SETTINGS_STORAGE_KEY)
    if (!raw) {
      return null
    }

    const parsed = JSON.parse(raw) as Partial<PersistedGeneratorSettings>
    return {
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
      customThreeMfProfile: parsed.customThreeMfProfile ?? null,
    }
  } catch {
    return null
  }
}

function savePersistedSettings(settings: PersistedGeneratorSettings) {
  if (typeof window === 'undefined') {
    return
  }

  try {
    window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings))
  } catch {
    // Ignore storage failures so the editor can continue working.
  }
}

const persistedSettings = loadPersistedSettings()

export const useGeneratorStore = create<GeneratorState>((set, get) => ({
  sourceImage: null,
  importedLineart: null,
  previewMode: '分层预览',
  lineartSettings: persistedSettings?.lineartSettings ?? defaultLineartSettings,
  baseplateSettings: persistedSettings?.baseplateSettings ?? defaultBaseplateSettings,
  extrudeSettings: persistedSettings?.extrudeSettings ?? defaultExtrudeSettings,
  printBedSettings: persistedSettings?.printBedSettings ?? defaultPrintBedSettings,
  customThreeMfProfile: persistedSettings?.customThreeMfProfile ?? null,
  setSourceImage: (sourceImage) => set({ sourceImage, importedLineart: null }),
  setImportedLineart: (importedLineart) => set({ importedLineart, sourceImage: null }),
  setPreviewMode: (previewMode) => set({ previewMode }),
  updateLineartSettings: (patch) => set((state) => {
    const lineartSettings = {
      ...state.lineartSettings,
      ...patch,
    }
    savePersistedSettings({
      lineartSettings,
      baseplateSettings: get().baseplateSettings,
      extrudeSettings: get().extrudeSettings,
      printBedSettings: get().printBedSettings,
      customThreeMfProfile: get().customThreeMfProfile,
    })
    return { lineartSettings }
  }),
  updateBaseplateSettings: (patch) => set((state) => {
    const baseplateSettings = {
      ...state.baseplateSettings,
      ...patch,
    }
    savePersistedSettings({
      lineartSettings: get().lineartSettings,
      baseplateSettings,
      extrudeSettings: get().extrudeSettings,
      printBedSettings: get().printBedSettings,
      customThreeMfProfile: get().customThreeMfProfile,
    })
    return { baseplateSettings }
  }),
  updateExtrudeSettings: (patch) => set((state) => {
    const extrudeSettings = {
      ...state.extrudeSettings,
      ...patch,
    }
    savePersistedSettings({
      lineartSettings: get().lineartSettings,
      baseplateSettings: get().baseplateSettings,
      extrudeSettings,
      printBedSettings: get().printBedSettings,
      customThreeMfProfile: get().customThreeMfProfile,
    })
    return { extrudeSettings }
  }),
  updatePrintBedSettings: (patch) => set((state) => {
    const printBedSettings = {
      ...state.printBedSettings,
      ...patch,
    }
    savePersistedSettings({
      lineartSettings: get().lineartSettings,
      baseplateSettings: get().baseplateSettings,
      extrudeSettings: get().extrudeSettings,
      printBedSettings,
      customThreeMfProfile: get().customThreeMfProfile,
    })
    return { printBedSettings }
  }),
  setCustomThreeMfProfile: (customThreeMfProfile) => {
    savePersistedSettings({
      lineartSettings: get().lineartSettings,
      baseplateSettings: get().baseplateSettings,
      extrudeSettings: get().extrudeSettings,
      printBedSettings: get().printBedSettings,
      customThreeMfProfile,
    })
    set({ customThreeMfProfile })
  },
  resetAllSettings: (defaultBedPatch) => {
    const printBedSettings = {
      ...defaultPrintBedSettings,
      ...defaultBedPatch,
    }
    savePersistedSettings({
      lineartSettings: defaultLineartSettings,
      baseplateSettings: defaultBaseplateSettings,
      extrudeSettings: defaultExtrudeSettings,
      printBedSettings,
      customThreeMfProfile: null,
    })
    set({
      lineartSettings: defaultLineartSettings,
      baseplateSettings: defaultBaseplateSettings,
      extrudeSettings: defaultExtrudeSettings,
      printBedSettings,
      customThreeMfProfile: null,
    })
  },
}))
