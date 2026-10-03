# Bank automatisch ophalen met Ponto

Dit stappenplan beschrijft de Ponto-koppeling zoals de app haar toont (Bank, en Instellingen onder
Koppelingen). De koppeling is optioneel. Je afschriften inlezen blijft altijd de basis en de terugval.

## Wat het is

- Ponto is een afzonderlijke zakelijke dienst. Je sluit zelf een overeenkomst met Ponto. Kosten,
  proefvoorwaarden, ondersteunde banken en of jouw bedrijf wordt toegelaten bepaalt Ponto; controleer
  dat bij Ponto zelf.
- Je maakt in Ponto een eigen koppeling aan. Het Client ID en het Client Secret van die koppeling zijn
  van jou en horen alleen bij jouw administratie.
- Gewoon ophalen gaat rechtstreeks tussen de app en Ponto. ShipDocs ziet je bankgegevens en je
  inloggegevens niet.
- Het scherm laat zien tot welke datum de betalingen volledig zijn bijgewerkt. Is er een
  ontbrekende periode, of sluit de app niet aantoonbaar aan op je afschriften, dan zegt het scherm
  dat en vraagt het die periode te onderbouwen met een afschrift of openingssaldo. Dat is niet
  hetzelfde als "compleet".

## Instellen (de stappen in de app)

Op Bank staat de kaart "Bank automatisch ophalen met Ponto". Kies **Ponto instellen**. De wizard heeft
vijf stappen.

1. **Voor je begint.** De app zegt dat Ponto een afzonderlijke zakelijke dienst is en dat je kosten,
   voorwaarden, banken en toelating bij Ponto controleert. Heeft je computer geen veilige opslag voor
   inloggegevens, dan kan de koppeling hier niet worden ingesteld; blijf dan afschriften inlezen.
2. **Maak of open je Ponto-account.** Met **Open Ponto-dashboard** ga je naar het Ponto-dashboard en
   rond je daar je zakelijke account af.
3. **Koppel je bank bij Ponto.** Kies in Ponto de zakelijke bankrekening(en) die je in deze
   administratie wilt gebruiken en rond de toestemming bij je bank af.
4. **Maak de koppeling voor Boekhouden Voor Niks.** Met **Custom integration maken** ga je naar Ponto.
   Kies alleen **AIS** (rekeninginformatie), selecteer de rekeningen en behandel Client ID en Client
   Secret als een wachtwoord.
5. **Plak en test de twee gegevens.** Plak Client ID en Client Secret en kies **Verbinding testen**.
   Daarna kies je per Ponto-rekening waar die in deze administratie hoort: een bestaande rekening,
   een nieuwe zakelijke rekening, of niet gebruiken. De app stelt een bestaande rekening alleen voor
   bij een exact gelijk rekeningnummer. Een rekening die niet in euro's is of geen rekeningnummer
   heeft, is niet bruikbaar. Bij elke keuze staat of de aansluiting op je afschriften bewezen is.
   **Koppelen en ophalen** slaat de koppeling op en haalt meteen de eerste betalingen op.

Sluit je het venster met ingetypte maar niet opgeslagen gegevens, dan vraagt de app of je ze wilt
wissen.

## Daarna

- De app haalt zelf betalingen op bij het starten en daarna ongeveer elke zes uur, en je kunt met
  **Nu ophalen** zelf een ronde starten.
- **Nu bijwerken** (per rekening) vraagt Ponto om de bank te laten verversen. Voor die ene actie
  vraagt de app je publieke IP-adres op bij Cloudflare en stuurt het aan Ponto, omdat Ponto dat
  vereist. De app laat dat eerst zien en bewaart of logt het IP-adres niet. Na een geslaagde start kan
  dit pas na 30 minuten opnieuw; de knop zegt dan "Kan weer om ...".
- Bij elke rekening staat tot wanneer je toestemming bij Ponto loopt. Binnen 14 dagen voor de datum
  en na het verlopen zet de app een taak op Vandaag. Verleng de toestemming bij Ponto, of lees
  voorlopig een afschrift in.
- Verdwijnt de rekening bij Ponto, of werken de gegevens niet meer, dan meldt de app dat op Vandaag
  en kun je met **Opnieuw plakken** de twee gegevens vervangen.
- Je afschriften blijven werken: een betaling die al uit een afschrift is ingelezen, komt niet
  dubbel binnen.

## Ontkoppelen

**Ontkoppelen** verwijdert de koppeling en de opgeslagen inloggegevens van deze computer. Je
bestaande betalingen en bankrekeningen blijven staan. Verwijder daarna zelf ook de koppeling in
Ponto.

## Waar blijven de gegevens

- Client ID en Client Secret staan versleuteld in je administratie (en dus in je eigen back-ups) en
  worden niet in een pakket voor je boekhouder of een kopie voor een kantoor meegegeven.
- In de koppeling werkt de app niet in een kantoorkopie, een demo-administratie of een administratie
  die alleen bekeken wordt.
