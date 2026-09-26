import { useState } from 'react';
import { api } from '../api';
import { Button, ErrorBox, Field, Modal, useAction, useApp, useLoad } from '../ui';
import type { PurchaseVatCode } from '../../shared/vat';

type CategoryView = Awaited<ReturnType<typeof api.categories.all>>['categories'][number];

/**
 * De keuzeknoppen "Waar was dit voor?", met aan het eind "+ Eigen categorie" en "Aanpassen".
 * Een nieuwe categorie wordt meteen gekozen.
 */
export function CategoryChips({ value, onChange }: { value: string; onChange: (key: string, defaultVat: PurchaseVatCode) => void }) {
  const { meta } = useApp();
  const [dialog, setDialog] = useState<'nieuw' | 'beheer' | null>(null);
  return (
    <>
      <div className="chips">
        {meta.expenseCategories.map((c) => (
          <button key={c.key} className={value === c.key ? 'selected' : ''} title={c.hint} onClick={() => onChange(c.key, c.defaultVat)}>{c.label}</button>
        ))}
        <button className="ghost" title="Een categorie die er nog niet bij staat" onClick={() => setDialog('nieuw')}>+ Eigen categorie</button>
        <button className="ghost" title="Namen, uitleg en btw aanpassen, of categorieën verbergen" onClick={() => setDialog('beheer')}>✎ Aanpassen</button>
      </div>
      {dialog === 'nieuw' && (
        <Modal title="Eigen categorie" onClose={() => setDialog(null)}>
          <CategoryForm category={null} onDone={(c) => { setDialog(null); if (c) onChange(c.key, c.defaultVat); }} />
        </Modal>
      )}
      {dialog === 'beheer' && <CategoriesDialog onClose={() => setDialog(null)} />}
    </>
  );
}

/** Alle categorieën: aanpassen, verbergen of terug naar de standaard. Verwijderen kan niet. */
export function CategoriesDialog({ onClose }: { onClose: () => void }) {
  const { reloadMeta } = useApp();
  const { run, busy } = useAction();
  const data = useLoad(() => api.categories.all());
  const [editing, setEditing] = useState<CategoryView | 'nieuw' | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const refresh = async () => {
    await data.reload();
    await reloadMeta();
  };
  const act = async (fn: () => Promise<unknown>, done: string) => {
    if ((await run(async () => { await fn(); return true; }, done)) !== undefined) await refresh();
  };
  const list = (data.data?.categories ?? []).filter((c) => showHidden || !c.hidden);
  const hiddenCount = (data.data?.categories ?? []).filter((c) => c.hidden).length;
  const groupLabel = (key: string | null) => data.data?.groups.find((g) => g.key === key)?.label ?? '';

  if (editing) {
    return (
      <Modal title={editing === 'nieuw' ? 'Eigen categorie' : `${editing.label} aanpassen`} onClose={() => setEditing(null)}>
        <CategoryForm category={editing === 'nieuw' ? null : editing} onDone={async (c) => { setEditing(null); if (c) await refresh(); }} />
      </Modal>
    );
  }
  return (
    <Modal title="Categorieën" onClose={onClose} wide>
      <p className="small muted">
        Pas namen, uitleg en btw aan zoals het voor jou klopt, of voeg een eigen categorie toe. Wat je al hebt geboekt verandert nooit mee: dat staat
        al op de juiste plek in de boekhouding. Een categorie die je niet gebruikt, kun je verbergen.
      </p>
      <ErrorBox error={data.error} />
      <table className="list">
        <thead>
          <tr><th>Categorie</th><th>Btw meestal</th><th /></tr>
        </thead>
        <tbody>
          {list.map((c) => (
            <tr key={c.key} className={c.hidden ? 'muted' : ''}>
              <td>
                <strong>{c.label}</strong>
                {!c.builtIn && <span className="pill" style={{ marginLeft: 6 }}>eigen</span>}
                {c.changed && <span className="pill" style={{ marginLeft: 6 }}>aangepast</span>}
                {c.hidden && <span className="pill" style={{ marginLeft: 6 }}>verborgen</span>}
                {c.hint && <div className="small muted">{c.hint}</div>}
                {!c.builtIn && <div className="small muted">Voor de boekhouder: hoort bij {groupLabel(c.groupKey).toLowerCase()}</div>}
              </td>
              <td className="small">{shortVat(c.defaultVat)}</td>
              <td><div className="row end" style={{ gap: 6, flexWrap: 'nowrap' }}>
                <Button small disabled={busy} onClick={() => setEditing(c)}>Aanpassen</Button>
                {c.key !== 'overig' && (
                  <Button small kind="ghost" disabled={busy} onClick={() => void act(() => api.categories.setHidden(c.key, !c.hidden), c.hidden ? 'Weer zichtbaar' : 'Verborgen')}>
                    {c.hidden ? 'Tonen' : 'Verbergen'}
                  </Button>
                )}
                {c.builtIn && c.changed && (
                  <Button small kind="ghost" disabled={busy} title="Terug naar de oorspronkelijke naam, uitleg en btw" onClick={() => void act(() => api.categories.reset(c.key), 'Terug naar standaard')}>Standaard</Button>
                )}
              </div></td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="row" style={{ marginTop: 12, justifyContent: 'space-between' }}>
        {hiddenCount > 0 ? (
          <label className="row small"><input type="checkbox" checked={showHidden} onChange={(e) => setShowHidden(e.target.checked)} /> Toon verborgen ({hiddenCount})</label>
        ) : <span />}
        <div className="row" style={{ gap: 8 }}>
          <Button onClick={onClose}>Sluiten</Button>
          <Button kind="primary" onClick={() => setEditing('nieuw')}>+ Eigen categorie</Button>
        </div>
      </div>
    </Modal>
  );
}

function shortVat(code: string): string {
  return ({ hoog: '21%', laag: '9%', nul: '0%', geen: 'geen btw', verlegd: 'verlegd', eu: 'EU-leverancier', 'buiten-eu': 'buiten de EU' } as Record<string, string>)[code] ?? code;
}

/** Nieuwe of bestaande categorie. Bij een vaste categorie blijft de grootboekrekening vast. */
function CategoryForm({ category, onDone }: { category: CategoryView | null; onDone: (c: CategoryView | null) => void | Promise<void> }) {
  const { meta, reloadMeta } = useApp();
  const { run, busy } = useAction();
  const groups = useLoad(() => api.categories.all().then((r) => r.groups));
  const [label, setLabel] = useState(category?.label ?? '');
  const [hint, setHint] = useState(category?.hint ?? '');
  const [groupKey, setGroupKey] = useState(category?.groupKey ?? 'overig');
  const [vat, setVat] = useState<string>(category?.defaultVat ?? meta.expenseCategories.find((c) => c.key === 'overig')?.defaultVat ?? 'hoog');
  const [vatTouched, setVatTouched] = useState(Boolean(category));
  const builtIn = category?.builtIn ?? false;

  const save = async () => {
    const saved = await run(
      () => (category
        ? api.categories.update(category.key, { label, hint, defaultVat: vat, ...(builtIn ? {} : { groupKey }) })
        : api.categories.add({ label, hint, groupKey, defaultVat: vat })),
      category ? 'Categorie opgeslagen' : 'Categorie toegevoegd',
    );
    if (saved) {
      await reloadMeta();
      await onDone(saved);
    }
  };

  return (
    // minmax: lange btw-omschrijvingen in de keuzelijst maken het venster niet breder
    <div className="grid" style={{ gridTemplateColumns: 'minmax(0, 1fr)' }}>
      <Field label="Naam" hint="zoals jij het noemt, bv. Vakliteratuur of Steigerhuur">
        <input value={label} maxLength={60} onChange={(e) => setLabel(e.target.value)} autoFocus />
      </Field>
      <Field label="Uitleg (mag leeg)" hint="verschijnt als je met de muis op de knop staat">
        <input value={hint} maxLength={200} onChange={(e) => setHint(e.target.value)} />
      </Field>
      {builtIn ? (
        <p className="small muted">Dit is een vaste categorie. De plek in de boekhouding blijft hetzelfde, zodat je boekhouder alles terugvindt.</p>
      ) : (
        <Field label="Hoort bij" hint="voor de boekhouding: op welke soort kosten dit geboekt wordt. Twijfel? Laat Overige kosten staan; je boekhouder kan het later nog verschuiven.">
          <select
            value={groupKey}
            onChange={(e) => {
              setGroupKey(e.target.value);
              // btw volgt de gekozen soort, tot je die zelf kiest
              if (!vatTouched) setVat(meta.expenseCategories.find((c) => c.key === e.target.value)?.defaultVat ?? vat);
            }}
          >
            {(groups.data ?? []).map((g) => <option key={g.key} value={g.key}>{g.label}</option>)}
          </select>
        </Field>
      )}
      <Field label="Btw die meestal op de bon staat" hint="dit wordt vooraf ingevuld; per bon kun je het altijd nog veranderen">
        <select value={vat} onChange={(e) => { setVat(e.target.value); setVatTouched(true); }}>
          {meta.purchaseVat.map((v) => <option key={v.code} value={v.code}>{v.label}</option>)}
        </select>
      </Field>
      {category && <p className="small muted">Een wijziging geldt voor wat je vanaf nu boekt. Eerdere boekingen blijven zoals ze zijn.</p>}
      <div className="row end" style={{ gap: 8 }}>
        <Button onClick={() => void onDone(null)}>Annuleren</Button>
        <Button kind="primary" disabled={busy || !label.trim()} onClick={() => void save()}>Opslaan</Button>
      </div>
    </div>
  );
}
