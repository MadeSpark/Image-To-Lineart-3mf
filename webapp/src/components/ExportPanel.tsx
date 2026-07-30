import { BarChart3, FileArchive, FileCode2, FileJson2, ImageDown, Layers3, Shapes } from 'lucide-react'
import type { GeometryStats } from '@/types/generator'

interface ExportPanelProps {
  stats: GeometryStats | null
  batchCount: number
  onExportJson: () => void
  onExportPreview: () => void
  onExportSvg: () => void
  onExportDxf: () => void
  onExport3mf: () => void
  canExport: boolean
}

export function ExportPanel({
  stats,
  batchCount,
  onExportJson,
  onExportPreview,
  onExportSvg,
  onExportDxf,
  onExport3mf,
  canExport,
}: ExportPanelProps) {
  const items = [
    { label: '线稿轮廓', value: stats?.lineLoopCount ?? 0 },
    { label: '底板轮廓', value: stats?.baseLoopCount ?? 0 },
    { label: '线稿节点', value: stats?.lineSegments ?? 0 },
    {
      label: '画板尺寸',
      value: stats ? `${stats.boardWidthMm.toFixed(1)} × ${stats.boardHeightMm.toFixed(1)} mm` : '--',
    },
  ]

  return (
    <section className="space-y-4 rounded-[24px] border border-slate-200 bg-white p-5 shadow-[0_18px_60px_rgba(15,23,42,0.05)]">
      <div>
        <h2 className="text-sm font-semibold text-slate-950">导出与统计</h2>
        <p className="mt-1 text-xs text-slate-500">
          当前已载入 {batchCount} 项素材。批量导出时，3MF 会先询问合并还是分文件，其他格式默认按编号打包输出。
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3">
        {items.map((item) => (
          <div key={item.label} className="rounded-[18px] bg-slate-50 px-4 py-4">
            <div className="text-[11px] font-medium text-slate-500">{item.label}</div>
            <div className="mt-2 text-lg font-semibold text-slate-950">{item.value}</div>
          </div>
        ))}
      </div>

      <div className="rounded-[20px] bg-[#f3f6fb] p-4">
        <div className="inline-flex items-center gap-2 text-xs font-medium text-slate-600">
          <BarChart3 className="h-4 w-4" />
          当前输出内容
        </div>
        <ul className="mt-3 space-y-2 text-xs leading-6 text-slate-500">
          <li>1. `3MF`：底板与线稿独立对象，可在切片软件里分别指定颜色/耗材</li>
          <li>2. `DXF`：线稿闭合轮廓，便于手动回 CAD 或 3D 软件修改</li>
          <li>3. `SVG`：底板与线稿双图层平面稿</li>
          <li>4. `JSON`：保存当前参数工程</li>
          <li>5. `PNG`：保存当前可视化预览</li>
        </ul>
      </div>

      <div className="grid gap-3">
        <button
          type="button"
          onClick={onExport3mf}
          disabled={!canExport}
          className="inline-flex items-center justify-center gap-2 rounded-2xl bg-[#0088ff] px-4 py-3 text-sm font-medium text-white shadow-[0_14px_32px_rgba(0,136,255,0.28)] transition enabled:hover:bg-[#0077e0] disabled:cursor-not-allowed disabled:opacity-50"
        >
          <FileArchive className="h-4 w-4" />
          导出 3MF
        </button>
        <button
          type="button"
          onClick={onExportDxf}
          disabled={!canExport}
          className="inline-flex items-center justify-center gap-2 rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-medium text-slate-700 transition enabled:hover:border-slate-300 enabled:hover:text-slate-950 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <FileCode2 className="h-4 w-4" />
          导出线稿 DXF
        </button>
        <button
          type="button"
          onClick={onExportSvg}
          disabled={!canExport}
          className="inline-flex items-center justify-center gap-2 rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-medium text-slate-700 transition enabled:hover:border-slate-300 enabled:hover:text-slate-950 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Shapes className="h-4 w-4" />
          导出双图层 SVG
        </button>
        <button
          type="button"
          onClick={onExportPreview}
          disabled={!canExport}
          className="inline-flex items-center justify-center gap-2 rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-medium text-slate-700 transition enabled:hover:border-slate-300 enabled:hover:text-slate-950 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <ImageDown className="h-4 w-4" />
          导出当前预览 PNG
        </button>
        <button
          type="button"
          onClick={onExportJson}
          disabled={!canExport}
          className="inline-flex items-center justify-center gap-2 rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-medium text-slate-700 transition enabled:hover:border-slate-300 enabled:hover:text-slate-950 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <FileJson2 className="h-4 w-4" />
          导出工程 JSON
        </button>
      </div>

      <div className="rounded-[18px] border border-dashed border-slate-200 px-4 py-3 text-xs text-slate-500">
        <div className="inline-flex items-center gap-2 font-medium text-slate-700">
          <Layers3 className="h-4 w-4" />
          导入切片软件前的提醒
        </div>
        <p className="mt-2 leading-6">
          导入 3MF 后，优先检查是否看到两个独立对象。如果切片软件把它们当成两个部分显示，就可以分别给底板和线稿分配耗材。
        </p>
      </div>
    </section>
  )
}
