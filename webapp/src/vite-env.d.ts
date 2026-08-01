/// <reference types="vite/client" />

import type * as React from 'react'

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
