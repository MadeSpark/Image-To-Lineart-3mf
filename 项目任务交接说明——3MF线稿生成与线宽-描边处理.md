# 项目任务交接说明

> 本文用于将当前项目的上下文、已经完成的修改以及后续注意事项交给下一位 AI。
>
> **项目目录：** `d:\DevelopmentFolder\Nodejs\转向量\webapp`
>
> **主要技术栈：** TypeScript / React / Vite
>
> **当前任务核心：** 线稿转 3D 模型时，预览与导出线条粗细不一致，以及增加可控的线条加粗/缩小描边功能，并从导入的 3MF 中读取打印参数。

---

## 1. 最初发现的问题

用户最初提出的问题：

> 不用写代码，帮我检查一下：
>
> 1. 生成模型时，耗材线条粗细是根据什么来设置的？
> 2. 为什么底板预览时线条明明没那么粗，结果导出的模型打开一看线条变粗了一点？
> 3. 导致一些细节，比如眼睛的地方，线条直接糊在一起变成黑块了。

---

# 2. 初步代码检查结论

检查的核心文件：

```text
src/utils/generator.ts
src/components/PreviewCanvas.tsx
src/components/ThreeDModelViewer.tsx
src/components/ThicknessPanel.tsx
```

其中 `generator.ts` 是核心生成逻辑。

---

## 2.1 预览与导出的 `pixelsPerMm` 不一致

发现：

| 模式 | pixelsPerMm |
|---|---:|
| 预览 | 约 2.5 ~ 8 |
| 单个模型导出 | 约 12 ~ 32 |

典型情况下导出的光栅化分辨率约为预览的 3～4 倍。

相关函数：

```ts
choosePreviewModelPixelsPerMm()
chooseSingleExportPixelsPerMm()
chooseCombinedExportPixelsPerMm()
```

位置大约：

```text
generator.ts
1933
1945
1957
```

因为 `extrudeMaskToMesh()` 会先把矢量 loops 光栅化成 mask，所以预览和导出使用不同分辨率，会造成边缘像素化处理存在差异。

---

# 3. 真正导致“眼睛变黑块”的主要原因

最关键的问题并不是单纯的 `pixelsPerMm`。

而是：

```ts
applyPrintSafeSolidFeatures()
```

这个处理只在导出模型时执行，而预览没有执行。

历史代码中的两个重要常量：

```ts
MIN_EXPORTABLE_SOLID_DIAMETER_MM = 0.9
MAX_EXPORTABLE_HOLE_DIAMETER_MM = 0.7
```

相关函数：

```ts
applyPrintSafeSolidFeatures()
fillSmallHoles()
enlargeSmallSolidComponents()
```

大约位于：

```text
generator.ts
4327+
```

---

## 3.1 `fillSmallHoles`

作用：

> 把小于/等于约 0.7mm 的封闭空白区域填成实心。

因此：

```text
眼睛内部的小空隙
        ↓
小于安全孔洞阈值
        ↓
被 fillSmallHoles 填充
        ↓
眼睛细节变成黑块
```

---

## 3.2 `enlargeSmallSolidComponents`

作用：

> 将过小的独立实体扩大到最小可打印尺寸。

原阈值：

```text
MIN_EXPORTABLE_SOLID_DIAMETER_MM = 0.9mm
```

因此细线：

```text
细线
 ↓
小于 0.9mm
 ↓
膨胀
 ↓
与附近线条合并
 ↓
细节糊掉
```

---

## 3.3 预览与导出的实际差异

| 处理 | 预览 | 导出 |
|---|---:|---:|
| `pixelsPerMm` | ✓ | ✓ |
| `applyMinimumLineWidth` | ✓ | ✓ |
| `fillSmallHoles` | ✗ | ✓ |
| `enlargeSmallSolidComponents` | ✗ | ✓ |

因此：

**用户看到的预览并不是最终 3D 模型实际使用的几何结果。**

这就是最初“预览看起来正常，导出后眼睛糊掉”的核心原因。

---

# 4. 用户提出的新需求

在查明原因后，用户提出了新的设计要求：

## 4.1 最小线宽从导入的 3MF 读取

原本：

```ts
const MIN_EXPORTABLE_LINE_WIDTH_MM = 0.24
```

是硬编码。

用户要求：

> 最小线宽可以由导入的 3MF 读取。

因此增加：

```ts
minLineWidthMm
```

默认值仍然应该兼容原来的：

```text
0.24mm
```

---

# 5. 从 3MF 读取打印参数

用户同时要求：

> 层高可以由导入的 3MF 读取。

计划/实现涉及：

```text
src/utils/threeMfProfile.ts
src/pages/Home.tsx
src/types/generator.ts
```

3MF 中读取：

```text
layer_height
line_width
```

解析方式使用类似：

```ts
readNumber(...)
```

最终导入时将读取到的值应用到生成设置。

---

## ⚠️ 重要：这里存在历史记录中的映射歧义

历史记录中出现过两种不同的判断：

### 早期最终报告说：

```text
layer_height → lineHeightMm
line_width   → minLineWidthMm
```

### 但实现过程中的进一步分析认为：

3D 打印中的：

```text
layer_height
```

更合理地应该对应：

```text
lineThicknessMm
```

因为：

- `lineThicknessMm` = 线稿在 Z 方向的厚度
- `lineHeightMm` = 线稿开始的 Z 高度

而 3MF 的：

```text
layer_height
```

本质上是打印层高。

**因此如果后续 AI 继续修改这里，务必直接检查当前代码实际实现，不要仅根据本交接文档猜测。**

这是当前上下文中最值得重新确认的一点。

---

# 6. 新增“加粗描边”和“缩小描边”

用户明确要求：

> 线条加粗改为增加描边，同时再加一个缩小描边，默认都是 0。

新增两个设置：

```ts
expandStrokeMm: number
shrinkStrokeMm: number
```

含义：

### `expandStrokeMm`

加粗描边。

例如：

```text
原线条
████

expandStrokeMm = 0.1

██████
```

本质上对 mask 进行膨胀。

---

### `shrinkStrokeMm`

缩小描边。

作用：

> 缩小所有线条的粗细。

本质上对 mask 进行腐蚀。

---

# 7. 加粗与缩小必须互斥

用户明确要求：

> 若其中一个数值不为 0，则自动禁用操作另一个，除非重新归零。

因此：

```text
expandStrokeMm = 0
shrinkStrokeMm = 0
```

时：

```text
两个控件都可用
```

如果：

```text
expandStrokeMm > 0
```

则：

```text
shrinkStrokeMm 禁用
```

只有重新：

```text
expandStrokeMm = 0
```

之后：

```text
shrinkStrokeMm
```

才恢复可编辑。

反过来也一样。

---

# 8. 缩小描边不能突破最小线宽

用户明确要求：

> 缩小描边会缩小所有线条的粗细，若该线条小于最小线宽则保留在最小线宽。

因此核心逻辑应该是：

```text
原始线条
   ↓
Shrink / 腐蚀
   ↓
检查最小线宽
   ↓
低于 minLineWidthMm
   ↓
恢复/保持到 minLineWidthMm
```

不能简单地：

```ts
erodeMask(...)
```

然后结束。

必须保证：

```text
最终线宽 >= minLineWidthMm
```

---

# 9. 当前模型处理逻辑

最终设计的 `extrudeMaskToMesh()` 处理顺序：

```text
Vector loops
    ↓
rasterizeLoopsToMask()
    ↓
如果 shrinkStrokeMm > 0
    ↓
erodeMask()
    ↓
如果 expandStrokeMm > 0
    ↓
dilateMask()
    ↓
applyMinimumLineWidth()
    ↓
保证最终线条不低于 minLineWidthMm
    ↓
applyPrintSafeSolidFeatures()
    ↓
生成 3D mesh
```

需要特别注意：

用户要求的：

```text
加粗描边 / 缩小描边
```

和：

```text
最小可打印线宽
```

是三个不同概念。

不要把它们混成一个参数。

---

# 10. `ExtrudeSettings` 新增字段

历史实现计划/修改为：

```ts
export interface ExtrudeSettings {
  baseThicknessMm: number
  lineThicknessMm: number
  lineHeightMm: number

  expandStrokeMm: number
  shrinkStrokeMm: number
  minLineWidthMm: number
}
```

默认值：

```ts
export const defaultExtrudeSettings = {
  baseThicknessMm: 0.2,
  lineThicknessMm: 0.2,
  lineHeightMm: 0.2,

  expandStrokeMm: 0,
  shrinkStrokeMm: 0,
  minLineWidthMm: 0.24,
}
```

具体当前字段命名和默认值应以代码实际状态为准。

---

# 11. UI 修改

主要 UI 文件：

```text
src/components/ThicknessPanel.tsx
```

新增两个控件：

```text
加粗描边
缩小描边
```

默认：

```text
0
```

交互：

```text
加粗描边 = 0
缩小描边 = 0
    ↓
都可以编辑

加粗描边 > 0
    ↓
缩小描边 disabled

加粗描边归零
    ↓
缩小描边恢复

缩小描边 > 0
    ↓
加粗描边 disabled

缩小描边归零
    ↓
加粗描边恢复
```

历史记录显示这部分已经实现。

---

# 12. 已经修改/涉及的主要文件

当前任务过程中涉及：

```text
src/types/generator.ts
src/stores/generatorStore.ts
src/utils/threeMfProfile.ts
src/utils/threeMfProfile.test.ts

src/utils/generator.ts
src/utils/generator.test.ts

src/pages/Home.tsx

src/components/ThicknessPanel.tsx
src/components/ThreeDModelViewer.tsx

src/workers/threeDPreview.worker.ts
```

历史记录还显示存在其他原本就处于修改状态/未跟踪状态的文件，不要默认全部都是本次任务产生的。

---

# 13. 已完成的修改

历史记录最后一次任务状态显示：

- `ExtrudeSettings` 类型与默认值：完成
- 3MF 读取 `layer_height` / `line_width`：完成
- `extrudeMaskToMesh` 使用 expand/shrink stroke：完成
- 所有 `extrudeMaskToMesh` 调用点更新：完成
- `ThicknessPanel` UI 与互斥禁用：完成
- TypeScript 检查：完成
- production build：成功
- 测试检查：完成，但存在 5 个旧测试失败



---

# 14. 验证结果

## TypeScript

```text
通过
```

## Production Build

```text
成功
```

## 测试

共有：

```text
5 个失败
```

历史记录认为这 5 个失败都是**修改前就存在的问题**，并通过 `git stash` 对比验证过。

具体包括：

1. `Home.test.tsx`
   - “恢复默认配置”文本找不到
   - 属于 UI 文本不匹配

2. `generatorStore.test.ts`
   - localStorage persistence 问题

3. `generatorStore.test.ts`
   - saved settings 未正确加载

4. `generatorStore.test.ts`
   - `applyImportedSettings` persistence 问题

5. `generator.test.ts`
   - combined 3MF package 缺少 `name="1-a"` 属性

这些被判断为与本次：

```text
3MF layer_height / line_width
expandStrokeMm
shrinkStrokeMm
minLineWidthMm
UI 互斥
```

无关。

---

# 15. 当前最重要的代码逻辑

原来的：

```ts
applyMinimumLineWidth(...)
```

主要作用是：

```text
把过细线条强制膨胀到最小线宽
```

原来的硬编码：

```ts
MIN_EXPORTABLE_LINE_WIDTH_MM = 0.24
```

现在应该由：

```ts
extrudeSettings.minLineWidthMm
```

控制。

---

# 16. 不要误解 `applyPrintSafeSolidFeatures`

目前新增的：

```text
expandStrokeMm
shrinkStrokeMm
```

并不能自动解决：

```text
眼睛变黑块
```

因为：

```ts
applyPrintSafeSolidFeatures()
```

仍然会进行：

```text
fillSmallHoles()
enlargeSmallSolidComponents()
```

其中：

```text
≤ 0.7mm 的小孔可能被填充
< 0.9mm 的小实体可能被放大
```

这仍然可能导致细节损失。

历史分析明确认为这才是原始问题中“眼睛变黑块”的主要原因。

---

# 17. 原始问题目前是否真正解决？

需要区分：

### 已解决

用户要求的新控制能力：

```text
✓ 3MF 读取打印参数
✓ 可设置最小线宽
✓ 加粗描边
✓ 缩小描边
✓ 加粗/缩小互斥
✓ 缩小后不低于最小线宽
✓ TypeScript
✓ Build
```

### 尚需实际确认

**预览和最终导出模型是否真正做到视觉上的一致。**

尤其需要实际验证：

```text
眼睛
嘴巴
头发细线
很小的封闭区域
相邻细线
```

因为：

```text
applyPrintSafeSolidFeatures()
```

依然可能改变这些细节。

---

# 18. 如果下一个 AI 要继续任务，优先检查什么？

建议按以下顺序：

## 第一优先级：确认当前代码实际状态

不要直接假设历史记录中的实现完全正确。

重点检查：

```text
src/types/generator.ts
src/stores/generatorStore.ts
src/utils/threeMfProfile.ts
src/pages/Home.tsx
src/utils/generator.ts
src/components/ThicknessPanel.tsx
```

---

## 第二优先级：确认 3MF 参数映射

特别检查：

```text
layer_height
line_width
```

到底分别写入：

```text
lineHeightMm
lineThicknessMm
minLineWidthMm
```

历史记录对此存在过解释上的冲突。

**应以当前代码和实际 3MF `project_settings.config` 为准。**

---

## 第三优先级：实际测试缩小描边

测试：

```text
shrinkStrokeMm = 0
0.05
0.10
0.15
0.20
```

观察：

```text
普通粗线
细线
眼睛
嘴巴
头发
相邻线条
```

确保：

```text
最终线宽不会低于 minLineWidthMm
```

---

## 第四优先级：实际测试加粗描边

例如：

```text
expandStrokeMm = 0.05
0.10
0.20
```

确认：

```text
所有线条统一增加粗细
```

且：

```text
shrinkStrokeMm
```

在 `expandStrokeMm > 0` 时确实被禁用。

---

## 第五优先级：重新确认 print-safe 处理是否符合产品需求

重点是：

```ts
fillSmallHoles()
enlargeSmallSolidComponents()
```

如果用户下一步反馈：

> 即使设置了缩小描边，眼睛还是黑块。

不要立即修改描边算法。

应该先检查：

```text
applyPrintSafeSolidFeatures
```

因为它发生在描边处理之后，并且会再次修改几何。

---

# 19. 后续如果要继续优化“预览 = 导出”

原始问题有两个潜在方案：

### 方案 A：预览也执行打印安全处理

优点：

```text
所见即所得
```

缺点：

```text
预览也会变糊
```

### 方案 B：降低/取消打印安全阈值

例如重新评估：

```text
MIN_EXPORTABLE_SOLID_DIAMETER_MM
MAX_EXPORTABLE_HOLE_DIAMETER_MM
```

优点：

```text
保留更多细节
```

缺点：

```text
过细结构可能实际无法打印
```

历史记录中尚未确定最终选择。

---

# 20. 交接给下一个 AI 的核心结论

如果只记住下面这些即可：

```text
1. 原始问题：
   预览线条正常，但导出的 3D 模型线条变粗，眼睛等细节变成黑块。

2. 主要原因：
   导出执行了 applyPrintSafeSolidFeatures，
   其中 fillSmallHoles / enlargeSmallSolidComponents
   会破坏小细节；预览没有执行。

3. 用户的新需求：
   - 最小线宽从导入 3MF 读取
   - 层高从导入 3MF 读取
   - 加粗改成“增加描边”
   - 新增“缩小描边”
   - 两者默认都是 0
   - 一个非 0 时自动禁用另一个
   - 归零后恢复
   - 缩小描边不能让线条低于最小线宽

4. 新设置：
   expandStrokeMm
   shrinkStrokeMm
   minLineWidthMm

5. 几何处理：
   shrink → expand → minimum line width floor → print-safe processing

6. 当前实现：
   历史记录显示以上修改已经完成。

7. 验证：
   TypeScript 通过
   production build 成功
   5 个测试失败，但历史记录认为全部是修改前就存在的问题。

8. 特别注意：
   layer_height 到底映射 lineHeightMm 还是 lineThicknessMm，
   历史记录存在不一致，继续修改前必须检查当前代码。

9. 下一步最值得做：
   用实际 3MF + 实际线稿测试导出结果，
   尤其检查眼睛、嘴巴、头发等细节，
   再决定是否需要修改 applyPrintSafeSolidFeatures。
```

---

## 当前任务状态

**功能开发阶段：已完成。**

**当前更适合进入：实际效果验证 / Bug 修复阶段。**

不要在没有实际验证的情况下继续大规模重构线宽算法。