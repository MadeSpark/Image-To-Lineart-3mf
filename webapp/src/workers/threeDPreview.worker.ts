/// <reference lib="webworker" />

import type { BaseplateSettings, ExtrudeSettings, LightReliefSettings, LineartSettings, ProcessedArtwork, SealSettings, WorkMode } from '../types/generator'
import { buildLightReliefPreviewModelGltfBlob, buildPreviewModelGltfBlob, buildSealPreviewModelGltfBlob } from '../utils/generator'

type PreviewModelArtworkPayload = Pick<
  ProcessedArtwork,
  'baseLoops' | 'lineLoops' | 'lineLoopsB' | 'bFaceHeightMap' | 'strokeLoops' | 'boardWidthMm' | 'boardHeightMm' | 'pixelsPerMm'
>

interface BuildPreviewModelMessage {
  requestId: number
  artwork: PreviewModelArtworkPayload
  baseplateSettings: BaseplateSettings
  extrudeSettings: ExtrudeSettings
  sealSettings?: SealSettings
  lightReliefSettings?: LightReliefSettings
  workMode?: WorkMode
  lineartSettings?: LineartSettings
}

interface BuildPreviewModelResult {
  requestId: number
  buffer: ArrayBuffer
  error?: string
}

const workerScope = self as unknown as DedicatedWorkerGlobalScope

workerScope.onmessage = async (event: MessageEvent<BuildPreviewModelMessage>) => {
  const { requestId, artwork, baseplateSettings, extrudeSettings, sealSettings, lightReliefSettings, workMode, lineartSettings } = event.data
  // #region debug-point A:worker-received-request
  typeof fetch === 'function' && fetch('http://127.0.0.1:7777/event', { method: 'POST', body: JSON.stringify({ sessionId: 'invalid-string-length', runId: 'pre-fix', hypothesisId: 'A', location: 'threeDPreview.worker.ts:onmessage', msg: '[DEBUG] worker received preview build request', data: { requestId, boardWidthMm: artwork.boardWidthMm, boardHeightMm: artwork.boardHeightMm, pixelsPerMm: artwork.pixelsPerMm, baseColor: baseplateSettings.baseColor, lineColor: baseplateSettings.lineColor }, ts: Date.now() }) }).catch(() => {})
  // #endregion

  try {
    const blob = workMode === 'light-relief' && lightReliefSettings
      ? buildLightReliefPreviewModelGltfBlob(artwork, baseplateSettings, lightReliefSettings, extrudeSettings, lineartSettings)
      : workMode === 'seal' && sealSettings
        ? buildSealPreviewModelGltfBlob(artwork, baseplateSettings, sealSettings, extrudeSettings, lineartSettings)
        : buildPreviewModelGltfBlob(artwork, baseplateSettings, extrudeSettings, lineartSettings)
    const buffer = await blob.arrayBuffer()
    // #region debug-point A:worker-build-success
    typeof fetch === 'function' && fetch('http://127.0.0.1:7777/event', { method: 'POST', body: JSON.stringify({ sessionId: 'invalid-string-length', runId: 'pre-fix', hypothesisId: 'A', location: 'threeDPreview.worker.ts:success', msg: '[DEBUG] worker built preview model successfully', data: { requestId, bufferBytes: buffer.byteLength }, ts: Date.now() }) }).catch(() => {})
    // #endregion

    const message: BuildPreviewModelResult = {
      requestId,
      buffer,
    }

    workerScope.postMessage(message, [buffer])
  } catch (error) {
    // #region debug-point A:worker-build-error
    typeof fetch === 'function' && fetch('http://127.0.0.1:7777/event', { method: 'POST', body: JSON.stringify({ sessionId: 'invalid-string-length', runId: 'pre-fix', hypothesisId: 'A', location: 'threeDPreview.worker.ts:error', msg: '[DEBUG] worker failed to build preview model', data: { requestId, error: error instanceof Error ? error.message : '3D 预览构建失败' }, ts: Date.now() }) }).catch(() => {})
    // #endregion
    const message: BuildPreviewModelResult = {
      requestId,
      buffer: new ArrayBuffer(0),
      error: error instanceof Error ? error.message : '3D 预览构建失败',
    }

    workerScope.postMessage(message)
  }
}
