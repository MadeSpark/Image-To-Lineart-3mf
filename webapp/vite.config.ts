import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'
import tsconfigPaths from 'vite-tsconfig-paths'

const versionFile = JSON.parse(
  readFileSync(resolve(__dirname, 'version.json'), 'utf-8'),
) as { version?: string }

// https://vite.dev/config/
export default defineConfig(({ command }) => ({
  base: './',
  // 让 vite 把 .3mf 识别为二进制资产（配合 `?inline` 后缀转 base64 data URL）；
  // 缺了它 vitest/构建会把 default-print-profile.3mf?inline 当 JS 源码解析报错
  assetsInclude: ['**/*.3mf'],
  define: {
    __APP_VERSION__: JSON.stringify(versionFile.version ?? '0.0.0'),
  },
  build: {
    // 单文件部署（双击 index.html / 宝塔静态站）必需：
    // 1. 关闭 sourcemap —— dist 不产生 .map 散件
    // 2. inlineDynamicImports —— model-viewer 懒加载块合并进主包，
    //    否则内联后的 HTML 会在 file:// 下因动态 import 被 CORS 拦截而 3D 预览白屏
    sourcemap: false,
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
      },
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: './src/test/setup.ts',
  },
  plugins: [
    react({
      babel: {
        // react-dev-locator 给每个 JSX 元素注入源码位置属性（trae-inspector-*），
        // 仅开发服务器需要（编辑器跳转联动）；生产包里纯属体积和隐私负担
        plugins: command === 'serve' ? ['react-dev-locator'] : [],
      },
    }),
    tsconfigPaths(),
  ],
}))
