import { useEffect, useRef, useState } from 'react'
import type {
  BaseplateSettings,
  ExtrudeSettings,
  ImportedLineart,
  LineartSettings,
  ProcessedArtwork,
  SealSettings,
  SourceImage,
  WorkMode,
} from '@/types/generator'
import { processArtwork } from '@/utils/generator'

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
) {
  const [state, setState] = useState<ProcessorState>({
    artwork: null,
    processing: false,
    error: null,
  })
  const inputRef = useRef({
    sourceImage,
    importedLineart,
    lineartSettings,
    baseplateSettings,
    extrudeSettings,
    sealSettings,
    workMode,
  })

  useEffect(() => {
    inputRef.current = {
      sourceImage,
      importedLineart,
      lineartSettings,
      baseplateSettings,
      extrudeSettings,
      sealSettings,
      workMode,
    }
  }, [baseplateSettings, extrudeSettings, importedLineart, lineartSettings, sourceImage, sealSettings, workMode])

  useEffect(() => {
    let mounted = true

    if (!sourceImage && !importedLineart) {
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

    processArtwork(inputRef.current)
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
  }, [baseplateSettings, extrudeSettings, importedLineart, lineartSettings, sourceImage, sealSettings, workMode])

  return {
    artwork: state.artwork,
    processing: state.processing,
    error: state.error,
  }
}
