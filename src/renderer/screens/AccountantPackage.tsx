import { useState } from 'react';
import { api } from '../api';
import { Button, ErrorBox, Euro, useAction, useLoad } from '../ui';

/**
 * "Pakket voor mijn boekhouder": één ZIP per boekjaar die de boekhouder in zijn eigen pakket
 * inleest (auditfile, kolommenbalans, grootboekkaarten, openstaande posten, RGS-brugstaat,
 * facturen en bonnen). Eerst de controles, zodat je ziet wat er nog ontbreekt.
 */
export function AccountantPackageCard({ defaultYear }: { defaultYear?: number }) {
  const thisYear = new Date().getFullYear();
  const [year, setYear] = useState(defaultYear ?? (new Date().getMonth() < 6 ? thisYear - 1 : thisYear));
  const preview = useLoad(() => api.exports.accountantPackagePreview(year), [year]);
  const { run, busy } = useAction();
  const [saved, setSaved] = useState<string | null>(null);
  const p = preview.data;
  const problems = p?.checks.filter((c) => !c.ok) ?? [];
  return (
    <div className="card grid" data-testid="boekhouder-pakket">
      <div className="row between" style={{ alignItems: 'center' }}>
        <h2 style={{ margin: 0 }}>📦 Pakket voor je boekhouder</h2>
        <select value={year} onChange={(e) => { setYear(Number(e.target.value)); setSaved(null); }} aria-label="Boekjaar">
          {[0, 1, 2, 3].map((i) => thisYear - i).map((y) => <option key={y} value={y}>{y}</option>)}
        </select>
      </div>
      <p style={{ margin: 0 }}>
        Eén bestand met alles voor je boekhouder, in formaten die zijn eigen programma inleest (Caseware, AFAS, Visionplanner, Exact, Twinfield, Yuki, SnelStart):
        de auditfile, kolommenbalans, grootboekkaarten, openstaande posten, de koppeling met RGS en al je facturen en bonnen.
      </p>
      <ErrorBox error={preview.error} />
      {p && (
        <>
          <div className="small">
            {p.counts.entries} boekingen · {p.counts.invoices} verkoopfacturen · {p.counts.purchases} inkopen · resultaat <Euro cents={p.totals.result} />
          </div>
          <ul className="checklist small" style={{ margin: 0 }}>
            {p.checks.map((c) => (
              <li key={c.label} className={c.ok ? 'ok' : ''}>
                {!c.ok && <span className="pill warn" style={{ marginRight: 6 }}>let op</span>}
                {c.label}
                {!c.ok && c.detail && <div className="muted">{c.detail}</div>}
              </li>
            ))}
          </ul>
          {problems.length > 0 && <p className="small muted" style={{ margin: 0 }}>Je kunt het pakket toch maken; wat ontbreekt staat ook in de lees-mij, zodat je boekhouder weet waar hij op moet letten.</p>}
        </>
      )}
      <div className="row" style={{ alignItems: 'center' }}>
        <Button kind="primary" disabled={busy || !p} onClick={async () => {
          const r = await run(() => api.exports.accountantPackage(year));
          if (r?.path) setSaved(r.path);
        }}>{busy ? 'Pakket maken…' : `Pakket ${year} maken (ZIP)`}</Button>
        {saved && <span className="small">✓ Opgeslagen: {saved}</span>}
      </div>
      <p className="small muted" style={{ margin: 0 }}>
        Dit is een overdracht, geen back-up: instellingen en koppelingen gaan niet mee. Voor een back-up gebruik je Instellingen → Back-up, demo &amp; updates.
      </p>
    </div>
  );
}
