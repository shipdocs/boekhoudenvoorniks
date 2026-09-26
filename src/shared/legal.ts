/**
 * Juridische teksten die in de app getoond worden. De volledige teksten staan op de website
 * (site/voorwaarden.html en site/privacy.html). Verhoog TERMS_VERSION bij een inhoudelijke wijziging:
 * gebruikers moeten dan opnieuw akkoord geven.
 */
export const TERMS_VERSION = '2026-09-26';
export const TERMS_URL = 'https://shipdocs.github.io/gratis-boekhouden/voorwaarden.html';
export const PRIVACY_URL = 'https://shipdocs.github.io/gratis-boekhouden/privacy.html';
export const SOURCE_URL = 'https://github.com/shipdocs/gratis-boekhouden';
export const LICENSE_NAME = 'GNU Affero General Public License v3.0 of later (AGPL-3.0-or-later)';

export const TERMS_SUMMARY: string[] = [
  'Gratis Boekhouden is gratis software, geleverd zoals hij is, zonder garantie.',
  'Jij blijft zelf verantwoordelijk voor je administratie en je belastingaangiften. Controleer de bedragen voordat je ze overneemt; de software geeft geen fiscaal advies.',
  'Je administratie staat alleen op je eigen computer. Maak regelmatig een back-up; je bent zelf verantwoordelijk voor de bewaarplicht van 7 jaar.',
  'Wij ontvangen geen gegevens uit je administratie. Alleen wat jij zelf verstuurt (e-mail, koppelingen die je aanzet) gaat naar buiten.',
];

export const VAT_DISCLAIMER =
  'Deze berekening is gemaakt op basis van je eigen boekingen. Controleer de bedragen voordat je ze overneemt in je aangifte; jij blijft verantwoordelijk voor de juistheid.';

/**
 * Alles wat de app voor de inkomstenbelasting uitrekent, moet de gebruiker laten controleren door een
 * boekhouder of accountant. Dat zeggen we overal waar een IB-bedrag staat, en eenmaal per jaar
 * vragen we om te bevestigen dat de gebruiker dat begrijpt.
 */
export const ACCOUNTANT_CHECK_TITLE = 'Laat dit altijd controleren door een boekhouder of accountant';

export const ACCOUNTANT_CHECK_REASONS: string[] = [
  'De regels voor ondernemers veranderen elk jaar, soms halverwege. Een boekhouder kent de nieuwste regels; deze app loopt daar misschien achter.',
  'De software kan fouten bevatten, en de uitkomst hangt af van wat jij hebt ingevoerd en gekozen. Een kleine vergissing kan veel geld kosten.',
  'De app kent alleen je bedrijf. Je partner, je huis, ander inkomen, spaargeld en persoonlijke aftrekposten tellen ook mee.',
  'Jij bent verantwoordelijk voor je aangifte. Een controle door een deskundige voorkomt naheffingen en boetes, en levert vaak meer aftrek op dan het kost.',
];
