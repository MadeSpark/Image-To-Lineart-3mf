import { Eraser, Hand, LoaderCircle, MoveDiagonal2, PenLine, Pipette, RotateCcw } from 'lucide-react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { ThreeDModelViewer } from '@/components/ThreeDModelViewer'
import type {
  BaseplateSettings,
  ExtrudeSettings,
  PreviewMode,
  ProcessedArtwork,
  SourceImage,
  VectorLoop,
  VectorPoint,
} from '@/types/generator'
import { clamp } from '@/utils/color'

interface PreviewCanvasProps {
  sourceImage: SourceImage | null
  artwork: ProcessedArtwork | null
  previewMode: PreviewMode
  processing: boolean
  error: string | null
  targetColor: string
  baseplateSettings: BaseplateSettings
  extrudeSettings: ExtrudeSettings
  hasLineartEdits: boolean
  viewResetKey: string
  onApplyLineartStroke: (points: VectorPoint[], mode: 'brush' | 'eraser', radiusMm: number) => void
  onResetLineartEdits: () => void
  onPickTargetColor: (color: string) => void
}

const DEFAULT_VIEW_TRANSFORM = {
  scale: 1,
  panX: 0,
  panY: 0,
}

type LineartTool = 'pan' | 'brush' | 'eraser'

export function PreviewCanvas({
  sourceImage,
  artwork,
  previewMode,
  processing,
  error,
  targetColor,
  baseplateSettings,
  extrudeSettings,
  hasLineartEdits,
  viewResetKey,
  onApplyLineartStroke,
  onResetLineartEdits,
  onPickTargetColor,
}: PreviewCanvasProps) {
  const vectorSvgRef = useRef<SVGSVGElement | null>(null)
  const sampleCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const viewportRef = useRef<HTMLDivElement | null>(null)
  const vectorFrameRef = useRef<HTMLDivElement | null>(null)
  const interactionRef = useRef<{
    mode: 'pan' | 'pick' | 'brush' | 'eraser' | null
    pointerId: number | null
    lastX: number
    lastY: number
    strokePoints: VectorPoint[]
  }>({
    mode: null,
    pointerId: null,
    lastX: 0,
    lastY: 0,
    strokePoints: [],
  })
  const [isPicking, setIsPicking] = useState(false)
  const [draftPickedColor, setDraftPickedColor] = useState<string | null>(null)
  const [lineartTool, setLineartTool] = useState<LineartTool>('pan')
  const [brushSizeMm, setBrushSizeMm] = useState(1.2)
  const [liveStrokePoints, setLiveStrokePoints] = useState<VectorPoint[]>([])
  const [brushCursorPoint, setBrushCursorPoint] = useState<VectorPoint | null>(null)
  const [viewTransform, setViewTransform] = useState({
    ...DEFAULT_VIEW_TRANSFORM,
  })
  const [vectorFrameSize, setVectorFrameSize] = useState({ width: 0, height: 0 })
  const isThreeDimensionalPreview = previewMode === '3D预览'

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
    if (previewMode !== '线稿' && lineartTool !== 'pan') {
      setLineartTool('pan')
      setLiveStrokePoints([])
      setBrushCursorPoint(null)
    }
  }, [lineartTool, previewMode])

  useEffect(() => {
    if (lineartTool === 'pan') {
      setLiveStrokePoints([])
      setBrushCursorPoint(null)
    }
  }, [lineartTool])

  useEffect(() => {
    setViewTransform({
      ...DEFAULT_VIEW_TRANSFORM,
    })
    interactionRef.current = {
      mode: null,
      pointerId: null,
      lastX: 0,
      lastY: 0,
      strokePoints: [],
    }
    setLiveStrokePoints([])
    setBrushCursorPoint(null)
  }, [viewResetKey])

  const canPickColor = Boolean(sourceImage && previewMode === '原图' && !processing)
  const displayColor = draftPickedColor ?? targetColor
  const vectorScene = useMemo(
    () => ((!isThreeDimensionalPreview && (artwork || sourceImage))
      ? buildVectorPreviewScene(artwork, sourceImage, previewMode, baseplateSettings)
      : null),
    [artwork, baseplateSettings, isThreeDimensionalPreview, previewMode, sourceImage],
  )
  const vectorViewBox = useMemo(
    () => (vectorScene
      ? buildVectorViewBox(vectorScene.viewWidth, vectorScene.viewHeight, vectorFrameSize, viewTransform)
      : null),
    [vectorFrameSize, vectorScene, viewTransform],
  )
  const hasPreviewContent = Boolean(vectorScene)
  const effectiveHasPreviewContent = isThreeDimensionalPreview ? Boolean(artwork) : hasPreviewContent
  const canEditLineart = previewMode === '线稿' && Boolean(vectorScene) && !processing
  const brushCursorOverlay = useMemo(() => {
    if (!canEditLineart || !brushCursorPoint || lineartTool === 'pan' || !vectorViewBox) {
      return null
    }

    const svg = vectorSvgRef.current
    const viewport = viewportRef.current
    if (!svg || !viewport) {
      return null
    }

    const svgRect = svg.getBoundingClientRect()
    const viewportRect = viewport.getBoundingClientRect()
    if (svgRect.width <= 0 || svgRect.height <= 0) {
      return null
    }

    const scale = Math.min(
      svgRect.width / Math.max(vectorViewBox.width, 1e-6),
      svgRect.height / Math.max(vectorViewBox.height, 1e-6),
    )
    const contentWidth = vectorViewBox.width * scale
    const contentHeight = vectorViewBox.height * scale
    const offsetX = (svgRect.width - contentWidth) * 0.5
    const offsetY = (svgRect.height - contentHeight) * 0.5

    return {
      left: svgRect.left - viewportRect.left + offsetX + (brushCursorPoint.x - vectorViewBox.minX) * scale,
      top: svgRect.top - viewportRect.top + offsetY + (brushCursorPoint.y - vectorViewBox.minY) * scale,
      diameter: Math.max(brushSizeMm * 2 * scale, 10),
    }
  }, [brushCursorPoint, brushSizeMm, canEditLineart, lineartTool, vectorViewBox])

  const zoomViewport = (clientX: number, clientY: number, deltaY: number) => {
    const viewport = viewportRef.current
    if (!viewport) return

    const rect = viewport.getBoundingClientRect()
    const pointerX = clientX - rect.left - rect.width / 2
    const pointerY = clientY - rect.top - rect.height / 2

    setViewTransform((current) => {
      const nextScale = clamp(current.scale * (deltaY < 0 ? 1.12 : 0.9), 0.2, 16)
      const scaleRatio = nextScale / current.scale
      return {
        ...current,
        scale: nextScale,
        panX: pointerX - (pointerX - current.panX) * scaleRatio,
        panY: pointerY - (pointerY - current.panY) * scaleRatio,
      }
    })
  }

  useEffect(() => {
    if (isThreeDimensionalPreview) {
      return
    }

    const viewport = viewportRef.current
    if (!viewport) return

    const handleWheel = (event: WheelEvent) => {
      event.preventDefault()
      event.stopPropagation()
      zoomViewport(event.clientX, event.clientY, event.deltaY)
    }

    viewport.addEventListener('wheel', handleWheel, { passive: false })
    return () => {
      viewport.removeEventListener('wheel', handleWheel)
    }
  }, [isThreeDimensionalPreview])

  useEffect(() => {
    const frame = vectorFrameRef.current
    if (!frame || typeof ResizeObserver === 'undefined') {
      return
    }

    const updateSize = () => {
      const rect = frame.getBoundingClientRect()
      setVectorFrameSize({
        width: rect.width,
        height: rect.height,
      })
    }

    updateSize()
    const observer = new ResizeObserver(() => updateSize())
    observer.observe(frame)

    return () => {
      observer.disconnect()
    }
  }, [vectorScene, previewMode])

  const sampleColor = (clientX: number, clientY: number) => {
    const sampleCanvas = sampleCanvasRef.current
    if (!sampleCanvas || !vectorScene) return null

    const point = getVectorPointFromClient(clientX, clientY)
    if (!point) return null

    const imageLayer = vectorScene.imageLayer
    if (!imageLayer) return null
    if (
      point.x < imageLayer.x
      || point.x > imageLayer.x + imageLayer.width
      || point.y < imageLayer.y
      || point.y > imageLayer.y + imageLayer.height
    ) {
      return null
    }

    const ratioX = (point.x - imageLayer.x) / Math.max(imageLayer.width, 1e-6)
    const ratioY = (point.y - imageLayer.y) / Math.max(imageLayer.height, 1e-6)
    const x = Math.min(sampleCanvas.width - 1, Math.max(0, Math.round(ratioX * (sampleCanvas.width - 1))))
    const y = Math.min(sampleCanvas.height - 1, Math.max(0, Math.round(ratioY * (sampleCanvas.height - 1))))
    const context = sampleCanvas.getContext('2d', { willReadFrequently: true })
    if (!context) return null
    const pixel = context.getImageData(x, y, 1, 1).data
    if (pixel[3] < 8) return null

    return rgbToHex(pixel[0], pixel[1], pixel[2])
  }

  const getVectorPointFromClient = (clientX: number, clientY: number) => {
    const svg = vectorSvgRef.current
    if (!svg) return null

    const rect = svg.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return null
    if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) return null

    const ctm = svg.getScreenCTM()
    if (!ctm) return null

    const point = new DOMPoint(clientX, clientY).matrixTransform(ctm.inverse())
    return {
      x: point.x,
      y: point.y,
    }
  }

  const handleViewportPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (isThreeDimensionalPreview) {
      return
    }

    const viewport = viewportRef.current
    if (!viewport) return
    const target = event.target as HTMLElement | null
    if (target?.closest('[data-canvas-control="true"]')) {
      return
    }

    let mode: 'pan' | 'pick' | 'brush' | 'eraser' | null = null
    if (event.button === 0 && canPickColor && event.shiftKey) {
      mode = 'pick'
      setIsPicking(true)
      setDraftPickedColor(sampleColor(event.clientX, event.clientY))
    } else if (event.button === 0 && canEditLineart && lineartTool !== 'pan') {
      const point = getVectorPointFromClient(event.clientX, event.clientY)
      if (!point) return
      mode = lineartTool
      setLiveStrokePoints([point])
      setBrushCursorPoint(point)
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
      strokePoints: mode === 'brush' || mode === 'eraser'
        ? [getVectorPointFromClient(event.clientX, event.clientY)].filter(Boolean) as VectorPoint[]
        : [],
    }
  }

  const handleViewportPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (canEditLineart && lineartTool !== 'pan') {
      setBrushCursorPoint(getVectorPointFromClient(event.clientX, event.clientY))
    }

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

    if (interaction.mode === 'pick') {
      setDraftPickedColor(sampleColor(event.clientX, event.clientY))
      return
    }

    if (interaction.mode === 'brush' || interaction.mode === 'eraser') {
      const point = getVectorPointFromClient(event.clientX, event.clientY)
      if (!point) return
      interaction.strokePoints.push(point)
      setLiveStrokePoints([...interaction.strokePoints])
      setBrushCursorPoint(point)
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

    if ((interaction.mode === 'brush' || interaction.mode === 'eraser') && interaction.strokePoints.length) {
      onApplyLineartStroke(interaction.strokePoints, interaction.mode, brushSizeMm)
      setLiveStrokePoints([])
      const point = getVectorPointFromClient(event.clientX, event.clientY)
      setBrushCursorPoint(point)
    }

    if (viewport?.hasPointerCapture(event.pointerId)) {
      viewport.releasePointerCapture(event.pointerId)
    }
    interactionRef.current = {
      mode: null,
      pointerId: null,
      lastX: 0,
      lastY: 0,
      strokePoints: [],
    }
  }

  const handleViewportContextMenu = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault()
  }

  const handleViewportPointerLeave = () => {
    if (lineartTool !== 'pan') {
      setLiveStrokePoints([])
      setBrushCursorPoint(null)
    }
  }

  const interactionHint = isThreeDimensionalPreview
    ? '3D预览支持拖动旋转与滚轮缩放'
    : canPickColor
    ? '左键拖动画布，滚轮缩放，Shift+拖动取色'
    : canEditLineart
      ? lineartTool === 'pan'
        ? '滚轮缩放；线稿模式可切换拖动、画笔和橡皮擦'
        : '当前正在直接修改线稿矢量轮廓'
      : '左键拖动画布，滚轮缩放'
  const contentCursor = isPicking
    ? 'crosshair'
    : isThreeDimensionalPreview
      ? 'default'
    : canEditLineart && lineartTool === 'brush'
      ? 'none'
      : canEditLineart && lineartTool === 'eraser'
        ? 'none'
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
        className={`relative flex h-[clamp(420px,62vh,720px)] items-center justify-center overflow-hidden bg-checker ${isThreeDimensionalPreview ? 'p-0' : 'p-5 xl:p-6'}`}
        onPointerDown={handleViewportPointerDown}
        onPointerMove={handleViewportPointerMove}
        onPointerUp={handleViewportPointerEnd}
        onPointerCancel={handleViewportPointerEnd}
        onPointerLeave={handleViewportPointerLeave}
        onContextMenu={handleViewportContextMenu}
        style={{ overscrollBehavior: 'contain' }}
      >
        {!effectiveHasPreviewContent && !processing && (
          <div className="max-w-md rounded-[28px] border border-white/80 bg-white/90 p-8 text-center shadow-[0_20px_70px_rgba(15,23,42,0.08)] backdrop-blur">
            <div className="text-sm font-semibold text-slate-950">先上传一张图片</div>
            <p className="mt-3 text-sm leading-6 text-slate-500">
              左侧上传图片或导入 DXF 后，这里会显示线稿、底板和分层预览。整个工作流都在浏览器本地完成，不依赖后端。
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

        {effectiveHasPreviewContent && !processing && (
          <div
            className={`touch-none ${isThreeDimensionalPreview ? 'h-full w-full' : 'flex h-full w-full items-center justify-center'}`}
            style={{ cursor: contentCursor }}
          >
            {isThreeDimensionalPreview && artwork && (
              <ThreeDModelViewer
                artwork={artwork}
                baseplateSettings={baseplateSettings}
                extrudeSettings={extrudeSettings}
              />
            )}

            {vectorScene && (
              <div
                ref={vectorFrameRef}
                key={`${previewMode}-${vectorScene.viewWidth}-${vectorScene.viewHeight}-${vectorScene.layers.map((layer) => layer.id).join('-')}`}
                className="preview-vector-shell h-full max-h-[calc(100%-8px)] w-full max-w-full select-none"
                style={{
                  aspectRatio: `${vectorScene.viewWidth} / ${vectorScene.viewHeight}`,
                }}
              >
                <svg
                  ref={vectorSvgRef}
                  viewBox={formatVectorViewBox(vectorViewBox ?? {
                    minX: 0,
                    minY: 0,
                    width: vectorScene.viewWidth,
                    height: vectorScene.viewHeight,
                  })}
                  aria-label="线稿底板矢量预览"
                  className="block h-full w-full overflow-visible"
                  preserveAspectRatio="xMidYMid meet"
                  shapeRendering="geometricPrecision"
                  style={{ isolation: 'isolate' }}
                >
                  {vectorScene.imageLayer && (
                    <image
                      href={vectorScene.imageLayer.href}
                      x={formatVectorNumber(vectorScene.imageLayer.x)}
                      y={formatVectorNumber(vectorScene.imageLayer.y)}
                      width={formatVectorNumber(vectorScene.imageLayer.width)}
                      height={formatVectorNumber(vectorScene.imageLayer.height)}
                      preserveAspectRatio="none"
                    />
                  )}
                  {vectorScene.layers.map((layer) => (
                    <g
                      key={layer.id}
                      fill={layer.fill}
                      opacity={layer.opacity}
                    >
                      <path d={layer.path} fillRule="evenodd" />
                    </g>
                  ))}
                  {canEditLineart && liveStrokePoints.length > 1 && lineartTool !== 'pan' && (
                    <polyline
                      points={liveStrokePoints.map((point) => `${formatVectorNumber(point.x)},${formatVectorNumber(point.y)}`).join(' ')}
                      fill="none"
                      stroke={lineartTool === 'eraser' ? '#ef4444' : '#000000'}
                      strokeWidth={formatVectorNumber(brushSizeMm * 2)}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      opacity={lineartTool === 'eraser' ? 0.85 : 1}
                    />
                  )}
                </svg>
              </div>
            )}
          </div>
        )}

        {brushCursorOverlay && (
          <div
            className="pointer-events-none absolute rounded-full"
            style={{
              left: brushCursorOverlay.left,
              top: brushCursorOverlay.top,
              width: brushCursorOverlay.diameter,
              height: brushCursorOverlay.diameter,
              transform: 'translate(-50%, -50%)',
              border: `${lineartTool === 'eraser' ? 2.2 : 2.4}px ${lineartTool === 'eraser' ? 'dashed' : 'solid'} #ffffff`,
              borderRadius: '9999px',
              mixBlendMode: 'difference',
              opacity: 1,
            }}
          />
        )}

        {artwork && !processing && (
          <div className="absolute bottom-5 left-5 flex flex-wrap gap-2">
            <div className="rounded-full bg-[#f8fafc] px-3 py-1.5 text-[11px] font-medium text-slate-700 shadow-sm">
              画板 {artwork.boardWidthMm.toFixed(1)} × {artwork.boardHeightMm.toFixed(1)} mm
            </div>
            <div className="rounded-full bg-[#f8fafc] px-3 py-1.5 text-[11px] font-medium text-slate-700 shadow-sm">
              线稿轮廓 {artwork.stats.lineLoopCount} 组
            </div>
            <div className="rounded-full bg-[#f8fafc] px-3 py-1.5 text-[11px] font-medium text-slate-700 shadow-sm">
              来源 {artwork.sourceKind === 'image' ? '图片' : 'DXF'}
            </div>
          </div>
        )}

        {sourceImage && !processing && (
          <div
            className="absolute right-5 top-5 flex flex-wrap items-center gap-2"
            data-canvas-control="true"
            onPointerDown={(event) => event.stopPropagation()}
          >
            <div className="inline-flex items-center gap-2 rounded-full bg-[#f8fafc] px-3 py-1.5 text-[11px] font-medium text-slate-700 shadow-sm">
              <Pipette className="h-3.5 w-3.5" />
              {previewMode === '原图'
                ? interactionHint
                : canEditLineart
                  ? interactionHint
                  : isThreeDimensionalPreview
                    ? interactionHint
                    : '切到原图后可 Shift+拖动取色'}
            </div>
            <div className="inline-flex items-center gap-2 rounded-full bg-[#f8fafc] px-2 py-1.5 text-[11px] font-medium text-slate-700 shadow-sm">
              <span
                className="h-4 w-4 rounded-full border border-slate-200"
                style={{ backgroundColor: displayColor }}
              />
              目标颜色 {displayColor}
            </div>
          </div>
        )}

        {canEditLineart && (
          <div
            className="absolute left-5 top-5 flex flex-wrap items-center gap-2"
            data-canvas-control="true"
            onPointerDown={(event) => event.stopPropagation()}
          >
            <div className="flex items-center gap-1 rounded-full bg-[#f8fafc] p-1 text-[11px] font-medium text-slate-700 shadow-sm">
              {[
                { value: 'pan' as const, label: '拖动', icon: Hand },
                { value: 'brush' as const, label: '画笔', icon: PenLine },
                { value: 'eraser' as const, label: '橡皮擦', icon: Eraser },
              ].map((tool) => {
                const Icon = tool.icon
                const active = lineartTool === tool.value
                return (
                  <button
                    key={tool.value}
                    type="button"
                    onClick={() => setLineartTool(tool.value)}
                    className={`inline-flex items-center gap-1 rounded-full px-3 py-1.5 transition ${
                      active ? 'bg-[#0088ff] text-white' : 'text-slate-600 hover:bg-slate-100'
                    }`}
                  >
                    <Icon className="h-3.5 w-3.5" />
                    {tool.label}
                  </button>
                )
              })}
            </div>
            <div className="flex items-center gap-3 rounded-full bg-[#f8fafc] px-3 py-2 text-[11px] font-medium text-slate-700 shadow-sm">
              <span className="whitespace-nowrap">画笔粗细 {brushSizeMm.toFixed(1)}mm</span>
              <svg className="h-7 w-7 shrink-0 overflow-visible" viewBox="0 0 28 28" aria-hidden="true">
                <circle
                  cx="14"
                  cy="14"
                  r={Math.min(11, Math.max(3, brushSizeMm * 4))}
                  fill="none"
                  stroke={lineartTool === 'eraser' ? '#ef4444' : '#0088ff'}
                  strokeWidth="1.5"
                  strokeDasharray={lineartTool === 'eraser' ? '2.5 2' : undefined}
                />
              </svg>
              <input
                type="range"
                min="0.2"
                max="4"
                step="0.1"
                value={brushSizeMm}
                onChange={(event) => setBrushSizeMm(Number(event.target.value))}
                className="h-1.5 w-36 cursor-pointer appearance-none rounded-full bg-slate-200 accent-[#0088ff]"
              />
            </div>
            {hasLineartEdits && (
              <button
                type="button"
                onClick={onResetLineartEdits}
                className="inline-flex items-center gap-1 rounded-full bg-[#f8fafc] px-3 py-2 text-[11px] font-medium text-slate-700 shadow-sm transition hover:bg-slate-100"
              >
                <RotateCcw className="h-3.5 w-3.5" />
                重置修线
              </button>
            )}
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

function buildVectorPreviewScene(
  artwork: ProcessedArtwork | null,
  sourceImage: SourceImage | null,
  previewMode: PreviewMode,
  baseplateSettings: BaseplateSettings,
) {
  const layers: Array<{
    id: string
    fill: string
    opacity?: number
    path: string
  }> = []

  const viewWidth = artwork?.boardWidthMm ?? sourceImage?.width ?? 1
  const viewHeight = artwork?.boardHeightMm ?? sourceImage?.height ?? 1
  const imageLayer = previewMode === '原图' && sourceImage
    ? {
      href: sourceImage.dataUrl,
      ...fitImageInScene(
        sourceImage.width,
        sourceImage.height,
        viewWidth,
        viewHeight,
      ),
    }
    : null

  if (previewMode === '原图') {
    // Render the source image in the same scene coordinates as vector previews
    // so zoom/pan stay stable when switching modes.
  } else if (previewMode === '线稿' && artwork) {
    layers.push({
      id: 'lineart',
      fill: baseplateSettings.lineColor,
      path: loopsToSvgPath(artwork.lineLoops),
    })
  } else if (previewMode === '底板预览' && artwork) {
    layers.push({
      id: 'baseplate',
      fill: baseplateSettings.baseColor,
      path: loopsToSvgPath(artwork.baseLoops),
    })
    layers.push({
      id: 'lineart-ghost',
      fill: baseplateSettings.lineColor,
      opacity: 0.22,
      path: loopsToSvgPath(artwork.lineLoops),
    })
  } else if (artwork) {
    layers.push({
      id: 'baseplate',
      fill: baseplateSettings.baseColor,
      path: loopsToSvgPath(artwork.baseLoops),
    })
    layers.push({
      id: 'lineart',
      fill: baseplateSettings.lineColor,
      path: loopsToSvgPath(artwork.lineLoops),
    })
  }

  return {
    viewWidth,
    viewHeight,
    imageLayer,
    layers: layers.filter((layer) => layer.path),
  }
}

function fitImageInScene(
  imageWidth: number,
  imageHeight: number,
  sceneWidth: number,
  sceneHeight: number,
) {
  const safeImageWidth = Math.max(imageWidth, 1)
  const safeImageHeight = Math.max(imageHeight, 1)
  const safeSceneWidth = Math.max(sceneWidth, 1)
  const safeSceneHeight = Math.max(sceneHeight, 1)
  const scale = Math.min(safeSceneWidth / safeImageWidth, safeSceneHeight / safeImageHeight)
  const width = safeImageWidth * scale
  const height = safeImageHeight * scale

  return {
    x: (safeSceneWidth - width) / 2,
    y: (safeSceneHeight - height) / 2,
    width,
    height,
  }
}

function buildVectorViewBox(
  viewWidth: number,
  viewHeight: number,
  frameSize: { width: number; height: number },
  viewTransform: typeof DEFAULT_VIEW_TRANSFORM,
) {
  const safeScale = clamp(viewTransform.scale, 0.2, 16)
  const width = viewWidth / safeScale
  const height = viewHeight / safeScale

  const frameWidth = Math.max(frameSize.width, 1)
  const frameHeight = Math.max(frameSize.height, 1)
  const panXInSceneUnits = (viewTransform.panX * width) / frameWidth
  const panYInSceneUnits = (viewTransform.panY * height) / frameHeight

  const minX = (viewWidth - width) / 2 - panXInSceneUnits
  const minY = (viewHeight - height) / 2 - panYInSceneUnits

  return {
    minX,
    minY,
    width,
    height,
  }
}

function formatVectorViewBox(bounds: { minX: number; minY: number; width: number; height: number }) {
  return `${formatVectorNumber(bounds.minX)} ${formatVectorNumber(bounds.minY)} ${formatVectorNumber(bounds.width)} ${formatVectorNumber(bounds.height)}`
}

function loopsToSvgPath(loops: VectorLoop[]) {
  return loops
    .map((loop) => buildLoopPath(loop.points))
    .filter(Boolean)
    .join(' ')
}

function buildLoopPath(points: VectorPoint[]) {
  const [first, ...rest] = points
  if (!first) {
    return ''
  }

  return [
    `M ${formatVectorNumber(first.x)} ${formatVectorNumber(first.y)}`,
    ...rest.map((point) => `L ${formatVectorNumber(point.x)} ${formatVectorNumber(point.y)}`),
    'Z',
  ].join(' ')
}

function formatVectorNumber(value: number) {
  return Number(value.toFixed(4)).toString()
}
