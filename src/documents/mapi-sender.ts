import type { MapiSender, OwnMailMessage } from './own-mail';

/**
 * Simple MAPI op Windows (#450): het standaardmechanisme van het besturingssysteem om een mail met
 * bijlage te versturen via het standaardmailprogramma — zonder lijstje van programma's. MAPI32.dll
 * levert de Unicode-variant MAPISendMailW, zodat paden met accenten en spaties kloppen. koffi roept
 * die functie asynchroon aan: het venster van het mailprogramma mag open blijven staan zonder het
 * hoofdproces van de app te blokkeren.
 *
 * koffi wordt bewust pas hier geladen (alleen op Windows, pas bij gebruik): op Linux en in de
 * tests blijft de library buiten beeld. Lukt laden niet (geen koffi, geen MAPI32.dll, geen
 * MAPISendMailW), dan is er geen standaardmailprogramma en geeft dit null terug.
 */

/** MAPI_LOGON_UI | MAPI_DIALOG: desnoods een inlogvenster, en het schrijfvenster tonen. */
const MAPI_FLAGS = 0x1 | 0x8;
/** MAPI_ORIG is 0, MAPI_TO is 1 (mapi.h) */
const MAPI_TO = 1;
/** MAPI_LAST_MESSAGE: de bijlage hoort achteraan de tekst */
const MAPI_LAST_MESSAGE = 0xffffffff;

type Koffi = {
  load(path: string): { func(prototype: string): { async(...args: unknown[]): Promise<number> } };
  struct(name: string, members: Record<string, unknown>): unknown;
  pointer(type: unknown): unknown;
};

let cache: MapiSender | null | undefined;

/** De Simple MAPI-koppeling voor deze computer, of null als er geen standaardmailprogramma te laden is. */
export function createWindowsMapiSender(): MapiSender | null {
  if (cache !== undefined) return cache;
  cache = laden();
  return cache;
}

function laden(): MapiSender | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const koffi = require('koffi') as Koffi;
    const mapi32 = koffi.load('MAPI32.dll');
    // MapiFileDescW: één bijlage (pad + naam zoals de ontvanger hem ziet)
    const MapiFileDescW = koffi.struct('MapiFileDescW', {
      ulReserved: 'uint32',
      flFlags: 'uint32',
      nPosition: 'uint32',
      lpszPathName: 'wchar_t *',
      lpszFileName: 'wchar_t *',
      lpFileType: 'void *',
    });
    // MapiRecipDescW: één ontvanger
    const MapiRecipDescW = koffi.struct('MapiRecipDescW', {
      ulReserved: 'uint32',
      ulRecipClass: 'uint32',
      lpszName: 'wchar_t *',
      lpszAddress: 'wchar_t *',
      ulEIDSize: 'uint32',
      lpEntryID: 'void *',
    });
    const MapiRecipDescWPtr = koffi.pointer(MapiRecipDescW);
    const MapiFileDescWPtr = koffi.pointer(MapiFileDescW);
    // MapiMessageW: onderwerp, tekst en de lijstjes met ontvangers en bijlagen
    const MapiMessageW = koffi.struct('MapiMessageW', {
      ulReserved: 'uint32',
      lpszSubject: 'wchar_t *',
      lpszNoteText: 'wchar_t *',
      lpszMessageType: 'wchar_t *',
      lpszDateReceived: 'wchar_t *',
      lpszConversationID: 'wchar_t *',
      flFlags: 'uint32',
      lpOriginator: MapiRecipDescWPtr,
      nRecipCount: 'uint32',
      lpRecips: MapiRecipDescWPtr,
      nFileCount: 'uint32',
      lpFiles: MapiFileDescWPtr,
    });
    const MAPISendMailW = mapi32.func('unsigned long __stdcall MAPISendMailW(unsigned long session, unsigned long uiParam, const MapiMessageW *message, unsigned long flags, unsigned long reserved)');
    return {
      async send(msg: OwnMailMessage) {
        const message = {
          ulReserved: 0,
          lpszSubject: msg.subject,
          lpszNoteText: msg.body,
          lpszMessageType: null,
          lpszDateReceived: null,
          lpszConversationID: null,
          flFlags: 0,
          lpOriginator: null,
          nRecipCount: 1,
          lpRecips: [{ ulReserved: 0, ulRecipClass: MAPI_TO, lpszName: null, lpszAddress: `SMTP:${msg.to}`, ulEIDSize: 0, lpEntryID: null }],
          nFileCount: 1,
          lpFiles: [{ ulReserved: 0, flFlags: 0, nPosition: MAPI_LAST_MESSAGE, lpszPathName: msg.attachmentPath, lpszFileName: null, lpFileType: null }],
        };
        // .async: het venster van het mailprogramma kan open blijven staan zonder de app te blokkeren
        return await MAPISendMailW.async(0, 0, message, MAPI_FLAGS, 0);
      },
    };
  } catch {
    return null; // geen MAPI-koppeling te laden: het scherm krijgt "geen mailprogramma" te zien
  }
}
