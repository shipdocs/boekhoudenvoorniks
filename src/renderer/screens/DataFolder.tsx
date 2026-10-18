import { useState } from 'react';
import { api } from '../api';
import { Button, ErrorBox, Modal, useAction, useLoad } from '../ui';

type Plan = NonNullable<Awaited<ReturnType<typeof api.dataFolder.choose>>>;

function describe(existing: NonNullable<Plan['existing']>): string {
  const when = new Date(existing.lastModified).toLocaleString('nl-NL', { dateStyle: 'long', timeStyle: 'short' });
  const count = existing.administrationCount === 1 ? '1 administratie' : `${existing.administrationCount} administraties`;
  return `laatst gewijzigd ${when} · ${Math.max(1, Math.round(existing.size / 1e6))} MB · ${count}`;
}

/**
 * Waar de gegevens staan, en een andere map kiezen. De app beoordeelt de gekozen map (leeg, of er staat
 * al een complete administratie) en wisselt pas na een herstart; de huidige map wordt nooit gewist.
 */
export function DataFolderSettings() {
  const info = useLoad(() => api.dataFolder.info());
  const { run, busy } = useAction();
  const [plan, setPlan] = useState<Plan | null>(null);
  const [understood, setUnderstood] = useState(false);
  const [restarting, setRestarting] = useState(false);
  if (info.error) return <ErrorBox error={info.error} />;
  // met een eigen map uit de omgeving (tests) valt er niets te kiezen
  if (!info.data) return null;
  const { dir, standard, isStandard } = info.data;

  const show = (chosen: Plan | null | undefined) => {
    if (!chosen) return;
    setUnderstood(false);
    setPlan(chosen);
  };
  const choose = async () => show(await run(() => api.dataFolder.choose()));
  const apply = async () => {
    setRestarting(true);
    // de app sluit en start opnieuw; komt er toch een antwoord, dan ging er iets mis
    if ((await run(async () => { await api.dataFolder.apply(); return true; })) === undefined) setRestarting(false);
  };

  return (
    <div className="card grid" style={{ marginTop: 14 }}>
      <h3 style={{ margin: 0 }}>Waar je gegevens staan</h3>
      <p className="small muted" style={{ margin: 0 }}>
        Al je administraties, bijlagen en back-ups staan in één map op deze computer{isStandard ? ' (de standaardmap)' : ''}:
      </p>
      <p style={{ margin: 0 }}><code>{dir}</code></p>
      <p className="small muted" style={{ margin: 0 }}>
        Wil je ze ergens anders hebben, bijvoorbeeld op een andere schijf? Kies dan een lege map; de app kopieert je gegevens erheen en controleert de kopie. De map die je nu gebruikt blijft staan, er wordt niets gewist.
        Kies liever geen map van OneDrive, Dropbox, iCloud of Google Drive: zo'n dienst kopieert bestanden terwijl de app ermee werkt, en daar kan je administratie van beschadigen. Zet daar wel gerust een kopie van je back-up neer.
      </p>
      <div className="row">
        <Button disabled={busy} onClick={() => void choose()}>Gegevensmap wijzigen…</Button>
        {!isStandard && <Button disabled={busy} onClick={async () => show(await run(() => api.dataFolder.chooseStandard()))}>Terug naar de standaardmap</Button>}
      </div>
      {!isStandard && <p className="small muted" style={{ margin: 0 }}>Dit is niet de standaardmap; die is <code>{standard}</code>. Laat die map staan: de app bewaart daar de sleutel van je opgeslagen wachtwoorden.</p>}

      {plan && (
        <Modal title="Gegevensmap wijzigen" onClose={() => !restarting && setPlan(null)}>
          <p style={{ marginTop: 0 }}><code>{plan.dir}</code></p>
          {restarting ? (
            <p role="status">De app start opnieuw…</p>
          ) : plan.problem ? (
            <>
              <div className="notice bad" role="alert">{plan.problem}</div>
              <p className="small muted">Er is niets veranderd: je werkt verder vanuit <code>{dir}</code>.</p>
              <div className="row end" style={{ marginTop: 14 }}>
                <Button onClick={() => setPlan(null)}>Sluiten</Button>
                {!plan.standard && <Button kind="primary" disabled={busy} onClick={() => void choose()}>Andere map kiezen…</Button>}
              </div>
            </>
          ) : (
            <>
              {plan.action === 'kopieren' ? (
                <>
                  <p>
                    De app start opnieuw en kopieert je administraties, bijlagen en back-ups naar deze map. De kopie wordt gecontroleerd voordat de app hem gebruikt.
                    Lukt het kopiëren niet, of druk je op Stoppen, dan verandert er niets.
                  </p>
                  <p>De map <code>{dir}</code> blijft staan; er wordt niets gewist.</p>
                  {plan.existing && <p>In de standaardmap staat nog een oudere administratie ({describe(plan.existing)}). Die wordt niet gewist, maar bewaard in een aparte map in de standaardmap.</p>}
                </>
              ) : (
                <>
                  <p>In deze map staat al een administratie ({describe(plan.existing!)}). De app start opnieuw en opent die.</p>
                  <p><strong>Je huidige gegevens gaan niet mee.</strong> Ze blijven staan in <code>{dir}</code>; er wordt niets gewist.</p>
                </>
              )}
              {plan.sync && (
                <div className="notice warn" role="alert">
                  <strong>Let op: deze map wordt bijgehouden door {plan.sync}.</strong> Zo'n dienst kopieert bestanden terwijl de app ermee werkt, en daar kan je administratie van beschadigen. Kies liever een map die niet wordt gesynchroniseerd.
                  <label className="row" style={{ marginTop: 8 }}>
                    <input type="checkbox" checked={understood} onChange={(e) => setUnderstood(e.target.checked)} /> Ik ken het risico en wil deze map toch gebruiken
                  </label>
                </div>
              )}
              <div className="row end" style={{ marginTop: 14 }}>
                <Button onClick={() => setPlan(null)}>Annuleren</Button>
                {plan.sync && !plan.standard && <Button disabled={busy} onClick={() => void choose()}>Andere map kiezen…</Button>}
                <Button kind="primary" disabled={busy || (!!plan.sync && !understood)} onClick={() => void apply()}>
                  {plan.action === 'kopieren' ? 'Kopiëren en opnieuw starten' : 'Deze administratie openen'}
                </Button>
              </div>
            </>
          )}
        </Modal>
      )}
    </div>
  );
}
