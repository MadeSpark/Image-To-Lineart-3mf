import { Box, LoaderCircle } from 'lucide-react'
import type { CSSProperties } from 'react'
import { useEffect, useRef, useState } from 'react'
import type { BaseplateSettings, ExtrudeSettings, ProcessedArtwork, SealSettings, WorkMode } from '@/types/generator'

let modelViewerImportPromise: Promise<unknown> | null = null
const previewModelCache = new WeakMap<ProcessedArtwork, Map<string, string>>()

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
  workMode?: WorkMode,
) {
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
    ].join('|')
  }
  return [
    baseplateSettings.baseColor,
    baseplateSettings.lineColor,
    extrudeSettings.baseThicknessMm,
    extrudeSettings.lineHeightMm,
    extrudeSettings.lineThicknessMm,
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
    existing.set(cacheKey, url)
    return
  }

  previewModelCache.set(artwork, new Map([[cacheKey, url]]))
}

interface ThreeDModelViewerProps {
  artwork: ProcessedArtwork
  baseplateSettings: BaseplateSettings
  extrudeSettings: ExtrudeSettings
  sealSettings?: SealSettings
  workMode?: WorkMode
}

export function ThreeDModelViewer({
  artwork,
  baseplateSettings,
  extrudeSettings,
  sealSettings,
  workMode = 'filigree',
}: ThreeDModelViewerProps) {
  const [modelUrl, setModelUrl] = useState<string | null>(null)
  const [isBuilding, setIsBuilding] = useState(false)
  const [buildError, setBuildError] = useState<string | null>(null)
  const isSealMode = workMode === 'seal' && sealSettings
  const modelHeight = isSealMode
    ? (sealSettings!.sealHeightMm + sealSettings!.engravingHeightDiffMm)
    : (extrudeSettings.lineHeightMm + extrudeSettings.lineThicknessMm)
  const cameraTarget = `0m ${Math.max(modelHeight * 0.5, 0.25)}m 0m`

  useEffect(() => {
    const cacheKey = getPreviewCacheKey(baseplateSettings, extrudeSettings, sealSettings, workMode)
    const cachedUrl = getCachedPreviewModelUrl(artwork, cacheKey)
    if (cachedUrl) {
      // #region debug-point A:viewer-cache-hit
      typeof fetch === 'function' && fetch('http://127.0.0.1:7777/event', { method: 'POST', body: JSON.stringify({ sessionId: 'invalid-string-length', runId: 'pre-fix', hypothesisId: 'A', location: 'ThreeDModelViewer.tsx:cacheHit', msg: '[DEBUG] viewer reused cached preview model', data: { cacheKey, boardWidthMm: artwork.boardWidthMm, boardHeightMm: artwork.boardHeightMm }, ts: Date.now() }) }).catch(() => {})
      // #endregion
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
      // #region debug-point A:viewer-build-start
      typeof fetch === 'function' && fetch('http://127.0.0.1:7777/event', { method: 'POST', body: JSON.stringify({ sessionId: 'invalid-string-length', runId: 'pre-fix', hypothesisId: 'A', location: 'ThreeDModelViewer.tsx:assignModel', msg: '[DEBUG] viewer started preview model build', data: { requestId, cacheKey, boardWidthMm: artwork.boardWidthMm, boardHeightMm: artwork.boardHeightMm, pixelsPerMm: artwork.pixelsPerMm }, ts: Date.now() }) }).catch(() => {})
      // #endregion
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
          // #region debug-point A:viewer-worker-error
          typeof fetch === 'function' && fetch('http://127.0.0.1:7777/event', { method: 'POST', body: JSON.stringify({ sessionId: 'invalid-string-length', runId: 'pre-fix', hypothesisId: 'A', location: 'ThreeDModelViewer.tsx:onmessage:error', msg: '[DEBUG] viewer received worker error', data: { requestId, error: event.data.error }, ts: Date.now() }) }).catch(() => {})
          // #endregion
          setBuildError(event.data.error)
          setIsBuilding(false)
          return
        }

        const nextUrl = URL.createObjectURL(new Blob([event.data.buffer], { type: 'model/gltf+json' }))
        // #region debug-point A:viewer-worker-success
        typeof fetch === 'function' && fetch('http://127.0.0.1:7777/event', { method: 'POST', body: JSON.stringify({ sessionId: 'invalid-string-length', runId: 'pre-fix', hypothesisId: 'A', location: 'ThreeDModelViewer.tsx:onmessage:success', msg: '[DEBUG] viewer received worker success', data: { requestId, bufferBytes: event.data.buffer.byteLength }, ts: Date.now() }) }).catch(() => {})
        // #endregion
        setCachedPreviewModelUrl(artwork, cacheKey, nextUrl)
        setModelUrl(nextUrl)
        setBuildError(null)
        setIsBuilding(false)
      }
      worker.onerror = () => {
        if (cancelled) {
          return
        }
        // #region debug-point A:viewer-worker-onerror
        typeof fetch === 'function' && fetch('http://127.0.0.1:7777/event', { method: 'POST', body: JSON.stringify({ sessionId: 'invalid-string-length', runId: 'pre-fix', hypothesisId: 'A', location: 'ThreeDModelViewer.tsx:worker.onerror', msg: '[DEBUG] viewer worker onerror fired', data: { requestId }, ts: Date.now() }) }).catch(() => {})
        // #endregion
        setBuildError('3D 预览构建失败，请稍后重试')
        setIsBuilding(false)
      }

      worker.postMessage({
        requestId,
        artwork: {
          baseLoops: artwork.baseLoops,
          lineLoops: artwork.lineLoops,
          strokeLoops: artwork.strokeLoops,
          boardWidthMm: artwork.boardWidthMm,
          boardHeightMm: artwork.boardHeightMm,
          pixelsPerMm: artwork.pixelsPerMm,
        },
        baseplateSettings,
        extrudeSettings,
        sealSettings,
        workMode,
      })
    }

    void assignModel()

    return () => {
      cancelled = true
      setIsBuilding(false)
      worker.terminate()
    }
  }, [artwork, baseplateSettings, extrudeSettings, sealSettings, workMode])

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
