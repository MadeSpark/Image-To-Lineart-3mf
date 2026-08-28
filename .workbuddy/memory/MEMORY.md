# 转向量项目长期记忆

## 项目概述
图片转线稿导出 3MF 的 3D 打印工具 web 应用（React + TypeScript + Vite + zustand + vitest）。
工作目录：`D:\DevelopmentFolder\Nodejs\转向量\webapp`。三种工作模式：filigree（掐丝）、seal（印章）、light-relief（光映浮雕）。

## 设置持久化机制（generatorStore.ts）
- 分模式 localStorage key：`lineart-baseplate-generator-settings-{filigree|seal|light-relief}`，另有 `-shared`。
- 每次 updateLineartSettings 等动作都会 `saveCurrentModeSettings` 整体快照存入对应 mode key。
- 载入时 `normalizeXxxSettings` 用 `{ ...defaultXxx, ...parsed }` 合并，parsed 字段覆盖默认。
- **含义**：改某个默认值时，老用户的历史快照里若已带旧默认值，重载仍会读到旧值——需配 schema 版本迁移。

## schema 版本迁移约定
- 用独立 key `lineart-baseplate-generator-settings-schema-version` 记版本号，当前 = 3。
- `migrateStoredSettings()` 在模块顶层、loadXxxSettings 之前调用一次。
- 迁移策略：旧默认值（如 smoothing 旧值 36）若仍残留在快照里，视为"用户未改过"，删除该字段使其回落到新默认值；非旧默认值视为"用户已显式修改"，保留。
- v2→v3：老用户带 `autoOptimize=true` 的快照强制迁移为 `false`（删自动调参功能，老快照复活会破坏"严格使用 UI 设置"原则）。
- 测试：generatorStore.test.ts 有两条迁移测试（36→回落 10、20→保留 20）。

## 关键默认值
- `defaultLineartSettings.smoothing` = 10（2026-08-24 由 36 改为 10）。
- `defaultLineartSettings.autoOptimize` = **false**（2026-08-27 改为 false，连同函数 `calculateAutoLineartParams` 一起删除——用户要求"严格记住 UI 设置的值"）。
- 三模式 lineart 默认都源自 `defaultLineartSettings`（seal 仅多 mirror:true）。

## 自动调参（已删除，2026-08-27）
- `calculateAutoLineartParams` 函数和"自动识别优化"开关均已删除。
- 所有参数严格使用用户在 UI 上设置的值，不再有根据图片分辨率自动覆盖。
- 历史快照中残留的 `autoOptimize=true` 由 schema v2→v3 迁移强制改为 `false`。

## 光映浮雕反向堆叠（bFaceReverseStack）语义
- 设置名仍为 `bFaceReverseStack`，但实际语义已于 2026-08-26 改为"浮雕暴露"：
  - 浮雕**始终保持正向朝向**（底面固定在 faceBZMm、bumpy 顶面随灰度变化朝上）——**不翻转顶/底面**。
  - 开启时仅省略背景顶层（顶盖），让 bumpy 顶面直接暴露在模型最顶部，提升透光率。
  - 底座（背景下层 [0, faceBZMm]）始终保留。
- `buildHalftoneReliefMesh` 的 `reverseStack` 参数保留但调用方始终传 `false`。
- UI 标签："B 面浮雕暴露（省略顶盖）"。
- **之前**（2026-08-24 初版）曾翻转浮雕表面（顶面固定平面、底面 bumpy），导致模型顶部出现平面实心层挡光，用户反馈后修正。

## 2D 预览与 3MF 打印一致（"所见即所得"，2026-08-27 → 2026-08-27 v2 位图版）
- `processArtwork`（generator.ts）中，2D SVG 预览（`previews.lineartDataUrl/compositeDataUrl/baseplateDataUrl` 的线稿层）不再直接渲染原始 `visibleLineLoops`，也不再走"trace→smooth"矢量化链路（后者对 2-3 像素宽的细线会产生肉眼可见的台阶+塌陷）。
- 改为直接嵌入**位图 PNG**：用与 3MF 导出完全相同的光栅化（`chooseSingleExportPixelsPerMm`）+ 最小线宽保底（`extrudeSettings.minLineWidthMm`）生成 0/1 mask，再以 `<image href="data:image/png;base64,...">` 嵌入 SVG。
- **关键**：`artwork.lineLoops` 字段仍保留原始矢量，3MF 导出继续走 `extrudeMaskToMesh` 完整流程（不会双重形态学）。
- 预览与 3MF 用同一份 mask 渲染，肉眼像素级一致。dump 见 `webapp/line-debug-output/compare-after-bitmap-preview.png`。
- `applyPrintSafeSolidFeatures`（含 `fillSmallHoles` + `enlargeSmallSolidComponents`）已于 2026-08-27 **彻底删除**——低分辨率下把眼睛等小细节当成"小斑块"填实或放大成黑块。
- `choosePreviewModelPixelsPerMm` 改为内部复用 `chooseSingleExportPixelsPerMm`，让 3D GLTF 预览（seal/light-relief/filigree）的线宽也与 3MF 一致。
- `chooseSingleExportPixelsPerMm` 入参类型从 `ProcessedArtwork` 收窄为 `Pick<ProcessedArtwork, 'pixelsPerMm'|'boardWidthMm'|'boardHeightMm'>`，调用方全部兼容。
- 验证（`_testimg.png` 1685×934，detail:100/despeckle:49/smoothing:10/minLineWidth:0.4）：预览位图 vs 3MF mask 视觉一致，无黑块、无细节糊化。
- 性能：位图嵌入对 processArtwork 耗时几乎无影响；原 1685×934 + despeckle:49 流程本身约 35-50s（瓶颈在 `buildImageLineart`，不是新代码）。

## 预览/3MF 统一掩码管线（2026-08-28，WYSIWYG 真正落地）
- **根因**：预览位图（`shapeLoopsForPrintPreview`）此前只 rasterize + applyMinimumLineWidth，**漏掉 加粗/缩小描边两步**；3MF（`extrudeMaskToMesh`）做完整 rasterize→shrink→expand→minLineWidth。用户设了 shrinkStrokeMm 时 3MF 把眼睛瞳孔/高光腐蚀没了、预览却还清晰 → "和预览差得远了"。
- **修复**：抽取 `buildExportLineMask(loops, W, H, pxPerMm, minLineWidth, expand, shrink)` 统一管线，`extrudeMaskToMesh` 与 `shapeLoopsForPrintPreview` 都调它。预览与 3MF 自此逐像素一致（**已导出该函数供测试**）。
- **消失组件救援**：`rescueVanishedComponents` + `labelSolidComponents`（8 连通域）。腐蚀后逐域检查，完全被吞的组件以原始像素救回，再由 applyMinimumLineWidth 保底——兑现 UI 承诺"缩小描边不低于最小线宽、不删细节"（旧版只在全局保 10% 填充量，不保局部小特征）。
- **传参链**：`processArtwork` 预览传 `lineartSettings.expandStrokeMm/shrinkStrokeMm`；`rebuildArtworkWithLineLoops`/`applyLineartStrokeEdit`/`applyNumberingToArtwork` 加 `strokeOptions?: LineartStrokeMaskOptions`（已 export interface）；Home.tsx 用 `lineartStrokeOptions`（useMemo）在三处 rebuild + brush 编辑都传。
- **决定性验证**：`realImageLineDebug.test.ts` 改成调真实 `buildExportLineMask` 做 3MF 侧 → 预览位图 vs 3MF mask **差异 0.00%**（此前 21.3% 是测试自绘 canvas 模拟的假象）。新增 4 个 `buildExportLineMask` 单元测试。
- 教训：1）"走相同函数"≠"参数相同"，必须逐参数比对；2）真实导出函数做 parity 测试 > 测试自绘模拟（后者引入取样差异造成假象/漏检）。

## 验证命令（webapp 目录）
- 类型：`npm run check`（tsc -b --noEmit）
- 测试：`npm test`（vitest run，当前 ~50 条：baseline 45 + 调试 5）
- 构建：`npm run build`（tsc + vite build + inline-dist 单文件）

## 注意
- 此项目曾因 `git stash` 损坏仓库（.git/refs 损坏、pack 丢失），用 `git fetch https://github.com/MadeSpark/image-to-lineart-3mf.git main` 恢复。今后避免在此项目用 `git stash`。
