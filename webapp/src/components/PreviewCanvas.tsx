import { LoaderCircle, MoveDiagonal2, Pipette } from 'lucide-react'
import type { PointerEvent as ReactPointerEvent, WheelEvent as ReactWheelEvent } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  BaseplateSettings,
  ExtrudeSettings,
  PreviewMode,
  ProcessedArtwork,
  SourceImage,
  VectorLoop,
  VectorPoint,
} from '@/types/generator'

interface PreviewCanvasProps {
  sourceImage: SourceImage | null
  artwork: ProcessedArtwork | null
  previewMode: PreviewMode
  processing: boolean
  error: string | null
  targetColor: string
  baseplateSettings: BaseplateSettings
  extrudeSettings: ExtrudeSettings
  onPickTargetColor: (color: string) => void
}

export function PreviewCanvas({
  sourceImage,
  artwork,
  previewMode,
  processing,
  error,
  targetColor,
  baseplateSettings,
  extrudeSettings,
  onPickTargetColor,
}: PreviewCanvasProps) {
  const imageRef = useRef<HTMLImageElement | null>(null)
  const sampleCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const viewportRef = useRef<HTMLDivElement | null>(null)
  const interactionRef = useRef<{
    mode: 'pan' | 'pick' | 'rotate' | null
    pointerId: number | null
    lastX: number
    lastY: number
  }>({
    mode: null,
    pointerId: null,
    lastX: 0,
    lastY: 0,
  })
  const [isPicking, setIsPicking] = useState(false)
  const [draftPickedColor, setDraftPickedColor] = useState<string | null>(null)
  const [viewTransform, setViewTransform] = useState({
    scale: 1,
    panX: 0,
    panY: 0,
    rotateX: 18,
    rotateZ: -10,
  })

  useEffect(() => {
    if (!sourceImage) {
      sampleCanvasRef.current = null
      setDraftPickedColor(null)
      return
    }

    let mounted = true
    const image = new Image()
    image.onload = () => {
      if (!mounted) return
      const canvas = document.createElement('canvas')
      canvas.width = image.naturalWidth
      canvas.height = image.naturalHeight
      const context = canvas.getContext('2d', { willReadFrequently: true })
      if (!context) return
      context.drawImage(image, 0, 0)
      sampleCanvasRef.current = canvas
    }
    image.src = sourceImage.dataUrl

    return () => {
      mounted = false
    }
  }, [sourceImage])

  useEffect(() => {
    if (!isPicking) {
      setDraftPickedColor(null)
    }
  }, [isPicking, targetColor, previewMode])

  useEffect(() => {
    setViewTransform({
      scale: 1,
      panX: 0,
      panY: 0,
      rotateX: 18,
      rotateZ: -10,
    })
    interactionRef.current = {
      mode: null,
      pointerId: null,
      lastX: 0,
      lastY: 0,
    }
  }, [artwork, previewMode, sourceImage?.dataUrl])

  const src = (() => {
    if (!artwork) return null
    if (previewMode === '原图') return sourceImage?.dataUrl ?? artwork.previews.lineartDataUrl
    if (previewMode === '线稿') return artwork.previews.lineartDataUrl
    if (previewMode === '底板预览') return artwork.previews.baseplateDataUrl
    if (previewMode === '3D预览') return null
    return artwork.previews.compositeDataUrl
  })()
  const canPickColor = Boolean(sourceImage && previewMode === '原图' && !processing)
  const displayColor = draftPickedColor ?? targetColor
  const scene3d = useMemo(() => {
    if (!artwork || previewMode !== '3D预览') {
      return null
    }

    return buildThreeDimensionalPreview(artwork, baseplateSettings, extrudeSettings)
  }, [artwork, baseplateSettings, extrudeSettings, previewMode])

  const sampleColor = (clientX: number, clientY: number) => {
    const image = imageRef.current
    const sampleCanvas = sampleCanvasRef.current
    if (!image || !sampleCanvas) return null

    const rect = image.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return null

    const ratioX = (clientX - rect.left) / rect.width
    const ratioY = (clientY - rect.top) / rect.height
    const x = Math.min(sampleCanvas.width - 1, Math.max(0, Math.round(ratioX * (sampleCanvas.width - 1))))
    const y = Math.min(sampleCanvas.height - 1, Math.max(0, Math.round(ratioY * (sampleCanvas.height - 1))))
    const context = sampleCanvas.getContext('2d', { willReadFrequently: true })
    if (!context) return null
    const pixel = context.getImageData(x, y, 1, 1).data
    if (pixel[3] < 8) return null

    return rgbToHex(pixel[0], pixel[1], pixel[2])
  }

  const handleViewportPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    const viewport = viewportRef.current
    if (!viewport) return

    let mode: 'pan' | 'pick' | 'rotate' | null = null
    if (previewMode === '3D预览' && event.button === 2) {
      mode = 'rotate'
    } else if (event.button === 0 && canPickColor && event.shiftKey) {
      mode = 'pick'
      setIsPicking(true)
      setDraftPickedColor(sampleColor(event.clientX, event.clientY))
    } else if (event.button === 0) {
      mode = 'pan'
    }

    if (!mode) return

    viewport.setPointerCapture(event.pointerId)
    interactionRef.current = {
      mode,
      pointerId: event.pointerId,
      lastX: event.clientX,
      lastY: event.clientY,
    }
  }

  const handleViewportPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const interaction = interactionRef.current
    if (interaction.pointerId !== event.pointerId || !interaction.mode) {
      return
    }

    const deltaX = event.clientX - interaction.lastX
    const deltaY = event.clientY - interaction.lastY
    interaction.lastX = event.clientX
    interaction.lastY = event.clientY

    if (interaction.mode === 'pan') {
      setViewTransform((current) => ({
        ...current,
        panX: current.panX + deltaX,
        panY: current.panY + deltaY,
      }))
      return
    }

    if (interaction.mode === 'rotate') {
      setViewTransform((current) => ({
        ...current,
        rotateX: clamp(current.rotateX - deltaY * 0.18, -65, 65),
        rotateZ: current.rotateZ + deltaX * 0.3,
      }))
      return
    }

    if (interaction.mode === 'pick') {
      setDraftPickedColor(sampleColor(event.clientX, event.clientY))
    }
  }

  const handleViewportPointerEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    const viewport = viewportRef.current
    const interaction = interactionRef.current
    if (interaction.pointerId !== event.pointerId || !interaction.mode) {
      return
    }

    if (interaction.mode === 'pick') {
      const color = sampleColor(event.clientX, event.clientY) ?? draftPickedColor
      setIsPicking(false)
      if (color) {
        onPickTargetColor(color)
        setDraftPickedColor(color)
      } else {
        setDraftPickedColor(null)
      }
    }

    if (viewport?.hasPointerCapture(event.pointerId)) {
      viewport.releasePointerCapture(event.pointerId)
    }
    interactionRef.current = {
      mode: null,
      pointerId: null,
      lastX: 0,
      lastY: 0,
    }
  }

  const handleViewportWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    const viewport = viewportRef.current
    if (!viewport) return
    event.preventDefault()

    const rect = viewport.getBoundingClientRect()
    const pointerX = event.clientX - rect.left - rect.width / 2
    const pointerY = event.clientY - rect.top - rect.height / 2

    setViewTransform((current) => {
      const nextScale = clamp(current.scale * (event.deltaY < 0 ? 1.12 : 0.9), 0.35, 6)
      const scaleRatio = nextScale / current.scale
      return {
        ...current,
        scale: nextScale,
        panX: pointerX - (pointerX - current.panX) * scaleRatio,
        panY: pointerY - (pointerY - current.panY) * scaleRatio,
      }
    })
  }

  const handleViewportContextMenu = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (previewMode === '3D预览') {
      event.preventDefault()
    }
  }

  const contentTransform = previewMode === '3D预览'
    ? `translate(${viewTransform.panX}px, ${viewTransform.panY}px) scale(${viewTransform.scale}) perspective(1200px) rotateX(${viewTransform.rotateX}deg) rotateZ(${viewTransform.rotateZ}deg)`
    : `translate(${viewTransform.panX}px, ${viewTransform.panY}px) scale(${viewTransform.scale})`
  const interactionHint = previewMode === '3D预览'
    ? '左键拖动画布，滚轮缩放，右键旋转视角'
    : canPickColor
      ? '左键拖动画布，滚轮缩放，Shift+拖动取色'
      : '左键拖动画布，滚轮缩放'
  const contentCursor = isPicking
    ? 'crosshair'
    : previewMode === '3D预览'
      ? 'grab'
      : canPickColor
        ? 'grab'
        : 'grab'

  return (
    <section className="relative overflow-hidden rounded-[32px] border border-slate-200 bg-white shadow-[0_24px_90px_rgba(15,23,42,0.08)]">
      <div className="flex items-center justify-between border-b border-slate-200 px-6 py-4">
        <div>
          <h2 className="text-sm font-semibold text-slate-950">主画布</h2>
          <p className="mt-1 text-xs text-slate-500">画布高度被限制在首屏范围，导入后会优先看到完整排版，而不是把预览挤到页面下方。</p>
        </div>
        <div className="inline-flex items-center gap-2 rounded-full bg-slate-100 px-3 py-1.5 text-[11px] font-medium text-slate-500">
          <MoveDiagonal2 className="h-3.5 w-3.5" />
          当前模式：{previewMode}
        </div>
      </div>

      <div
        ref={viewportRef}
        className="relative flex h-[clamp(420px,62vh,720px)] items-center justify-center overflow-hidden bg-checker p-5 xl:p-6"
        onPointerDown={handleViewportPointerDown}
        onPointerMove={handleViewportPointerMove}
        onPointerUp={handleViewportPointerEnd}
        onPointerCancel={handleViewportPointerEnd}
        onWheel={handleViewportWheel}
        onContextMenu={handleViewportContextMenu}
      >
        {!src && !scene3d && !processing && (
          <div className="max-w-md rounded-[28px] border border-white/80 bg-white/90 p-8 text-center shadow-[0_20px_70px_rgba(15,23,42,0.08)] backdrop-blur">
            <div className="text-sm font-semibold text-slate-950">先上传一张图片</div>
            <p className="mt-3 text-sm leading-6 text-slate-500">
              左侧上传图片或导入 DXF 后，这里会显示线稿、底板、分层和 3D 预览。整个工作流都在浏览器本地完成，不依赖后端。
            </p>
          </div>
        )}

        {processing && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-white/65 backdrop-blur-sm">
            <div className="inline-flex items-center gap-3 rounded-full bg-slate-950 px-5 py-3 text-sm font-medium text-white shadow-[0_18px_48px_rgba(15,23,42,0.22)]">
              <LoaderCircle className="h-4 w-4 animate-spin" />
              正在线稿提取、生成底板并重建导出对象
            </div>
          </div>
        )}

        {(src || scene3d) && !processing && (
          <div
            className="flex h-full w-full items-center justify-center touch-none"
            style={{
              transform: contentTransform,
              transformOrigin: 'center center',
              willChange: 'transform',
              cursor: contentCursor,
            }}
          >
            {src && (
              <img
                ref={imageRef}
                src={src}
                alt="线稿底板预览"
                draggable={false}
                className="max-h-[calc(100%-8px)] max-w-full rounded-[24px] border border-slate-200 bg-white object-contain shadow-[0_16px_56px_rgba(15,23,42,0.12)] select-none"
              />
            )}

            {scene3d && (
              <svg
                viewBox={`0 0 ${scene3d.viewWidth} ${scene3d.viewHeight}`}
                role="img"
                aria-label="3D 立体预览"
                className="h-full max-h-[calc(100%-8px)] w-full max-w-full rounded-[24px] border border-slate-200 bg-[radial-gradient(circle_at_top,_#ffffff,_#eef4fb_58%,_#dbe7f5)] object-contain shadow-[0_16px_56px_rgba(15,23,42,0.12)]"
              >
            <defs>
              <linearGradient id="preview-floor" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0%" stopColor="#ffffff" stopOpacity="0.95" />
                <stop offset="100%" stopColor="#d9e7f6" stopOpacity="0.9" />
              </linearGradient>
            </defs>
            <rect x="0" y="0" width={scene3d.viewWidth} height={scene3d.viewHeight} fill="transparent" />
            <ellipse
              cx={scene3d.viewWidth / 2}
              cy={scene3d.viewHeight - 32}
              rx={Math.max(40, scene3d.viewWidth * 0.24)}
              ry={18}
              fill="#94a3b8"
              opacity="0.16"
            />
            <path d={scene3d.floorPath} fill="url(#preview-floor)" opacity="0.6" />
            {scene3d.baseSidePaths.map((path, index) => (
              <path key={`base-side-${index}`} d={path} fill={scene3d.baseSideColor} />
            ))}
            <path d={scene3d.baseTopPath} fill={baseplateSettings.baseColor} stroke={scene3d.edgeColor} strokeWidth="1.2" />
            {scene3d.lineSidePaths.map((path, index) => (
              <path key={`line-side-${index}`} d={path} fill={scene3d.lineSideColor} />
            ))}
            <path d={scene3d.lineTopPath} fill={baseplateSettings.lineColor} stroke={scene3d.edgeColor} strokeWidth="1" />
              </svg>
            )}
          </div>
        )}

        {artwork && !processing && (
          <div className="absolute bottom-5 left-5 flex flex-wrap gap-2">
            <div className="rounded-full bg-white/92 px-3 py-1.5 text-[11px] font-medium text-slate-700 shadow">
              画板 {artwork.boardWidthMm.toFixed(1)} × {artwork.boardHeightMm.toFixed(1)} mm
            </div>
            <div className="rounded-full bg-white/92 px-3 py-1.5 text-[11px] font-medium text-slate-700 shadow">
              线稿轮廓 {artwork.stats.lineLoopCount} 组
            </div>
            <div className="rounded-full bg-white/92 px-3 py-1.5 text-[11px] font-medium text-slate-700 shadow">
              来源 {artwork.sourceKind === 'image' ? '图片' : 'DXF'}
            </div>
          </div>
        )}

        {sourceImage && previewMode !== '3D预览' && !processing && (
          <div className="absolute right-5 top-5 flex flex-wrap items-center gap-2">
            <div className="inline-flex items-center gap-2 rounded-full bg-white/92 px-3 py-1.5 text-[11px] font-medium text-slate-700 shadow">
              <Pipette className="h-3.5 w-3.5" />
              {previewMode === '原图' ? interactionHint : '切到原图后可 Shift+拖动取色'}
            </div>
            <div className="inline-flex items-center gap-2 rounded-full bg-white/92 px-2 py-1.5 text-[11px] font-medium text-slate-700 shadow">
              <span
                className="h-4 w-4 rounded-full border border-slate-200"
                style={{ backgroundColor: displayColor }}
              />
              目标颜色 {displayColor}
            </div>
          </div>
        )}

        {previewMode === '3D预览' && !processing && (
          <div className="absolute right-5 top-5 flex flex-wrap items-center gap-2">
            <div className="inline-flex items-center gap-2 rounded-full bg-white/92 px-3 py-1.5 text-[11px] font-medium text-slate-700 shadow">
              <MoveDiagonal2 className="h-3.5 w-3.5" />
              {interactionHint}
            </div>
          </div>
        )}

        {error && (
          <div className="absolute bottom-6 left-6 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-600">
            {error}
          </div>
        )}
      </div>
    </section>
  )
}

function rgbToHex(r: number, g: number, b: number) {
  return `#${[r, g, b].map((value) => value.toString(16).padStart(2, '0')).join('')}`
}

function buildThreeDimensionalPreview(
  artwork: ProcessedArtwork,
  baseplateSettings: BaseplateSettings,
  extrudeSettings: ExtrudeSettings,
) {
  const allPoints = [...artwork.baseLoops, ...artwork.lineLoops].flatMap((loop) => loop.points)
  if (!allPoints.length) {
    return null
  }

  const bounds = getBounds(allPoints)
  const scale = Math.min(
    560 / Math.max(bounds.width || 1, 1),
    360 / Math.max(bounds.height || 1, 1),
  )
  const originX = 130
  const originY = 320
  const baseRaise = Math.max(8, extrudeSettings.baseThicknessMm * 28)
  const lineRaise = Math.max(6, extrudeSettings.lineThicknessMm * 28)

  const projectTop = (point: VectorPoint, zMm: number) => {
    const normalizedX = (point.x - bounds.minX) * scale
    const normalizedY = (point.y - bounds.minY) * scale
    return {
      x: originX + normalizedX - normalizedY * 0.52,
      y: originY + normalizedY * 0.34 - zMm * 18,
    }
  }

  const buildTopPath = (loops: VectorLoop[], zMm: number) => loops
    .map((loop) => buildLoopPath(loop, (point) => projectTop(point, zMm)))
    .join(' ')

  const buildSidePaths = (loops: VectorLoop[], zStartMm: number, zEndMm: number) => loops.flatMap((loop) => {
    const points = simplifyLoop(loop.points)
    if (points.length < 2) return []

    return points.slice(0, -1).map((point, index) => {
      const nextPoint = points[index + 1]
      const topA = projectTop(point, zEndMm)
      const topB = projectTop(nextPoint, zEndMm)
      const bottomA = projectTop(point, zStartMm)
      const bottomB = projectTop(nextPoint, zStartMm)
      return `M ${bottomA.x.toFixed(2)} ${bottomA.y.toFixed(2)} L ${bottomB.x.toFixed(2)} ${bottomB.y.toFixed(2)} L ${topB.x.toFixed(2)} ${topB.y.toFixed(2)} L ${topA.x.toFixed(2)} ${topA.y.toFixed(2)} Z`
    })
  })

  const floorWidth = Math.max(320, bounds.width * scale * 0.95)
  const floorDepth = Math.max(200, bounds.height * scale * 0.55)
  const floorPath = [
    `M ${(originX - floorDepth * 0.52 - 36).toFixed(2)} ${(originY + 16).toFixed(2)}`,
    `L ${(originX + floorWidth - floorDepth * 0.52 + 24).toFixed(2)} ${(originY + 16).toFixed(2)}`,
    `L ${(originX + floorWidth + 8).toFixed(2)} ${(originY + floorDepth * 0.34 + 28).toFixed(2)}`,
    `L ${(originX - 52).toFixed(2)} ${(originY + floorDepth * 0.34 + 28).toFixed(2)}`,
    'Z',
  ].join(' ')

  return {
    viewWidth: 760,
    viewHeight: 460,
    floorPath,
    baseTopPath: buildTopPath(artwork.baseLoops, extrudeSettings.baseThicknessMm),
    lineTopPath: buildTopPath(artwork.lineLoops, extrudeSettings.lineHeightMm + extrudeSettings.lineThicknessMm),
    baseSidePaths: buildSidePaths(artwork.baseLoops, 0, extrudeSettings.baseThicknessMm),
    lineSidePaths: buildSidePaths(artwork.lineLoops, extrudeSettings.lineHeightMm, extrudeSettings.lineHeightMm + extrudeSettings.lineThicknessMm),
    baseSideColor: shadeHexColor(baseplateSettings.baseColor, -0.18 - baseRaise / 160),
    lineSideColor: shadeHexColor(baseplateSettings.lineColor, -0.22 - lineRaise / 160),
    edgeColor: 'rgba(15, 23, 42, 0.28)',
  }
}

function buildLoopPath(loop: VectorLoop, project: (point: VectorPoint) => { x: number; y: number }) {
  const [first, ...rest] = loop.points
  if (!first) return ''
  const start = project(first)
  return [
    `M ${start.x.toFixed(2)} ${start.y.toFixed(2)}`,
    ...rest.map((point) => {
      const projected = project(point)
      return `L ${projected.x.toFixed(2)} ${projected.y.toFixed(2)}`
    }),
    'Z',
  ].join(' ')
}

function simplifyLoop(points: VectorPoint[]) {
  if (!points.length) return []
  const normalized = [...points]
  const first = normalized[0]
  const last = normalized[normalized.length - 1]
  if (!last || first.x !== last.x || first.y !== last.y) {
    normalized.push(first)
  }
  return normalized
}

function getBounds(points: VectorPoint[]) {
  const xs = points.map((point) => point.x)
  const ys = points.map((point) => point.y)
  const minX = Math.min(...xs)
  const maxX = Math.max(...xs)
  const minY = Math.min(...ys)
  const maxY = Math.max(...ys)
  return {
    minX,
    minY,
    width: maxX - minX,
    height: maxY - minY,
  }
}

function shadeHexColor(hex: string, amount: number) {
  const normalized = hex.replace('#', '')
  const channels = normalized.length === 3
    ? normalized.split('').map((channel) => parseInt(channel + channel, 16))
    : [
      parseInt(normalized.slice(0, 2), 16),
      parseInt(normalized.slice(2, 4), 16),
      parseInt(normalized.slice(4, 6), 16),
    ]

  return `#${channels
    .map((channel) => {
      const next = Math.round(channel + (amount >= 0 ? (255 - channel) * amount : channel * amount))
      return Math.max(0, Math.min(255, next)).toString(16).padStart(2, '0')
    })
    .join('')}`
}
