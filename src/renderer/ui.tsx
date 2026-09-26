import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { formatEuro, parseEuro } from '../shared/money';
import { formatDateNl } from '../shared/dates';
import { createPortal } from 'react-dom';
import { api } from './api';

// ---------- navigatie ----------

export type Screen =
  | 'home' | 'welkom' | 'werk' | 'factuur' | 'offerte' | 'klussen' | 'klus' | 'aankopen' | 'document' | 'categorie'
  | 'klanten' | 'klant' | 'bank' | 'belasting' | 'aangifte' | 'overzicht' | 'instellingen' | 'opmaak' | 'expert';

export interface Route {
  screen: Screen;
  id?: number | string;
  extra?: Record<string, unknown>;
}

interface AppCtx {
  route: Route;
  go(route: Route): void;
  back(): void;
  toast(message: string, kind?: 'info' | 'error'): void;
  meta: Meta;
  settings: Settings;
  reloadSettings(): Promise<void>;
  /** na het aanpassen van categorieën */
  reloadMeta(): Promise<void>;
  refreshBadge(): void;
  /** Na het opslaan van een investering: uitleg wat de app nu doet en wat jij nog moet doen. */
  showInvestmentSaved(info: InvestmentSavedInfo): void;
}

export interface InvestmentSavedInfo {
  /** bedrag excl. btw */
  net: number;
  /** btw die je terugkrijgt (0 als onbekend of niet van toepassing) */
  vat: number;
  /** is de bon/factuur al in de app bewaard? */
  hasAttachment?: boolean;
}

export type Meta = Awaited<ReturnType<typeof api.app.meta>>;
export type Settings = Awaited<ReturnType<typeof api.settings.get>>;

export const Ctx = createContext<AppCtx>(null as unknown as AppCtx);
export const useApp = () => useContext(Ctx);

// ---------- data laden ----------

/** Laadt data via de API, met herlaadfunctie en foutmelding. */
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[] = []): { data: T | undefined; error: string | null; reload: () => Promise<void>; loading: boolean } {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setData(await fnRef.current());
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return { data, error, reload, loading };
}

/** Voert een actie uit met toast bij fout; retourneert het resultaat of undefined. */
export function useAction() {
  const { toast } = useApp();
  const [busy, setBusy] = useState(false);
  const run = useCallback(
    async <T,>(fn: () => Promise<T>, success?: string): Promise<T | undefined> => {
      setBusy(true);
      try {
        const r = await fn();
        if (success) toast(success);
        return r;
      } catch (e) {
        toast((e as Error).message, 'error');
        return undefined;
      } finally {
        setBusy(false);
      }
    },
    [toast],
  );
  return { run, busy };
}

// ---------- weergave ----------

export const Euro = ({ cents, sign = false }: { cents: number | null | undefined; sign?: boolean }) => (
  <span className="num">{cents == null ? '—' : `${sign && cents > 0 ? '+' : ''}${formatEuro(cents)}`}</span>
);

export const DateNl = ({ date }: { date: string | null | undefined }) => <>{date ? formatDateNl(date) : '—'}</>;

export function Button(props: { children: ReactNode; onClick?: () => void; kind?: 'primary' | 'danger' | 'ghost'; small?: boolean; disabled?: boolean; type?: 'button' | 'submit'; title?: string }) {
  return (
    <button type={props.type ?? 'button'} title={props.title} className={`btn ${props.kind ?? ''} ${props.small ? 'small' : ''}`} onClick={props.onClick} disabled={props.disabled}>
      {props.children}
    </button>
  );
}

export function Field(props: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="field">
      <span>
        {props.label} {props.hint && <span className="hint">— {props.hint}</span>}
      </span>
      {props.children}
    </label>
  );
}

/** Invoer voor bedragen in euro's (NL-notatie), waarde in centen. */
export function MoneyInput({ value, onChange, placeholder, autoFocus }: { value: number | null; onChange: (cents: number | null) => void; placeholder?: string; autoFocus?: boolean }) {
  const [text, setText] = useState(value == null ? '' : (value / 100).toFixed(2).replace('.', ','));
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused) setText(value == null ? '' : (value / 100).toFixed(2).replace('.', ','));
  }, [value, focused]);
  return (
    <input
      className="num"
      inputMode="decimal"
      autoFocus={autoFocus}
      placeholder={placeholder ?? '0,00'}
      value={text}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onChange={(e) => {
        setText(e.target.value);
        try {
          onChange(e.target.value.trim() ? parseEuro(e.target.value) : null);
        } catch {
          onChange(null);
        }
      }}
    />
  );
}

export function Modal({ title, children, onClose, wide }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  // via een portal: een venster binnen een formulierveld (label) of kaart erft dan geen opmaak of klikgedrag
  return createPortal(
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-label={title}>
        <div className="row between" style={{ marginBottom: 14 }}>
          <h2 style={{ margin: 0 }}>{title}</h2>
          <Button kind="ghost" onClick={onClose} title="Sluiten">✕</Button>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  );
}

export function Empty({ icon, title, children }: { icon: string; title: string; children?: ReactNode }) {
  return (
    <div className="card done-box">
      <div style={{ fontSize: 36 }}>{icon}</div>
      <h3>{title}</h3>
      <div className="muted">{children}</div>
    </div>
  );
}

export function ErrorBox({ error }: { error: string | null }) {
  return error ? <div className="notice bad">{error}</div> : null;
}

/** Leest een bestand (drag & drop of kiezen) als tekst of bytes. */
export function DropZone({ accept, onFile, children, multiple }: { accept: string; onFile: (file: File) => void; children: ReactNode; multiple?: boolean }) {
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  return (
    <div
      className={`dropzone ${over ? 'over' : ''}`}
      onClick={() => input.current?.click()}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        for (const f of Array.from(e.dataTransfer.files)) onFile(f);
      }}
    >
      <input
        ref={input}
        type="file"
        accept={accept}
        multiple={multiple}
        hidden
        onChange={(e) => {
          for (const f of Array.from(e.target.files ?? [])) onFile(f);
          e.target.value = '';
        }}
      />
      {children}
    </div>
  );
}

export const STATUS_LABEL: Record<string, [string, string]> = {
  concept: ['Nog niet verstuurd', ''],
  openstaand: ['Wacht op betaling', 'info'],
  vervallen: ['Te laat', 'bad'],
  betaald: ['Betaald', 'good'],
  verzonden: ['Verstuurd', 'info'],
  geaccepteerd: ['Akkoord', 'good'],
  afgewezen: ['Afgewezen', ''],
  gefactureerd: ['Gefactureerd', 'good'],
  gepland: ['Gepland', ''],
  bezig: ['Bezig', 'info'],
  klaar: ['Klaar, nog factureren', 'warn'],
  geannuleerd: ['Geannuleerd', ''],
  nieuw: ['Nog verwerken', 'warn'],
  gematcht: ['Verwerkt', 'good'],
  genegeerd: ['Genegeerd', ''],
  open: ['Nog betalen', 'warn'],
  controle: ['Even controleren', 'warn'],
  verwerkt: ['Verwerkt', 'good'],
};

export const StatusPill = ({ status }: { status: string }) => {
  const [label, kind] = STATUS_LABEL[status] ?? [status, ''];
  return <span className={`pill ${kind}`}>{label}</span>;
};

export function readAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const buf = new Uint8Array(r.result as ArrayBuffer);
      // UTF-8 proberen; valt terug op Windows-1252 (veel bank-CSV's)
      try {
        resolve(new TextDecoder('utf-8', { fatal: true }).decode(buf));
      } catch {
        resolve(new TextDecoder('windows-1252').decode(buf));
      }
    };
    r.onerror = () => reject(r.error);
    r.readAsArrayBuffer(file);
  });
}

export async function readAsBytes(file: File): Promise<Uint8Array> {
  return new Uint8Array(await file.arrayBuffer());
}
