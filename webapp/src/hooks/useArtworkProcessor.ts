import { useEffect, useRef, useState } from 'react'
import type {
  BaseplateSettings,
  ExtrudeSettings,
  ImportedLineart,
  LineartSettings,
  ProcessedArtwork,
  SourceImage,
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
  })

  useEffect(() => {
    inputRef.current = {
      sourceImage,
      importedLineart,
      lineartSettings,
      baseplateSettings,
      extrudeSettings,
    }
  }, [baseplateSettings, extrudeSettings, importedLineart, lineartSettings, sourceImage])

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
  }, [baseplateSettings, extrudeSettings, importedLineart, lineartSettings, sourceImage])

  return {
    artwork: state.artwork,
    processing: state.processing,
    error: state.error,
  }
}
