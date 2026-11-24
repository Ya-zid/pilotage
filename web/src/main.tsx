import './styles.css';
import React, { Suspense, lazy, useEffect } from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';
import { queryClient, useServerEvents } from './api';
import { useNeedsYouSignals } from './needsYou';
import { AppProvider } from './components/AppContext';
import { Layout } from './components/Layout';
import { ToastProvider, useToast, LoadingCard, Empty } from './components/ui';
import Today from './pages/Today';
import Projects from './pages/Projects';
import Project from './pages/Project';
import Sessions from './pages/Sessions';
import Session from './pages/Session';
import More from './pages/More';

const HistoryPage = lazy(() => import('./pages/Timeline')); // History (the old Timeline page)
const Portfolio = lazy(() => import('./pages/Portfolio'));
const Ideas = lazy(() => import('./pages/Ideas'));
const Settings = lazy(() => import('./pages/Settings'));
const Tasks = lazy(() => import('./pages/Tasks'));
const Guide = lazy(() => import('./pages/Guide'));
const MapPage = lazy(() => import('./pages/Map'));

/** Old addresses keep working: /live → /sessions, /timeline → /history (query string and hash kept). */
function Redirect({ to }: { to: string }) {
  const loc = useLocation();
  return <Navigate to={{ pathname: to, search: loc.search, hash: loc.hash }} replace />;
}

function PairedNotice() {
  const [params, setParams] = useSearchParams();
  const toast = useToast();
  useEffect(() => {
    if (params.get('paired') === '1') {
      toast('This device is paired. Tip: add Pilotage to your home screen.');
      params.delete('paired');
      setParams(params, { replace: true });
    }
  }, []);
  return null;
}

function NotFound() {
  const navigate = useNavigate();
  return (
    <Empty title="Page not found">
      <button className="btn" onClick={() => navigate('/')}>
        Back to Home
      </button>
    </Empty>
  );
}

// Last resort for errors outside a page (pages have their own boundary inside Layout).
class Boundary extends React.Component<{ children: React.ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (this.state.error)
      return (
        <div className="callout warn" style={{ margin: 24 }}>
          <div>
            <div className="bold">This page crashed</div>
            <div className="small mono">{this.state.error.message}</div>
            <button className="btn sm" style={{ marginTop: 8 }} onClick={() => location.reload()}>
              Reload
            </button>
          </div>
        </div>
      );
    return this.props.children;
  }
}

function App() {
  useServerEvents();
  useNeedsYouSignals();
  return (
    <>
      <PairedNotice />
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<Today />} />
          <Route path="projects" element={<Projects />} />
          <Route path="projects/:id" element={<Project />} />
          <Route path="sessions" element={<Sessions />} />
          <Route path="sessions/:id" element={<Session />} />
          <Route path="live" element={<Redirect to="/sessions" />} />
          <Route path="tasks" element={<Suspense fallback={<LoadingCard />}><Tasks /></Suspense>} />
          <Route path="history" element={<Suspense fallback={<LoadingCard />}><HistoryPage /></Suspense>} />
          <Route path="timeline" element={<Redirect to="/history" />} />
          <Route path="guide" element={<Suspense fallback={<LoadingCard />}><Guide /></Suspense>} />
          <Route path="portfolio" element={<Suspense fallback={<LoadingCard />}><Portfolio /></Suspense>} />
          <Route path="ideas" element={<Suspense fallback={<LoadingCard />}><Ideas /></Suspense>} />
          <Route path="map" element={<Suspense fallback={<LoadingCard />}><MapPage /></Suspense>} />
          <Route path="settings" element={<Suspense fallback={<LoadingCard />}><Settings /></Suspense>} />
          <Route path="more" element={<More />} />
          <Route path="*" element={<NotFound />} />
        </Route>
      </Routes>
    </>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Boundary>
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <AppProvider>
            <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
              <App />
            </BrowserRouter>
          </AppProvider>
        </ToastProvider>
      </QueryClientProvider>
    </Boundary>
  </React.StrictMode>,
);
