import { useEffect, useRef, useState } from 'react'
import type {
  BaseplateSettings,
  ExtrudeSettings,
  ImportedLineart,
  LightReliefSettings,
  LineartSettings,
  ProcessedArtwork,
  SealSettings,
  SourceImage,
  WorkMode,
} from '@/types/generator'
import { processArtwork, processLightReliefArtwork } from '@/utils/generator'

interface ProcessorState {
  artwork: ProcessedArtwork | null
  processing: boolean
  error: string | null
}

export function useArtworkProcessor(
  sourceImage: SourceImage | null,
  importedLineart: ImportedLineart | null,
  lineartSettings: LineartSettings,
  baseplateSettings: BaseplateSettings,
  extrudeSettings: ExtrudeSettings,
  sealSettings?: SealSettings,
  workMode?: WorkMode,
  lightReliefSettings?: LightReliefSettings,
  sourceImageB?: SourceImage | null,
) {
  const [state, setState] = useState<ProcessorState>({
    artwork: null,
    processing: false,
    error: null,
  })
  const inputRef = useRef({
    sourceImage,
    importedLineart,
    sourceImageB,
    lineartSettings,
    baseplateSettings,
    extrudeSettings,
    sealSettings,
    workMode,
    lightReliefSettings,
  })

  useEffect(() => {
    inputRef.current = {
      sourceImage,
      importedLineart,
      sourceImageB,
      lineartSettings,
      baseplateSettings,
      extrudeSettings,
      sealSettings,
      workMode,
      lightReliefSettings,
    }
  }, [baseplateSettings, extrudeSettings, importedLineart, lineartSettings, sourceImage, sourceImageB, sealSettings, workMode, lightReliefSettings])

  useEffect(() => {
    let mounted = true

    const hasSourceA = !!(sourceImage || importedLineart)
    if (!hasSourceA) {
      setState({
        artwork: null,
        processing: false,
        error: null,
      })
      return () => {
        mounted = false
      }
    }

    setState((current) => ({
      ...current,
      processing: true,
      error: null,
    }))

    const promise = workMode === 'light-relief' && lightReliefSettings
      ? processLightReliefArtwork({
          sourceImage: inputRef.current.sourceImage,
          importedLineart: inputRef.current.importedLineart,
          sourceImageB: inputRef.current.sourceImageB ?? null,
          lineartSettings: inputRef.current.lineartSettings,
          baseplateSettings: inputRef.current.baseplateSettings,
          lightReliefSettings: inputRef.current.lightReliefSettings!,
        })
      : processArtwork(inputRef.current)

    promise
      .then((artwork) => {
        if (!mounted) return
        setState({
          artwork,
          processing: false,
          error: null,
        })
      })
      .catch((error: Error) => {
        if (!mounted) return
        setState({
          artwork: null,
          processing: false,
          error: error.message,
        })
      })

    return () => {
      mounted = false
    }
  }, [baseplateSettings, extrudeSettings, importedLineart, lineartSettings, sourceImage, sourceImageB, sealSettings, workMode, lightReliefSettings])

  return {
    artwork: state.artwork,
    processing: state.processing,
    error: state.error,
  }
}
