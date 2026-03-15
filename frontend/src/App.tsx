import { BrowserRouter, Routes, Route, Link, useLocation } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import Dashboard from './pages/Dashboard'
import Editor from './pages/Editor'
import Library from './pages/Library'
import { ToastProvider } from './components/ui/Toaster'

const queryClient = new QueryClient()

function NavLink({ to, children }: { to: string; children: React.ReactNode }) {
  const location = useLocation()
  const isActive = location.pathname === to
  return (
    <Link
      to={to}
      className={`text-sm transition ${
        isActive
          ? 'font-medium text-[var(--foreground)]'
          : 'text-[var(--muted-foreground)] hover:text-[var(--foreground)]'
      }`}
    >
      {children}
    </Link>
  )
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
      <BrowserRouter>
        <div className="min-h-screen bg-[var(--background)]">
          <header className="border-b border-[var(--border)] px-6 py-3 flex items-center gap-6">
            <Link to="/" className="text-lg font-bold text-[var(--primary)]">ReelForge</Link>
            <nav className="flex items-center gap-4">
              <NavLink to="/">Projects</NavLink>
              <NavLink to="/library">Library</NavLink>
            </nav>
          </header>
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/editor/:projectId" element={<Editor />} />
            <Route path="/library" element={<Library />} />
          </Routes>
        </div>
      </BrowserRouter>
      </ToastProvider>
    </QueryClientProvider>
  )
}
