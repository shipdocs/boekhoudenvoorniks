import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import type { MailInSettings } from '../settings/settings';
import { MAIL_LIMITS, type MailMessage, type MailSource } from './mail-intake';

/** Foutmeldingen van de mailserver in gewone taal. */
export function friendlyImapError(e: unknown): Error {
  const err = e as { code?: string; authenticationFailed?: boolean; responseText?: string; message?: string };
  const msg = err?.message ?? String(e);
  if (err?.authenticationFailed || /AUTHENTICATIONFAILED|Invalid credentials|LOGIN failed|auth/i.test(`${msg} ${err?.responseText ?? ''}`))
    return new Error('Inloggen bij de mailbox lukt niet. Controleer je gebruikersnaam en wachtwoord (soms heb je een apart "app-wachtwoord" nodig).');
  if (/ENOTFOUND|getaddrinfo/i.test(msg)) return new Error('De mailserver is niet gevonden. Controleer de servernaam, bijvoorbeeld imap.jouwprovider.nl.');
  if (/wrong version number|tls|ssl/i.test(msg)) return new Error('De beveiliging past niet bij de poort. Meestal is het SSL/TLS met poort 993.');
  if (/ECONNREFUSED|ETIMEDOUT|timeout|ECONNRESET/i.test(msg)) return new Error('De mailserver reageert niet. Controleer de server en de poort, en of je internet hebt.');
  return new Error(`Mail ophalen lukt niet: ${msg}`);
}

function isoDate(d: Date | undefined): string {
  return (d && !Number.isNaN(d.getTime()) ? d : new Date()).toISOString().slice(0, 10);
}

/**
 * De echte mailbox via IMAP. Lezen gebeurt met BODY.PEEK (imapflow doet dat standaard), zodat
 * ongelezen mail ongelezen blijft. Er wordt nooit iets verwijderd.
 */
export class ImapSource implements MailSource {
  private lock: { release(): void } | null = null;

  private constructor(private readonly client: ImapFlow) {}

  static async connect(cfg: MailInSettings, password: string | null): Promise<ImapSource> {
    if (!cfg.host || !cfg.user) throw new Error('Vul eerst de mailserver en de gebruikersnaam in bij Instellingen → E-mail → Inkomende post.');
    if (!password) throw new Error('Het wachtwoord van je administratie-mailbox ontbreekt. Vul het in bij Instellingen → E-mail → Inkomende post.');
    const client = new ImapFlow({ host: cfg.host, port: cfg.port, secure: cfg.secure, auth: { user: cfg.user, pass: password }, logger: false, connectionTimeout: 20_000 });
    // een verbroken verbinding mag de app niet laten crashen
    client.on('error', () => undefined);
    try {
      await client.connect();
    } catch (e) {
      throw friendlyImapError(e);
    }
    return new ImapSource(client);
  }

  /** Alle mappen, om uit te kiezen in de instellingen. */
  async folders(): Promise<{ path: string; specialUse: string | null }[]> {
    return (await this.client.list()).map((f) => ({ path: f.path, specialUse: f.specialUse ?? null }));
  }

  async open(folder: string): Promise<{ uidValidity: string } | null> {
    this.lock?.release();
    this.lock = null;
    try {
      this.lock = await this.client.getMailboxLock(folder, { readOnly: false });
    } catch {
      return null;
    }
    const box = this.client.mailbox;
    return box ? { uidValidity: String(box.uidValidity) } : null;
  }

  async list(afterUid: number, since: string | null): Promise<number[]> {
    const query: Record<string, unknown> = { uid: `${afterUid + 1}:*` };
    if (since) query.since = new Date(`${since}T00:00:00`);
    const uids = (await this.client.search(query, { uid: true })) || [];
    // "n:*" geeft altijd het laatste bericht terug, ook als dat ≤ afterUid is
    return uids.filter((u) => u > afterUid).sort((a, b) => a - b);
  }

  async fetch(uid: number): Promise<MailMessage | null> {
    const msg = await this.client.fetchOne(String(uid), { uid: true, size: true, source: true }, { uid: true });
    if (!msg || !msg.source) return null;
    // heel grote mail (bv. video's): alleen de kop lezen, bijlagen overslaan
    const tooBig = (msg.size ?? msg.source.length) > MAIL_LIMITS.maxAttachmentBytes * MAIL_LIMITS.maxAttachmentsPerMail;
    const parsed = await simpleParser(msg.source, { skipHtmlToText: false, skipTextToHtml: true, skipImageLinks: true });
    const from = parsed.from?.value[0];
    return {
      uid,
      messageId: parsed.messageId ?? null,
      fromAddress: from?.address ?? '',
      fromName: from?.name ?? '',
      subject: parsed.subject ?? '',
      date: isoDate(parsed.date),
      text: (parsed.text ?? '').slice(0, 20_000),
      attachments: tooBig
        ? []
        : parsed.attachments.map((a) => ({
            filename: a.filename ?? '',
            contentType: a.contentType ?? '',
            content: new Uint8Array(a.content),
            inline: a.contentDisposition === 'inline' || Boolean(a.related),
          })),
    };
  }

  async move(uid: number, target: string): Promise<void> {
    const exists = (await this.client.list()).some((f) => f.path === target);
    if (!exists) await this.client.mailboxCreate(target);
    const ok = await this.client.messageMove(String(uid), target, { uid: true });
    if (!ok) throw new Error('Verplaatsen lukte niet');
  }

  async close(): Promise<void> {
    this.lock?.release();
    this.lock = null;
    try {
      await this.client.logout();
    } catch {
      this.client.close();
    }
  }
}
