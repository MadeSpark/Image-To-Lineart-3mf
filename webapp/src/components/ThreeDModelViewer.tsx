import { Box, LoaderCircle } from 'lucide-react'
import type { CSSProperties } from 'react'
import { useEffect, useRef, useState } from 'react'
import type { BaseplateSettings, ExtrudeSettings, LightReliefSettings, LineartSettings, ProcessedArtwork, SealSettings, WorkMode } from '@/types/generator'

let modelViewerImportPromise: Promise<unknown> | null = null
const previewModelCache = new WeakMap<ProcessedArtwork, Map<string, string>>()
const MAX_CACHED_MODELS_PER_ARTWORK = 3

function ensureModelViewerDefined() {
  if (typeof window === 'undefined') {
    return Promise.resolve()
  }

  if (window.customElements.get('model-viewer')) {
    return Promise.resolve()
  }

  modelViewerImportPromise ??= import('@google/model-viewer')
  return modelViewerImportPromise
}

function getPreviewCacheKey(
  baseplateSettings: BaseplateSettings,
  extrudeSettings: ExtrudeSettings,
  sealSettings?: SealSettings,
  lightReliefSettings?: LightReliefSettings,
  workMode?: WorkMode,
  lineartSettings?: LineartSettings,
) {
  const expandStrokeMm = lineartSettings?.expandStrokeMm ?? 0
  const shrinkStrokeMm = lineartSettings?.shrinkStrokeMm ?? 0
  if (workMode === 'seal' && sealSettings) {
    return [
      baseplateSettings.baseColor,
      baseplateSettings.lineColor,
      workMode,
      sealSettings.sealHeightMm,
      sealSettings.engravingHeightDiffMm,
      sealSettings.carvingMode,
      sealSettings.strokeEnabled,
      sealSettings.strokeWidthMm,
      expandStrokeMm,
      shrinkStrokeMm,
      extrudeSettings.minLineWidthMm,
    ].join('|')
  }
  if (workMode === 'light-relief' && lightReliefSettings) {
    return [
      baseplateSettings.baseColor,
      baseplateSettings.lineColor,
      workMode,
      lightReliefSettings.totalHeightMm,
      lightReliefSettings.faceAZMm,
      lightReliefSettings.faceAHeightMm,
      lightReliefSettings.faceBZMm,
      lightReliefSettings.faceBHeightMm,
      expandStrokeMm,
      shrinkStrokeMm,
      extrudeSettings.minLineWidthMm,
    ].join('|')
  }
  return [
    baseplateSettings.baseColor,
    baseplateSettings.lineColor,
    extrudeSettings.baseThicknessMm,
    extrudeSettings.lineHeightMm,
    extrudeSettings.lineThicknessMm,
    expandStrokeMm,
    shrinkStrokeMm,
    extrudeSettings.minLineWidthMm,
  ].join('|')
}

function getCachedPreviewModelUrl(
  artwork: ProcessedArtwork,
  cacheKey: string,
) {
  return previewModelCache.get(artwork)?.get(cacheKey) ?? null
}

function setCachedPreviewModelUrl(
  artwork: ProcessedArtwork,
  cacheKey: string,
  url: string,
) {
  const existing = previewModelCache.get(artwork)
  if (existing) {
    const previous = existing.get(cacheKey)
    if (previous && previous !== url) URL.revokeObjectURL(previous)
    existing.set(cacheKey, url)
    while (existing.size > MAX_CACHED_MODELS_PER_ARTWORK) {
      const oldestKey = existing.keys().next().value
      if (!oldestKey) break
      const oldestUrl = existing.get(oldestKey)
      existing.delete(oldestKey)
      if (oldestUrl) URL.revokeObjectURL(oldestUrl)
    }
    return
  }

  previewModelCache.set(artwork, new Map([[cacheKey, url]]))
}

interface ThreeDModelViewerProps {
  artwork: ProcessedArtwork
  baseplateSettings: BaseplateSettings
  extrudeSettings: ExtrudeSettings
  sealSettings?: SealSettings
  lightReliefSettings?: LightReliefSettings
  workMode?: WorkMode
  lineartSettings?: LineartSettings
}

export function ThreeDModelViewer({
  artwork,
  baseplateSettings,
  extrudeSettings,
  sealSettings,
  lightReliefSettings,
  workMode = 'filigree',
  lineartSettings,
}: ThreeDModelViewerProps) {
  const [modelUrl, setModelUrl] = useState<string | null>(null)
  const [isBuilding, setIsBuilding] = useState(false)
  const [buildError, setBuildError] = useState<string | null>(null)
  const isSealMode = workMode === 'seal' && sealSettings
  const isLightReliefMode = workMode === 'light-relief' && lightReliefSettings
  const modelHeight = isSealMode
    ? (sealSettings!.sealHeightMm + sealSettings!.engravingHeightDiffMm)
    : isLightReliefMode
      ? lightReliefSettings!.totalHeightMm
      : (extrudeSettings.lineHeightMm + extrudeSettings.lineThicknessMm)
  const cameraTarget = `0m ${Math.max(modelHeight * 0.5, 0.25)}m 0m`

  useEffect(() => {
    const cacheKey = getPreviewCacheKey(baseplateSettings, extrudeSettings, sealSettings, lightReliefSettings, workMode, lineartSettings)
    const cachedUrl = getCachedPreviewModelUrl(artwork, cacheKey)
    if (cachedUrl) {
      void ensureModelViewerDefined()
      setModelUrl(cachedUrl)
      setBuildError(null)
      setIsBuilding(false)
      return
    }

    let cancelled = false
    const worker = new Worker(new URL('../workers/threeDPreview.worker.ts', import.meta.url), { type: 'module' })
    const requestId = Date.now()

    const assignModel = async () => {
      setModelUrl(null)
      setIsBuilding(true)
      setBuildError(null)
      await ensureModelViewerDefined()
      if (cancelled) return

      worker.onmessage = (event: MessageEvent<{ requestId: number; buffer: ArrayBuffer; error?: string }>) => {
        if (cancelled || event.data.requestId !== requestId) {
          return
        }

        if (event.data.error) {
          setBuildError(event.data.error)
          setIsBuilding(false)
          return
        }

        const nextUrl = URL.createObjectURL(new Blob([event.data.buffer], { type: 'model/gltf+json' }))
        setCachedPreviewModelUrl(artwork, cacheKey, nextUrl)
        setModelUrl(nextUrl)
        setBuildError(null)
        setIsBuilding(false)
      }
      worker.onerror = () => {
        if (cancelled) {
          return
        }
        setBuildError('3D 预览构建失败，请稍后重试')
        setIsBuilding(false)
      }

      worker.postMessage({
        requestId,
        artwork: {
          baseLoops: artwork.baseLoops,
          lineLoops: artwork.lineLoops,
          lineLoopsB: artwork.lineLoopsB,
          strokeLoops: artwork.strokeLoops,
          boardWidthMm: artwork.boardWidthMm,
          boardHeightMm: artwork.boardHeightMm,
          pixelsPerMm: artwork.pixelsPerMm,
        },
        baseplateSettings,
        extrudeSettings,
        sealSettings,
        lightReliefSettings,
        workMode,
        lineartSettings,
      })
    }

    void assignModel()

    return () => {
      cancelled = true
      setIsBuilding(false)
      worker.terminate()
    }
  }, [artwork, baseplateSettings, extrudeSettings, sealSettings, lightReliefSettings, workMode, lineartSettings])

  return (
    <div className="relative h-full w-full">
      {modelUrl ? (
        <model-viewer
          src={modelUrl}
          alt="线稿底板 3D 预览"
          camera-controls
          camera-orbit="38deg 68deg 65%"
          camera-target={cameraTarget}
          disable-pan
          exposure="1.06"
          field-of-view="18deg"
          interaction-prompt="none"
          min-camera-orbit="auto auto 35%"
          max-camera-orbit="auto auto 300%"
          shadow-intensity="0.9"
          touch-action="pan-y"
          style={{ width: '100%', height: '100%' } as CSSProperties}
        />
      ) : null}

      {isBuilding && (
        <div className="absolute inset-0 flex items-center justify-center bg-white/80 backdrop-blur-sm">
          <div className="flex items-center gap-2 text-sm text-slate-600">
            <LoaderCircle className="h-4 w-4 animate-spin" />
            正在构建 3D 预览…
          </div>
        </div>
      )}

      {buildError && !isBuilding && (
        <div className="absolute inset-0 flex items-center justify-center bg-white/80 backdrop-blur-sm">
          <div className="flex items-center gap-2 text-sm text-red-600">
            <Box className="h-4 w-4" />
            {buildError}
          </div>
        </div>
      )}
    </div>
  )
}
