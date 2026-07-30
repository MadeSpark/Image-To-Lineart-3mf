# image-to-lineart-3mf

将图片或 DXF 线稿转换为可打印的线稿底板模型，并导出为 `3MF / DXF / SVG / PNG / JSON`。

## 项目结构

- `webapp/`：主项目，基于 React + TypeScript + Vite
- `动画/`：示例动画帧素材，保留用于批量导入和测试

## 当前功能

- 批量导入 `PNG / JPG / GIF`
- GIF 自动拆帧并选择需要处理的帧
- 导入与导出线稿 `DXF`
- 按目标颜色提取线稿，可调采样细节、颜色容差、杂点清理、线条宽度、线条平滑、镜像
- 自动生成轮廓底板，支持矩形、圆形和轮廓模板
- 调整底板厚度、线稿高度、线稿厚度
- 导出 `3MF`，并拆分为底板与线稿两个部件
- 批量导出多个文件或合并导出单个 `3MF`
- 自动保存线稿、底板、厚度参数到浏览器 `localStorage`

## 本地运行

```bash
cd webapp
npm install
npm run dev
```

打开浏览器后即可导入图片、GIF 或 DXF，调整参数并导出模型文件。

## 构建

```bash
cd webapp
npm run build
```

## 测试

```bash
cd webapp
npm run check
npm run test
```
