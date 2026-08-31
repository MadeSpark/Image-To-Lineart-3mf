# image-to-lineart-3mf

将图片或 DXF 线稿转换为可打印的线稿底板模型，并导出为 `3MF / DXF / SVG / PNG / JSON`。

## 当前功能

- 批量导入 `PNG / JPG / GIF`，GIF 自动拆帧
- 导入与导出线稿 `DXF`
- 按目标颜色提取线稿，可调采样细节、颜色容差、杂点清理、线条宽度、线条平滑、镜像
- 三种工作模式：
  - **掐丝（filigree）**：传统掐丝珐琅工艺底板
  - **印章（seal）**：印章刻制
  - **光映浮雕（light-relief）**：灰度高度图浮雕，免支撑可打印形态
- 自动生成轮廓底板，支持矩形、圆形和轮廓模板
- 调整底板厚度、线稿高度、线稿厚度
- 导出 `3MF`，并拆分为底板与线稿两个部件
- 批量导出多个文件或合并导出单个 `3MF`
- 参数自动保存到浏览器 `localStorage`

## 双击即用（无需安装任何环境）

应用**运行时不依赖 Node.js**（Node 仅用于开发构建）。构建产物是单个 `index.html`，
JS / CSS / 3D 预览 Worker / 默认打印参数模板全部内联，可以：

- **双击直接打开**：`webapp/dist/index.html`（file:// 协议完全可用）
- 传给朋友：发一个文件即可
- 放 U 盘 / 网盘随身携带

## 部署到宝塔面板（或任意静态空间）

1. 本地执行 `npm run build`
2. 把 `webapp/dist/index.html` **这一个文件**上传到站点根目录
3. 完成。无需 Node 环境、无需反向代理、无需重启服务

放在子路径（如 `/tools/lineart/`）下也能正常工作，因为构建产物不含绝对路径引用。

## 项目结构

- `webapp/`：主项目，React + TypeScript + Vite
- `webapp/test-assets/`：测试图片
- `worker/visitor-counter/`：Cloudflare Worker 访客计数（可选功能）

## 本地开发

```bash
cd webapp
npm install
npm run dev
```

## 构建单文件产物

```bash
cd webapp
npm run build   # 产物：webapp/dist/index.html（单文件）
```

## 测试

```bash
cd webapp
npm run check   # tsc 类型检查
npm test        # vitest 单元测试
```

> `src/utils/smoothingCompare.test.ts` 默认 `it.skip`（单次运行 6~7 分钟的调优对比手册），
> 需要时把 `it.skip` 改回 `it` 单独运行；`realImageLineDebug.test.ts` 同理为调试工具。
