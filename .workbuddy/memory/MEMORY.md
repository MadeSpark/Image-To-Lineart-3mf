# 转向量项目长期记忆

## 项目概述
图片转线稿导出 3MF 的 3D 打印工具 web 应用（React + TypeScript + Vite + zustand + vitest）。
工作目录：`D:\DevelopmentFolder\Nodejs\转向量\webapp`。三种工作模式：filigree（掐丝）、seal（印章）、light-relief（光映浮雕）。

## 验证命令（webapp 目录）
- 类型：`npm run check`（tsc -b --noEmit）
- 测试：`npm test`（vitest run）— **`realImageLineDebug.test.ts` 大图测试 ≥5min**，CI/CD 里需要单独跑或加 timeout
- 构建：`npm run build`（tsc + vite build + inline-dist 单文件）

## 单文件构建约定（2026-09-01 定案，dist/index.html 双击即用）
- **运行时零依赖 Node.js**：产物单文件 1.8MB，JS/CSS/worker/预设全内联；宝塔部署=上传这一个文件。
- 三件套：`sourcemap:false` + `inlineDynamicImports:true`（model-viewer 懒加载块，file:// 动态 import 被 CORS 拦）+ `?worker&inline`（Blob worker）。
- ⚠️ `assetsInclude: ['**/*.3mf']` 必须配（vite 默认不认 .3mf，否则 ?inline 被 import-analysis 当 JS 解析报错，vitest 5 文件连挂）。
- ⚠️ **worker 子构建不认 `@/` 别名**（vite-tsconfig-paths 不进 vite:worker 子图）：被 worker 引用链拖进去的模块里的资产 import 必须用**相对路径**（如 `../assets/default-print-profile.3mf?inline`）。报错指向 worker 文件本身，真实坏 import 在共享模块里。
- dist 验证：`ls dist/` 仅 index.html；grep `src="\./`、`href="\./`、`/presets/` 应无结果；`<script type="module">` 无 src=全内联。LottieLoader CDN 字符串与 h5bp CSS 注释是 three/normalize.css 源码残留，无害。
- 测试约定：smoothingCompare / realImageLineDebug 默认手动跑（6~7min / 5min+），测试资产在 `webapp/test-assets/`，调试输出进 `.debug/`。
- node_modules 半损坏（.bin 空、babel 缺 debug.js、测试全挂）→ `npm install` 修不好，必须 `npm ci`。
- git 状态：commit 357d255 完成单文件化+清理（约15MB垃圾：.git-backup/、.dbg/、动画/、lithophane.3mf、lineart_converter.py、favicon.svg 等）；favicon 引用已从 index.html 删除。

## 坐标系契约（关键，2026-09-01 踩坑后强化）

**所有 `finalizeLineLoops`/`layoutLineLoops` 入口 loops 都已是 mm 坐标系**：
- 图像源：buildImageLineart 输出 `scaleLoopsToMaxDimension(normalizeLoops(loops), 40)`——最长边 40mm
- DXF 源：`normalizeLoops(importedLineart.loops)` 平移到 minX/minY=0
- layoutLineLoops 缩放到 board（图像 board 通常 ~100mm 宽，最大缩放 ~3.5x）

❌ 不要再调 `pixelsToMm(loop, pixelsPerMm, paddingMm)`——会把 mm 当 pixel 又除一次，画面挤到 [0, 12mm] 角落。
✅ finalizeLineLoops 现在的 3 分支：
  - alreadySmoothed → 只过滤+dedupe
  - DXF + smoothing>0 → mm 坐标系直接 smoothLoops
  - smoothing=0 → 保留 rasterize→trace→pixelsToMm round-trip（与历史兼容）

## 设置持久化机制（generatorStore.ts）
- 分模式 localStorage key：`lineart-baseplate-generator-settings-{filigree|seal|light-relief}`，另有 `-shared`。
- 载入时 `normalizeXxxSettings` 用 `{ ...defaultXxx, ...parsed }` 合并，parsed 字段覆盖默认。
- **含义**：改某个默认值时，老用户的历史快照里若已带旧默认值，重载仍会读到旧值——需配 schema 版本迁移。

## schema 版本迁移约定
- 独立 key `lineart-baseplate-generator-settings-schema-version`，**当前 = 4**。
- `migrateStoredSettings()` 在模块顶层、loadXxxSettings 之前调用一次。
- 策略：旧默认值若仍残留在快照里 → 视为"用户未改过"，**删除该字段**使其回落到新默认；其他值视为"用户已显式修改"，保留。
- 迁移史：v1→v2 smoothing 旧默认 36→删字段回落到 10；v2→v3 `autoOptimize=true` 强制改 false；
  v3→v4 删除已废弃的 `lightReliefSettings.bFaceReverseStack`。
- 测试：generatorStore.test.ts 三条迁移测试（36→10、20→保留、v4 删 bFaceReverseStack）。

## 关键默认值
- `defaultLineartSettings.smoothing` = 10（2026-08-24 由 36 改）。
- 三模式 lineart 默认都源自 `defaultLineartSettings`（seal 仅多 mirror:true）。
- **自动调参已彻底删除**（2026-08-27）：`calculateAutoLineartParams` 与"自动识别优化"开关都删了，
  所有参数严格用 UI 上的值，不再按图片分辨率覆盖。

## 光映浮雕几何【2026-08-30 第 12 轮定案：唯一解 = 柱体坐在 A 面底板上】
> ⚠️ 本节推翻了第 10/11 轮的「▼ 反向堆叠 + 倒扣打印」结论。**不要再加回 ▼ 或背景顶盖。**

**唯一可打印形态**：浮雕柱体底面齐平贴死 `faceBZMm`（与背景下层全接触、零空腔），
顶面随灰度起伏，凹凸面裸露朝上 → 截面随 Z 单调收缩（SHRINKING）→ **0% 悬垂、免支撑、无空气间隙**。

**为什么只能是这个形态**（三轮实测推翻，务必记住）：
- 免支撑 ⟹ 截面随 Z 单调不增 ⟹ 承载图像的凹凸面必须在外面朝上。
- 曾实现「▼ 反向堆叠」（柱体吊挂、尖端朝 A 面 + 导出倒扣 180°）：
  - 正打 → 柱底悬空、GROWING，需支撑；
  - 倒扣 180° → 背景下层实心底板被甩到顶部变悬顶，**实测第一层 87.5% 悬空**，下方空腔平均 0.848mm / 最大 1.35mm。
- 「把空腔填平」→ 各柱总厚度变常量 → 图像消失；「让每根柱尖都贴 A 面」→ 各柱等高 → 同样无图像。
- **背景顶层（顶盖）永久删除**：实心板盖在凹凸面上方，只有最高峰顶得到，谷底上方全空腔 → 悬顶 + 挡光。

**已删除的东西**：`bFaceReverseStack` 开关（types/store/UI 全部移除）、
`<item>` 的 180° X 轴翻转 transform、预览里的倒扣翻转。预览朝向 = 导出朝向 = 可打印朝向。

**高度图分辨率封顶（2026-08-31 加）**：`buildHalftoneReliefMesh` 的 `pixelsPerMm` 参数**是死参数**（已删），
网格规模完全由高度图 W/H 决定。高度图走 `choosePixelsPerMm`（下限 4px/mm），大板会失控 → 用
`capHalftoneHeightMapDensity`（在建网格前调用，导出/预览共用，所见即所得）：
- `RELIEF_CELLS_PER_MM = 5`（即 0.2mm/格，比 0.4mm 喷嘴细一倍，打印无损）；
- `RELIEF_MAX_CELLS = 720_000`（绝对格数兜底，720K 格≈196MB XML，距 V8 上限约 2.7 倍余量）；
- 降采样用**盒式平均**（不是抽样），细密图案收敛为均匀灰、无摩尔纹。
实测：150×100mm 面数降 61%（385万→151万），500×500mm 从 1600 万面降到 288 万面。
⚠️ 单靠密度封顶会失效（源分辨率变粗时），必须**密度 + 绝对格数双重封顶**。

## 浮点与测试构造坑
- heights[] 存 Float32，取出 0.05000000074505806 > 64 位 0.05，涉及与 minThick 比较的分支需加 1e-5 容差。
- 3MF 打包函数返回 **Uint8Array**（不是 Blob），测试里别调 `.arrayBuffer()`。
- 构造测试 artwork：`baseplateSettings` 要含 `lineColor/baseColor`（用 defaultBaseplateSettings），
  `artwork.previews.compositeDataUrl` 要给（哪怕空串）。
- **⚠️ 底 plate 必须用真实轮廓**：传 `baseLoops: []` 会让背景下层退化成 0 顶点的空网格，
  而 `expect(parsed['背景下层']).toBeTruthy()` 对空数组 `[]` **也是真值** → 断言形同虚设。
  「底板悬顶 87.5%」就是这么一路绿灯溜过去的。现在断言都附加 `.length > 0` 检查。

## 可打印性判据（reliefSliceDiagnostic.test.ts）
- **用 startLayer 法**：`startLayer = floor((bottomZ − zMin) / layerH)`，> 0 ⟹ 柱底悬空。
  早前的「本层下方是否有材料」gap 判据会算出假绿（gap 恒为 0），**别改回去**。
- GROWING/SHRINKING 不变式采样区间要严格落在 (zStart, top) 内，避免最顶层整层归零造成假降。
- **判据必须覆盖全部 mesh**（浮雕 + 背景下层 + 顶盖），只统计浮雕会漏掉悬顶。
- ✅ **可复用的「剖面 ASCII 图」验证法**：临时 `*.test.ts` 调真实 `buildLightReliefPreviewModelGltfBlob`
  → `JSON.parse(await blob.text())` → 取名字含「浮雕」的 mesh 的 POSITION → glTF 是 Y-up，
  **几何 Z（向上）在分量 index 1**。按 X 分桶画 ASCII，行号 `round((1-(z-zMin)/span)*(ROWS-1))`。验证完删掉临时文件。

## 跨轮次核心教训
- **"需要支撑"≠"打不出来"**——别一看到 overhang 就删形态；但也别把"倒扣能救"当成万能药，
  倒扣会把另一头的实心件变成悬顶。**必须对整个组合体逐层审计**。
- 改几何语义前**先复述形状给用户确认**。
- 区分「背景顶层盖板」（可删）和「浮雕自身的平整顶面」（曾误判为可删）。
- ⚠️ 用户会中途推翻早前定性过的"核心需求"（金标准也会变），以最新明确选择为准。
- 「主功能」和「副作用修复」不要混淆。

## 2D 预览与 3MF 一致（WYSIWYG）
- `processArtwork` 的 2D SVG 预览线稿层**直接嵌位图 PNG**：用与导出相同的
  `chooseSingleExportPixelsPerMm` + `minLineWidthMm` 生成 0/1 mask，以 `<image href="data:image/png;base64,...">` 嵌入。
  不走"trace→smooth"矢量化（对 2-3px 细线会产生台阶+塌陷）。`artwork.lineLoops` 仍保留矢量供 3MF 用。
- **统一掩码管线**：`buildExportLineMask(loops, W, H, pxPerMm, minLineWidth, expand, shrink)`（已 export），
  `extrudeMaskToMesh` 与 `shapeLoopsForPrintPreview` 都调它 → 预览与 3MF 逐像素一致。
- **消失组件救援**：`rescueVanishedComponents` + `labelSolidComponents`（8 连通域）。腐蚀后逐域检查，
  完全被吞的组件以原始像素救回，再由 applyMinimumLineWidth 保底（兑现"缩小描边不删细节"承诺）。
- `choosePreviewModelPixelsPerMm` 复用 `chooseSingleExportPixelsPerMm`，3D GLTF 预览线宽也与 3MF 一致。
- `applyPrintSafeSolidFeatures`（fillSmallHoles + enlargeSmallComponents）已删除——低分辨率下把眼睛等
  小细节当成"小斑块"填实或放大成黑块。
- 教训：1）"走相同函数"≠"参数相同"，必须逐参数比对；2）真实导出函数做 parity 测试 >
  测试自绘 canvas 模拟（后者引入取样差异造成假象/漏检）。

## 注意
- 此项目曾因 `git stash` 损坏仓库（.git/refs 损坏、pack 丢失），用
  `git fetch https://github.com/MadeSpark/image-to-lineart-3mf.git main` 恢复。**今后避免在此项目用 `git stash`。**
