import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ThicknessPanel } from '@/components/ThicknessPanel'

describe('ThicknessPanel', () => {
  it('commits slider changes after mouse release', () => {
    const onUpdateSettings = vi.fn()

    render(
      <ThicknessPanel
        settings={{
          baseThicknessMm: 0.2,
          lineThicknessMm: 0.2,
          lineHeightMm: 0.2,
        }}
        onUpdateSettings={onUpdateSettings}
      />,
    )

    const slider = screen.getAllByDisplayValue('0.2')[0] as HTMLInputElement
    fireEvent.change(slider, { target: { value: '0.45' } })
    expect(onUpdateSettings).not.toHaveBeenCalled()

    fireEvent.mouseUp(slider)
    expect(onUpdateSettings).toHaveBeenCalledWith({ baseThicknessMm: 0.45 })
  })
})
