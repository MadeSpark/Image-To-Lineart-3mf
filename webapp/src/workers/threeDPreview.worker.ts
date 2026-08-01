/// <reference lib="webworker" />

import type { BaseplateSettings, ExtrudeSettings, ProcessedArtwork } from '../types/generator'
import { buildPreviewModelGltfBlob } from '../utils/generator'

type PreviewModelArtworkPayload = Pick<
  ProcessedArtwork,
  'baseLoops' | 'lineLoops' | 'boardWidthMm' | 'boardHeightMm' | 'pixelsPerMm'
>

interface BuildPreviewModelMessage {
  requestId: number
  artwork: PreviewModelArtworkPayload
  baseplateSettings: BaseplateSettings
  extrudeSettings: ExtrudeSettings
}

interface BuildPreviewModelResult {
  requestId: number
  buffer: ArrayBuffer
  error?: string
}

const workerScope = self as unknown as DedicatedWorkerGlobalScope

workerScope.onmessage = async (event: MessageEvent<BuildPreviewModelMessage>) => {
  const { requestId, artwork, baseplateSettings, extrudeSettings } = event.data
  // #region debug-point A:worker-received-request
  typeof fetch === 'function' && fetch('http://127.0.0.1:7777/event', { method: 'POST', body: JSON.stringify({ sessionId: 'invalid-string-length', runId: 'pre-fix', hypothesisId: 'A', location: 'threeDPreview.worker.ts:onmessage', msg: '[DEBUG] worker received preview build request', data: { requestId, boardWidthMm: artwork.boardWidthMm, boardHeightMm: artwork.boardHeightMm, pixelsPerMm: artwork.pixelsPerMm, baseColor: baseplateSettings.baseColor, lineColor: baseplateSettings.lineColor, baseThicknessMm: extrudeSettings.baseThicknessMm, lineHeightMm: extrudeSettings.lineHeightMm, lineThicknessMm: extrudeSettings.lineThicknessMm }, ts: Date.now() }) }).catch(() => {})
  // #endregion

  try {
    const blob = buildPreviewModelGltfBlob(artwork, baseplateSettings, extrudeSettings)
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
