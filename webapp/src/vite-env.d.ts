/// <reference types="vite/client" />

import type * as React from 'react'

// 3MF 预设模板以 base64 data URL 内联（vite ?inline 后缀），
// 供 threeMfProfile.ts 在无服务器环境下 fetch 使用
declare module '*.3mf?inline' {
  const src: string
  export default src
}

interface ImportMetaEnv {
  readonly VITE_VISITOR_COUNTER_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

declare global {
  const __APP_VERSION__: string

  namespace JSX {
    interface IntrinsicElements {
      'model-viewer': React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement> & {
        src?: string
        alt?: string
        exposure?: string | number
        poster?: string
        'camera-controls'?: boolean | string
        'camera-orbit'?: string
        'camera-target'?: string
        'interaction-prompt'?: string
        'shadow-intensity'?: string | number
        'touch-action'?: string
        'disable-pan'?: boolean | string
        'environment-image'?: string
        'min-camera-orbit'?: string
        'max-camera-orbit'?: string
      }
    }
  }
}

export {}
