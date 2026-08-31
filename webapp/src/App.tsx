import { BrowserRouter, HashRouter, Route, Routes } from 'react-router-dom'
import Home from '@/pages/Home'

export default function App() {
  const Router = window.location.protocol === 'file:' ? HashRouter : BrowserRouter

  return (
    <Router>
      <Routes>
        <Route path="/" element={<Home />} />
        {/* 兜底：单文件部署常见非根路径 —— 直接访问 /index.html、宝塔子目录
            （如 /tools/lineart/）等。缺了它 BrowserRouter 会报
            "No routes matched" 并渲染白屏（2026-09-01 headless 实测踩坑）。 */}
        <Route path="*" element={<Home />} />
      </Routes>
    </Router>
  )
}
