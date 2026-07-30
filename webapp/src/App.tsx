import { BrowserRouter, HashRouter, Route, Routes } from 'react-router-dom'
import Home from '@/pages/Home'

export default function App() {
  const Router = window.location.protocol === 'file:' ? HashRouter : BrowserRouter

  return (
    <Router>
      <Routes>
        <Route path="/" element={<Home />} />
      </Routes>
    </Router>
  )
}
