import { useCallback, useEffect, useState } from 'react';
import { api } from './api';
import { Ctx, type Meta, type Route, type Settings, type Screen } from './ui';
import { Home } from './screens/Home';
import { Onboarding } from './screens/Onboarding';
import { Work } from './screens/Work';
import { DocumentEditor } from './screens/DocumentEditor';
import { Jobs, JobDetail } from './screens/Jobs';
import { Purchases } from './screens/Purchases';
import { SearchOverlay } from './screens/Search';
import { DocumentReview } from './screens/DocumentReview';
import { Customers, CustomerDetail } from './screens/Customers';
import { Bank, CategorizeTransaction } from './screens/Bank';
import { Tax } from './screens/Tax';
import { Overview } from './screens/Overview';
import { SettingsScreen } from './screens/Settings';
import { TemplateEditor } from './screens/TemplateEditor';
import { Expert } from './screens/Expert';
import { TermsGate } from './screens/Terms';
import { TERMS_VERSION } from '../shared/legal';
import { hasOnboardingUpdate } from '../shared/onboarding';
import { DemoBanner } from './screens/Reset';

const NAV: { screen: Screen; label: string; icon: string; also?: Screen[] }[] = [
  { screen: 'home', label: 'Vandaag', icon: '🏠' },
  { screen: 'werk', label: 'Werk & facturen', icon: '💰', also: ['factuur', 'offerte'] },
  { screen: 'klussen', label: 'Klussen', icon: '🔨', also: ['klus'] },
  { screen: 'aankopen', label: 'Aankopen & bonnetjes', icon: '🧾', also: ['document'] },
  { screen: 'klanten', label: 'Klanten', icon: '👤', also: ['klant'] },
  { screen: 'bank', label: 'Bank', icon: '🏦', also: ['categorie'] },
  { screen: 'belasting', label: 'Belasting', icon: '📮' },
  { screen: 'overzicht', label: 'Hoe gaat het?', icon: '📈' },
];

export function App() {
  const [history, setHistory] = useState<Route[]>([{ screen: 'home' }]);
  const [searching, setSearching] = useState(false);
  // Ctrl+K / Cmd+K opent de zoekbalk (#26)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setSearching(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const [toasts, setToasts] = useState<{ id: number; message: string; kind: 'info' | 'error' }[]>([]);
  const [meta, setMeta] = useState<Meta>();
  const [settings, setSettings] = useState<Settings>();
  const [badge, setBadge] = useState(0);
  const route = history[history.length - 1]!;

  const toast = useCallback((message: string, kind: 'info' | 'error' = 'info') => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, message, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 7000 : 3500);
  }, []);
  const reloadSettings = useCallback(async () => setSettings(await api.settings.get()), []);
  const refreshBadge = useCallback(() => {
    api.home.get().then((h) => setBadge(h.tasks.length)).catch(() => undefined);
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        setMeta(await api.app.meta());
        const s = await api.settings.get();
        setSettings(s);
        // nieuwe gebruiker, of een update met nieuwe onboardingstappen: die eerst
        if (!s.onboardingDone || hasOnboardingUpdate(s)) setHistory([{ screen: 'welkom' }]);
      } catch (e) {
        toast((e as Error).message, 'error');
      }
    })();
    refreshBadge();
    return window.bridge.onEvent((event, payload) => {
      if (event === 'reminders') toast(`${(payload as { sent: number }).sent} betalingsherinnering(en) verstuurd`);
      if (event === 'auto-processed') refreshBadge();
      if (event === 'reminders-failed') toast('Een of meer herinneringen konden niet verstuurd worden', 'error');
    });
  }, [toast, refreshBadge]);

  useEffect(refreshBadge, [route, refreshBadge]);

  if (!meta || !settings) return <div className="main">Laden…</div>;

  const go = (r: Route) => setHistory((h) => (r.screen === 'home' ? [r] : [...h.slice(-20), r]));
  const back = () => setHistory((h) => (h.length > 1 ? h.slice(0, -1) : h));
  const ctx = { route, go, back, toast, meta, settings, reloadSettings, refreshBadge };

  const screen = (() => {
    switch (route.screen) {
      case 'home': return <Home />;
      case 'welkom': return <Onboarding />;
      case 'werk': return <Work />;
      case 'factuur': return <DocumentEditor kind="factuur" id={route.id as number | undefined} key={`f${route.id ?? 'new'}`} />;
      case 'offerte': return <DocumentEditor kind="offerte" id={route.id as number | undefined} key={`o${route.id ?? 'new'}`} />;
      case 'klussen': return <Jobs />;
      case 'klus': return <JobDetail id={route.id as number} key={String(route.id)} />;
      case 'aankopen': return <Purchases pay={route.id as number | undefined} key={`p${route.id ?? ''}`} />;
      case 'document': return <DocumentReview id={route.id as number} key={String(route.id)} />;
      case 'categorie': return <CategorizeTransaction id={route.id as number} key={String(route.id)} />;
      case 'klanten': return <Customers />;
      case 'klant': return <CustomerDetail id={route.id as number | undefined} key={String(route.id ?? 'new')} />;
      case 'bank': return <Bank focus={route.id as number | undefined} />;
      case 'belasting': return <Tax periodKey={route.id as string | undefined} key={String(route.id ?? '')} />;
      case 'overzicht': return <Overview />;
      case 'instellingen': return <SettingsScreen />;
      case 'opmaak': return <TemplateEditor />;
      case 'expert': return <Expert />;
    }
  })();

  const isActive = (n: (typeof NAV)[number]) => route.screen === n.screen || n.also?.includes(route.screen);

  return (
    <Ctx.Provider value={ctx}>
      <div className="app">
        {route.screen !== 'welkom' && (
          <nav className="nav" aria-label="Hoofdmenu">
            <div className="brand">Gratis Boekhouden</div>
            <button className="search-btn" onClick={() => setSearching(true)} title="Zoeken (Ctrl+K)"><span>🔍</span>Zoeken<kbd>Ctrl K</kbd></button>
            {NAV.map((n) => (
              <button key={n.screen} className={isActive(n) ? 'active' : ''} onClick={() => go({ screen: n.screen })}>
                <span>{n.icon}</span>
                {n.label}
                {n.screen === 'home' && badge > 0 && <span className="badge">{badge}</span>}
              </button>
            ))}
            {settings.advancedMode && (
              <>
                <div className="section">Voor de boekhouder</div>
                <button className={route.screen === 'expert' ? 'active' : ''} onClick={() => go({ screen: 'expert' })}>
                  <span>📚</span>Boekhouding
                </button>
              </>
            )}
            <div className="spacer" />
            <button className={route.screen === 'instellingen' || route.screen === 'opmaak' ? 'active' : ''} onClick={() => go({ screen: 'instellingen' })}>
              <span>⚙️</span>Instellingen
            </button>
          </nav>
        )}
        <main className="main" style={route.screen === 'welkom' ? { gridColumn: '1 / -1' } : undefined}>
          {settings.demoMode && route.screen !== 'welkom' && <DemoBanner />}
          {screen}
        </main>
      </div>
      {searching && <SearchOverlay onClose={() => setSearching(false)} />}
      {settings.onboardingDone && settings.termsAcceptedVersion !== TERMS_VERSION && route.screen !== 'welkom' && <TermsGate onAccepted={() => void reloadSettings()} />}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind === 'error' ? 'error' : ''}`}>
            {t.message}
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}
