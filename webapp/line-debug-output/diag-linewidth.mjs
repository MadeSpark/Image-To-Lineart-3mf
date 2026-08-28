// 复现"线宽膨胀"问题
const pxPerMm = 6.93
const minWidthMm = 0.4

// 当前代码公式
const minRadius = Math.max(0, Math.ceil((minWidthMm * pxPerMm - 1) * 0.5))
console.log('当前最小线宽保护：dilate by', minRadius, 'px (radius)')
console.log()

// 模拟不同输入线宽
for (let inputPx = 1; inputPx <= 8; inputPx++) {
  const outPx = inputPx + 2 * minRadius
  console.log(`  输入 ${inputPx}px (${(inputPx/pxPerMm).toFixed(3)}mm) -> 输出 ${outPx}px (${(outPx/pxPerMm).toFixed(3)}mm)`)
}
console.log()

console.log('用户期望：3px (0.43mm) 不应该被膨胀成 5px (0.72mm)')
console.log('根因：公式 ceil((minWidth*pxPerMm - 1) * 0.5) 是按"输入只有 1px"反推的，')
console.log('     对更宽的输入线一律按"1px 底线"处理，所有线都被加粗 2px')
