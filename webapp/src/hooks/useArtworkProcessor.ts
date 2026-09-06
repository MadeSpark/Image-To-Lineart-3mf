import { useEffect, useRef, useState } from 'react'
import type {
  BaseplateSettings,
  ExtrudeSettings,
  ImportedLineart,
  LightReliefSettings,
  LineartSettings,
  ProcessedArtwork,
  SealSettings,
  StringArtSettings,
  SourceImage,
  WorkMode,
} from '@/types/generator'
import { processArtwork, processLightReliefArtwork } from '@/utils/generator'
import { processStringArtArtwork } from '@/utils/stringArt'

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
  stringArtSettings?: StringArtSettings,
  stringArtPrintProfile?: { lineWidthMm: number; layerHeightMm: number },
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
    stringArtSettings,
    stringArtPrintProfile,
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
      stringArtSettings,
      stringArtPrintProfile,
    }
  }, [baseplateSettings, extrudeSettings, importedLineart, lineartSettings, sourceImage, sourceImageB, sealSettings, workMode, lightReliefSettings, stringArtSettings, stringArtPrintProfile])

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

    const promise = workMode === 'string-art' && stringArtSettings
      ? sourceImage
        ? processStringArtArtwork(sourceImage, stringArtSettings, stringArtPrintProfile?.lineWidthMm ?? 0.42, stringArtPrintProfile?.layerHeightMm ?? 0.2)
        : Promise.reject(new Error('弦丝画模式只支持图片，不支持 DXF。'))
      : workMode === 'light-relief' && lightReliefSettings
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
  }, [baseplateSettings, extrudeSettings, importedLineart, lineartSettings, sourceImage, sourceImageB, sealSettings, workMode, lightReliefSettings, stringArtSettings, stringArtPrintProfile])

  return {
    artwork: state.artwork,
    processing: state.processing,
    error: state.error,
  }
}
