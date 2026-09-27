import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import type { MailInSettings } from '../settings/settings';
import { cleanMailText, MAIL_LIMITS, type MailMessage, type MailSource } from './mail-intake';

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

function isoDate(value: Date | string | undefined): string {
  const d = value === undefined ? undefined : new Date(value);
  return (d && !Number.isNaN(d.getTime()) ? d : new Date()).toISOString().slice(0, 10);
}

type ParsedAttachment = { filename?: string; contentType?: string; content: Buffer; contentDisposition?: string; related?: boolean };

/**
 * Bijlagen, ook uit een doorgestuurde mail "als bijlage" (.eml): daarvan nemen we de bijlagen mee
 * (één niveau diep, zodat een mail in een mail in een mail niet eindeloos doorgaat).
 */
export async function attachmentsOf(list: ParsedAttachment[], depth = 0): Promise<MailMessage['attachments']> {
  return (await unpack(list, depth)).attachments;
}

/** Bijlagen én de tekst van mails die "als bijlage" zijn doorgestuurd (de bon staat dan in de binnenste mail). */
export async function unpack(list: ParsedAttachment[], depth = 0): Promise<{ attachments: MailMessage['attachments']; forwardedText: string }> {
  const attachments: MailMessage['attachments'] = [];
  const texts: string[] = [];
  for (const a of list) {
    if (a.contentType === 'message/rfc822' && depth === 0) {
      try {
        const inner = await simpleParser(a.content, { skipHtmlToText: false, skipTextToHtml: true, skipImageLinks: true });
        const from = inner.from?.text ?? '';
        const head = [`---------- Doorgestuurd bericht ----------`, from && `Van: ${from}`, inner.date && `Datum: ${isoDate(inner.date)}`, inner.subject && `Onderwerp: ${inner.subject}`].filter(Boolean).join('\n');
        if (inner.text?.trim()) texts.push(`${head}\n\n${inner.text}`);
        attachments.push(...(await unpack(inner.attachments as ParsedAttachment[], depth + 1)).attachments);
      } catch {
        // onleesbare doorgestuurde mail: overslaan
      }
      continue;
    }
    attachments.push({ filename: a.filename ?? '', contentType: a.contentType ?? '', content: new Uint8Array(a.content), inline: a.contentDisposition === 'inline' || Boolean(a.related) });
  }
  return { attachments, forwardedText: texts.join('\n\n') };
}

/**
 * De leesbare tekst van een mail: opgeschoond, met de tekst van een "als bijlage" doorgestuurde mail
 * erachter. Is er zo'n doorgestuurde mail, dan krijgt de eigen tekst (meestal "zie bijlage" plus een
 * handtekening) hooguit een kwart van de ruimte, zodat de bon in de binnenste mail niet wegvalt.
 */
export function mailText(text: string | undefined, forwardedText: string, max = 20_000): string {
  const own = cleanMailText(text ?? '');
  const fwd = cleanMailText(forwardedText);
  if (!fwd) return own.slice(0, max);
  const ownPart = own.slice(0, Math.max(max / 4, max - fwd.length - 2));
  return (ownPart ? `${ownPart}\n\n${fwd}` : fwd).slice(0, max);
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
    // eerst alleen de grootte: heel grote mail (bv. video's) lezen we niet helemaal in
    const head = await this.client.fetchOne(String(uid), { uid: true, size: true, envelope: true }, { uid: true });
    if (!head) return null;
    if ((head.size ?? 0) > MAIL_LIMITS.maxAttachmentBytes * MAIL_LIMITS.maxAttachmentsPerMail) {
      const from = head.envelope?.from?.[0];
      return {
        uid,
        messageId: head.envelope?.messageId ?? null,
        fromAddress: from?.address ?? '',
        fromName: from?.name ?? '',
        subject: head.envelope?.subject ?? '',
        date: isoDate(head.envelope?.date),
        text: '',
        attachments: [],
      };
    }
    const msg = await this.client.fetchOne(String(uid), { uid: true, source: true }, { uid: true });
    if (!msg || !msg.source) return null;
    const parsed = await simpleParser(msg.source, { skipHtmlToText: false, skipTextToHtml: true, skipImageLinks: true });
    const from = parsed.from?.value[0];
    const { attachments, forwardedText } = await unpack(parsed.attachments as ParsedAttachment[]);
    return {
      uid,
      messageId: parsed.messageId ?? null,
      fromAddress: from?.address ?? '',
      fromName: from?.name ?? '',
      subject: parsed.subject ?? '',
      date: isoDate(parsed.date),
      text: mailText(parsed.text, forwardedText),
      attachments,
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
