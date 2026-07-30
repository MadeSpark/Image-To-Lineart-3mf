import { create } from 'zustand'
import type {
  BaseplateSettings,
  ExtrudeSettings,
  ImportedLineart,
  LineartSettings,
  PreviewMode,
  SourceImage,
} from '@/types/generator'

const SETTINGS_STORAGE_KEY = 'lineart-baseplate-generator-settings'

const defaultLineartSettings: LineartSettings = {
  detail: 100,
  threshold: 160,
  targetColor: '#000000',
  despeckle: 24,
  strokeWidth: 0.4,
  smoothing: 36,
  invert: false,
  mirror: false,
}

const defaultBaseplateSettings: BaseplateSettings = {
  template: 'outline',
  expandMm: 2,
  widthMm: 50,
  heightMm: 50,
  diameterMm: 50,
  marginMm: 4,
  lineColor: '#111111',
  baseColor: '#f3f6fb',
}

const defaultExtrudeSettings: ExtrudeSettings = {
  baseThicknessMm: 0.2,
  lineThicknessMm: 0.2,
  lineHeightMm: 0.2,
}

interface GeneratorState {
  sourceImage: SourceImage | null
  importedLineart: ImportedLineart | null
  previewMode: PreviewMode
  lineartSettings: LineartSettings
  baseplateSettings: BaseplateSettings
  extrudeSettings: ExtrudeSettings
  setSourceImage: (sourceImage: SourceImage | null) => void
  setImportedLineart: (importedLineart: ImportedLineart | null) => void
  setPreviewMode: (mode: PreviewMode) => void
  updateLineartSettings: (patch: Partial<LineartSettings>) => void
  updateBaseplateSettings: (patch: Partial<BaseplateSettings>) => void
  updateExtrudeSettings: (patch: Partial<ExtrudeSettings>) => void
}

interface PersistedGeneratorSettings {
  lineartSettings: LineartSettings
  baseplateSettings: BaseplateSettings
  extrudeSettings: ExtrudeSettings
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
    })
    return { extrudeSettings }
  }),
}))
