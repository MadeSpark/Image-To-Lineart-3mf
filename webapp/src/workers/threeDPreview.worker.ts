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

  try {
    const blob = workMode === 'light-relief' && lightReliefSettings
      ? buildLightReliefPreviewModelGltfBlob(artwork, baseplateSettings, lightReliefSettings, extrudeSettings, lineartSettings)
      : workMode === 'seal' && sealSettings
        ? buildSealPreviewModelGltfBlob(artwork, baseplateSettings, sealSettings, extrudeSettings, lineartSettings)
        : buildPreviewModelGltfBlob(artwork, baseplateSettings, extrudeSettings, lineartSettings)
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
