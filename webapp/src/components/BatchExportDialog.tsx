import { Boxes, FileArchive, PackageOpen } from 'lucide-react'

interface BatchExportDialogProps {
  count: number
  onCancel: () => void
  onChooseMode: (mode: 'single' | 'multiple') => void
}

export function BatchExportDialog({ count, onCancel, onChooseMode }: BatchExportDialogProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/45 px-4 py-8 backdrop-blur-sm">
      <div className="w-full max-w-2xl rounded-[28px] border border-slate-200 bg-white p-6 shadow-[0_32px_120px_rgba(15,23,42,0.28)]">
        <h2 className="text-lg font-semibold text-slate-950">批量导出 3MF</h2>
        <p className="mt-2 text-sm leading-6 text-slate-500">
          当前素材列表里有 {count} 张图。你可以把它们合并成一个 3MF，也可以导出成多个按顺序编号的 3MF 文件。
        </p>

        <div className="mt-5 grid gap-4 md:grid-cols-2">
          <button
            type="button"
            onClick={() => onChooseMode('single')}
            className="rounded-[24px] border border-sky-200 bg-sky-50 p-5 text-left transition hover:border-sky-300 hover:shadow-[0_18px_40px_rgba(0,136,255,0.12)]"
          >
            <div className="inline-flex items-center gap-2 rounded-full bg-white px-3 py-1 text-[11px] font-medium text-sky-700">
              <PackageOpen className="h-3.5 w-3.5" />
              单个 3MF
            </div>
            <div className="mt-4 text-base font-semibold text-slate-950">导出一个合并 3MF</div>
            <p className="mt-2 text-sm leading-6 text-slate-500">
              所有素材放进同一个 3MF 文件，每张图保留自己的底板和线稿对象，适合一次性导入切片软件。
            </p>
          </button>

          <button
            type="button"
            onClick={() => onChooseMode('multiple')}
            className="rounded-[24px] border border-slate-200 bg-white p-5 text-left transition hover:border-slate-300 hover:shadow-[0_18px_40px_rgba(148,163,184,0.18)]"
          >
            <div className="inline-flex items-center gap-2 rounded-full bg-slate-100 px-3 py-1 text-[11px] font-medium text-slate-600">
              <Boxes className="h-3.5 w-3.5" />
              多个 3MF
            </div>
            <div className="mt-4 text-base font-semibold text-slate-950">导出多个编号 3MF</div>
            <p className="mt-2 text-sm leading-6 text-slate-500">
              按顺序导出为 `1-a`、`2-b` 这种编号文件，并打包进一个 ZIP 里，适合逐个打印或分开发送。
            </p>
          </button>
        </div>

        <div className="mt-6 flex items-center justify-between rounded-[20px] bg-slate-50 px-4 py-4 text-sm text-slate-500">
          <div className="inline-flex items-center gap-2">
            <FileArchive className="h-4 w-4" />
            非 3MF 的批量导出会默认按编号打包输出。
          </div>
          <button
            type="button"
            onClick={onCancel}
            className="rounded-2xl border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-600 transition hover:border-slate-300 hover:text-slate-900"
          >
            取消
          </button>
        </div>
      </div>
    </div>
  )
}
