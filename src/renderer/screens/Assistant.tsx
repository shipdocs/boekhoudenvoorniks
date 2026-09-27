import { useState } from 'react';
import { api } from '../api';
import { Button, useAction, useApp, useLoad } from '../ui';

const quote = (s: string) => (/[\s"']/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s);

/**
 * Vragen stellen over je eigen boekhouding vanuit Claude Code of Codex. Voor wie die al heeft; de
 * assistent kan alleen lezen. Eerlijk uitgelegd: wat je vraagt gaat naar Anthropic of OpenAI.
 */
export function AssistantCard() {
  const { toast } = useApp();
  const { run, busy } = useAction();
  const info = useLoad(() => api.assistant.info());
  const [manual, setManual] = useState(false);
  const i = info.data;
  if (!i || !i.command) return null;
  const cmd = [i.command.command, ...i.command.args].map(quote).join(' ');
  const claudeLine = `claude mcp add --scope user gratis-boekhouden -- ${cmd}`;
  const codexLine = `codex mcp add gratis-boekhouden -- ${cmd}`;
  const codexToml = `[mcp_servers.gratis-boekhouden]\ncommand = ${JSON.stringify(i.command.command)}\nargs = ${JSON.stringify(i.command.args)}`;
  const copy = (text: string) => {
    void navigator.clipboard.writeText(text);
    toast('Gekopieerd');
  };
  const connect = async (kind: 'claude-code' | 'codex') => {
    const msg = await run(() => api.assistant.connect(kind));
    if (msg) toast(msg);
    else setManual(true);
  };
  const found = Boolean(i.claudeCode || i.codex);

  return (
    <div className="card" style={{ marginTop: 10 }}>
      <h3 style={{ marginTop: 0 }}>Vragen stellen over je boekhouding (Claude Code of Codex)</h3>
      <p className="small">
        Gebruik je Claude Code of Codex? Dan kun je daar in gewone taal vragen stellen over je eigen administratie, bijvoorbeeld:
      </p>
      <ul className="small">
        <li><em>"Waarom is mijn btw dit kwartaal zo hoog?"</em></li>
        <li><em>"Welke klanten hebben nog niet betaald?"</em></li>
        <li><em>"Welke betalingen moet ik nog indelen, en wat zijn het?"</em></li>
        <li><em>"Hoeveel heb ik dit jaar aan software uitgegeven?"</em></li>
      </ul>
      <p className="small muted">
        <strong>De assistent kan alleen lezen</strong>: niets boeken, wijzigen of versturen. Let op: je vraag en wat de assistent erbij opzoekt in
        je administratie gaan naar {i.claudeCode && !i.codex ? 'Anthropic' : i.codex && !i.claudeCode ? 'OpenAI' : 'Anthropic (Claude Code) of OpenAI (Codex)'}, alleen op het
        moment dat jij iets vraagt. Wat de assistent zegt over btw of belasting is uitleg, geen advies: laat het controleren door je boekhouder.
      </p>
      {found ? (
        <div className="row" style={{ gap: 8, marginTop: 10 }}>
          {i.claudeCode && <Button disabled={busy} onClick={() => void connect('claude-code')}>Toevoegen aan Claude Code</Button>}
          {i.codex && <Button disabled={busy} onClick={() => void connect('codex')}>Toevoegen aan Codex</Button>}
          <Button kind="ghost" small onClick={() => setManual(!manual)}>{manual ? 'Verberg' : 'Zelf instellen'}</Button>
        </div>
      ) : (
        <p className="small" style={{ marginTop: 10 }}>Nog niet gevonden: gebruik hierboven "Zoek op deze computer", of stel het zelf in met een opdracht in de terminal:</p>
      )}
      {found && <p className="small muted">Daarna: open een nieuwe terminal, start <code>claude</code> of <code>codex</code> en stel je vraag.</p>}
      {(manual || !found) && (
        <div className="small" style={{ marginTop: 8 }}>
          <p style={{ margin: '4px 0' }}>Claude Code, in een terminal:</p>
          <pre className="mono" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{claudeLine}</pre>
          <Button small onClick={() => copy(claudeLine)}>Kopieer</Button>
          <p style={{ margin: '10px 0 4px' }}>Codex, in een terminal (of zet het blok eronder in <code>~/.codex/config.toml</code>):</p>
          <pre className="mono" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{codexLine}</pre>
          <Button small onClick={() => copy(codexLine)}>Kopieer</Button>
          <pre className="mono" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all', marginTop: 8 }}>{codexToml}</pre>
          <Button small onClick={() => copy(codexToml)}>Kopieer</Button>
          <p className="muted">Stoppen? <code>claude mcp remove gratis-boekhouden</code> of <code>codex mcp remove gratis-boekhouden</code>.</p>
        </div>
      )}
    </div>
  );
}
