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

  try {
    const blob = buildPreviewModelGltfBlob(artwork, baseplateSettings, extrudeSettings)
    const buffer = await blob.arrayBuffer()

    const message: BuildPreviewModelResult = {
      requestId,
      buffer,
    }

    workerScope.postMessage(message, [buffer])
  } catch (error) {
    const message: BuildPreviewModelResult = {
      requestId,
      buffer: new ArrayBuffer(0),
      error: error instanceof Error ? error.message : '3D 预览构建失败',
    }

    workerScope.postMessage(message)
  }
}
