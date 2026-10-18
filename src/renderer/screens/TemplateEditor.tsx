import { useEffect, useState } from 'react';
import { api } from '../api';
import { Button, ErrorBox, Field, useAction, useApp, useLoad } from '../ui';
import type { DocumentTemplate } from '../../documents/templates';
import { DEFAULT_HTML_TEMPLATE } from '../../documents/default-template';

/** Opmaak-editor: logo, kleuren, lettertype en vaste tekstblokken, met live voorbeeld. */
export function TemplateEditor() {
  const { meta, settings, go } = useApp();
  const { run, busy } = useAction();
  const list = useLoad(() => api.templates.list());
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [t, setT] = useState<DocumentTemplate | null>(null);
  const [html, setHtml] = useState('');

  useEffect(() => {
    if (!list.data?.length) return;
    const pick = list.data.find((x) => x.id === selectedId) ?? list.data[0]!;
    setSelectedId(pick.id);
    setT(pick);
  }, [list.data, selectedId]);

  useEffect(() => {
    if (!t) return;
    const handle = setTimeout(() => {
      api.templates.preview(t).then(setHtml).catch((e: Error) => setHtml(`<p style="font-family:sans-serif;color:#b3261e">${e.message.replace(/</g, '&lt;')}</p>`));
    }, 250);
    return () => clearTimeout(handle);
  }, [t]);

  if (!t) return <div className="page"><ErrorBox error={list.error} /></div>;
  const set = (patch: Partial<DocumentTemplate>) => setT({ ...t, ...patch });

  const uploadLogo = (file: File) => {
    if (file.size > 1_000_000) return alert('Logo is te groot (max 1 MB)');
    const reader = new FileReader();
    reader.onload = () => set({ logo: String(reader.result) });
    reader.readAsDataURL(file);
  };

  return (
    <div className="page" style={{ maxWidth: 1300 }}>
      <div className="row between">
        <div>
          <h1>Opmaak</h1>
          <p className="sub">Zo zien je facturen en offertes eruit.</p>
        </div>
        <Button kind="ghost" onClick={() => go({ screen: 'instellingen', extra: { tab: 'facturen' } })}>← Instellingen</Button>
      </div>
      <div className="split">
        <div className="grid">
          <div className="row">
            <select value={selectedId ?? ''} onChange={(e) => setSelectedId(Number(e.target.value))}>
              {(list.data ?? []).map((x) => <option key={x.id} value={x.id}>{x.name} ({x.type}){x.is_default ? ' ★' : ''}</option>)}
            </select>
            <Button small onClick={async () => { const c = await run(() => api.templates.create({ ...t, name: `${t.name} (kopie)`, is_default: 0 })); if (c) { await list.reload(); setSelectedId(c.id); } }}>Kopie maken</Button>
          </div>
          <div className="card grid">
            <Field label="Naam"><input value={t.name} onChange={(e) => set({ name: e.target.value })} /></Field>
            <Field label="Logo">
              <div className="row">
                {t.logo && <img src={t.logo} alt="" style={{ maxHeight: 48, maxWidth: 160 }} />}
                <input type="file" accept="image/png,image/jpeg,image/svg+xml,image/webp" onChange={(e) => e.target.files?.[0] && uploadLogo(e.target.files[0])} />
                {t.logo && <Button small kind="ghost" onClick={() => set({ logo: null })}>Verwijderen</Button>}
              </div>
            </Field>
            <div className="grid cols-2">
              <Field label="Hoofdkleur"><input type="color" value={t.colors.primary} onChange={(e) => set({ colors: { ...t.colors, primary: e.target.value } })} /></Field>
              <Field label="Kleur van vlakken"><input type="color" value={t.colors.accentBg} onChange={(e) => set({ colors: { ...t.colors, accentBg: e.target.value } })} /></Field>
              <Field label="Tekstkleur"><input type="color" value={t.colors.text} onChange={(e) => set({ colors: { ...t.colors, text: e.target.value } })} /></Field>
              <Field label="Lettertype">
                <select value={t.font} onChange={(e) => set({ font: e.target.value })}>
                  {meta.fonts.map((f) => <option key={f} value={f}>{f.split(',')[0]!.replace(/"/g, '')}</option>)}
                </select>
              </Field>
            </div>
            <h3>Vaste teksten</h3>
            {t.text_blocks.map((b, i) => (
              <div key={i} className="grid" style={{ gap: 6 }}>
                <div className="row">
                  <input className="grow" value={b.title} placeholder="Kop, bv. Betaalinformatie" onChange={(e) => set({ text_blocks: t.text_blocks.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)) })} />
                  <Button small kind="ghost" onClick={() => set({ text_blocks: t.text_blocks.filter((_, j) => j !== i) })}>✕</Button>
                </div>
                <textarea value={b.text} onChange={(e) => set({ text_blocks: t.text_blocks.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)) })} />
              </div>
            ))}
            <div><Button small onClick={() => set({ text_blocks: [...t.text_blocks, { title: '', text: '' }] })}>+ Tekstblok</Button></div>
            {settings.advancedMode && (
              <details>
                <summary>Eigen HTML-template (geavanceerd)</summary>
                <p className="small muted">Mustache-achtige velden: {'{{doc.number}}'}, {'{{#lines}}…{{/lines}}'}, {'{{totals.total}}'}. Leeg = standaard layout.</p>
                <textarea rows={14} style={{ fontFamily: 'monospace', fontSize: 12, width: '100%' }} value={t.html_template ?? ''} placeholder={DEFAULT_HTML_TEMPLATE.slice(0, 300) + '…'} onChange={(e) => set({ html_template: e.target.value || null })} />
              </details>
            )}
          </div>
          <div className="row">
            {!t.is_default && <Button kind="danger" disabled={busy} onClick={async () => { if (confirm('Deze opmaak verwijderen?')) { await run(() => api.templates.delete(t.id)); setSelectedId(null); await list.reload(); } }}>Verwijderen</Button>}
            {!t.is_default && <Button disabled={busy} onClick={async () => { await run(() => api.templates.setDefault(t.id), 'Standaard ingesteld'); await list.reload(); }}>Als standaard gebruiken</Button>}
            <span className="grow" />
            <Button kind="primary" disabled={busy} onClick={async () => { await run(() => api.templates.update(t.id, t), 'Opmaak opgeslagen'); await list.reload(); }}>Opslaan</Button>
          </div>
        </div>
        <iframe className="preview-frame" sandbox="" srcDoc={html} title="Voorbeeld" />
      </div>
    </div>
  );
}
