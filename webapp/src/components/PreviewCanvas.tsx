import { LoaderCircle, MoveDiagonal2, Pipette } from 'lucide-react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { useEffect, useRef, useState } from 'react'
import type { PreviewMode, ProcessedArtwork, SourceImage } from '@/types/generator'

interface PreviewCanvasProps {
  sourceImage: SourceImage | null
  artwork: ProcessedArtwork | null
  previewMode: PreviewMode
  processing: boolean
  error: string | null
  targetColor: string
  onPickTargetColor: (color: string) => void
}

export function PreviewCanvas({
  sourceImage,
  artwork,
  previewMode,
  processing,
  error,
  targetColor,
  onPickTargetColor,
}: PreviewCanvasProps) {
  const imageRef = useRef<HTMLImageElement | null>(null)
  const sampleCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const [isPicking, setIsPicking] = useState(false)
  const [draftPickedColor, setDraftPickedColor] = useState<string | null>(null)

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

  const src = (() => {
    if (!artwork) return null
    if (previewMode === '原图') return sourceImage?.dataUrl ?? artwork.previews.lineartDataUrl
    if (previewMode === '线稿') return artwork.previews.lineartDataUrl
    if (previewMode === '底板预览') return artwork.previews.baseplateDataUrl
    return artwork.previews.compositeDataUrl
  })()
  const canPickColor = Boolean(sourceImage && previewMode === '原图' && !processing)
  const displayColor = draftPickedColor ?? targetColor

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

  const handlePickStart = (event: ReactPointerEvent<HTMLImageElement>) => {
    if (!canPickColor) return
    event.currentTarget.setPointerCapture(event.pointerId)
    setIsPicking(true)
    const color = sampleColor(event.clientX, event.clientY)
    setDraftPickedColor(color)
  }

  const handlePickMove = (event: ReactPointerEvent<HTMLImageElement>) => {
    if (!isPicking || !canPickColor) return
    const color = sampleColor(event.clientX, event.clientY)
    setDraftPickedColor(color)
  }

  const handlePickEnd = (event: ReactPointerEvent<HTMLImageElement>) => {
    if (!isPicking) return
    const color = sampleColor(event.clientX, event.clientY) ?? draftPickedColor
    setIsPicking(false)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    if (color) {
      onPickTargetColor(color)
      setDraftPickedColor(color)
      return
    }
    setDraftPickedColor(null)
  }

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

      <div className="relative flex h-[clamp(420px,62vh,720px)] items-center justify-center bg-checker p-5 xl:p-6">
        {!src && !processing && (
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

        {src && !processing && (
          <img
            ref={imageRef}
            src={src}
            alt="线稿底板预览"
            onPointerDown={handlePickStart}
            onPointerMove={handlePickMove}
            onPointerUp={handlePickEnd}
            onPointerCancel={handlePickEnd}
            className={`max-h-[calc(100%-8px)] max-w-full rounded-[24px] border border-slate-200 bg-white object-contain shadow-[0_16px_56px_rgba(15,23,42,0.12)] ${canPickColor ? 'cursor-crosshair touch-none' : ''}`}
          />
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

        {sourceImage && !processing && (
          <div className="absolute right-5 top-5 flex flex-wrap items-center gap-2">
            <div className="inline-flex items-center gap-2 rounded-full bg-white/92 px-3 py-1.5 text-[11px] font-medium text-slate-700 shadow">
              <Pipette className="h-3.5 w-3.5" />
              {previewMode === '原图' ? '按住拖动可取色' : '切到原图后可拖动取色'}
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
