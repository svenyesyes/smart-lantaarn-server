# Smart Lantaarn Server

Een minimalistische, deterministische beslisengine voor slimme straatverlichting. Het systeem modelleert lampen als knopen in een graaf (met verbindingen tussen lampen en straten), ondersteunt activatie per straat met gecontroleerde “spillover” naar naburige lampen, en biedt een eenvoudige webinterface en realtime updates.


## Concept
- **Lampen als graaf:** Elke lamp heeft een unieke `id`, hoort bij een straat (`street`) en heeft verbindingen (`connections`) met andere lampen. Samen vormen ze een graafstructuur.
- **Activatie per straat:** Je kunt een straat aan/uit zetten, helderheid en kleur instellen, en optioneel spillover toepassen zodat lampen buiten de straat via verbindingen meeschakelen tot een begrensde diepte.
- **Deterministisch gedrag:** De engine werkt op in-memory data en produceert voorspelbare resultaten, inclusief een overzicht van wat er is geactiveerd.
- **Realtime UI:** De server levert een eenvoudige frontend die de graaf visualiseert, lampstatussen toont en wijzigingen zichtbaar maakt. Updates lopen via WebSockets.
- **Sensoren en apparaten:** Sensoren kunnen aan lampen gelinkt worden. Apparaten (lampen/sensoren) kunnen via aparte WebSocket-poorten koppelen voor status en aansturing.
- **Optionele animatie:** “Rainbow mode” kan ingeschakelde lampen dynamisch van kleur laten wisselen voor demonstratiedoeleinden.

## Architectuur in het kort
- **Backend (Express + WebSocket):** Verzorgt het serveren van de UI, biedt endpoints voor data en levert realtime updates naar de browser.
- **Frontend:** Visualiseert de graaf en actuele toestanden van lampen en (optioneel) sensoren, en maakt eenvoudige bewerkingen mogelijk.
- **Persistente data in JSON:** Lamp- en sensorconfiguratie en positiegegevens worden in `data/` opgeslagen en door de server gebruikt.

## Installatie & Starten
Vereisten: Node.js (bij voorkeur v18 of hoger) en npm.

1. Installeer dependencies.
2. Bouw de TypeScript-broncode.
3. Start de server en open de UI in je browser.

Stappen:

```
npm install
npm run build
npm start
```

- De server draait standaard op http://localhost:3000.
- Voor ontwikkeling kun je `npm run dev` gebruiken om de TypeScript-compiler te laten watchen.
- Er is een aanvullende harness/testrun beschikbaar via `npm run start:harness` of `npm test`.

## Data-bestanden
Alle data staat in de map `data/`. Deze bestanden bepalen de inhoud van de graaf, standaardinstellingen en de weergaveposities in de UI.

### settings.json
Bevat de configuratie van lampen, sensoren en een aantal algemene instellingen. Belangrijkste velden:
- **lamps:** Lijst van lampen met o.a. `id`, `name` (optioneel), `street`, `connections` (ids van naburige lampen) en `state` (zoals `on`, `brightness`, `color`, eventueel `colorMode`).
- **sensors:** Lijst met sensoren (optioneel) met `id`, `name`, eventueel `street` en `linkedLampId` om een sensor aan een lamp te koppelen.
- **spilloverDepth:** Maximaal aantal “hops” dat spillover buiten de geactiveerde straat mag doorwerken.
- **pulseColor:** Kleurindicatie die de UI gebruikt voor feedback rond activaties en sensorranden.
- **defaultOnColor:** Standaardkleur voor lampen die worden ingeschakeld.
- **activationDurationMs:** Eventuele standaardduur voor activaties (kan gebruikt worden voor tijdelijke signalen of identify-achtige acties).
- **sensorEdgeColor:** Kleur die de UI gebruikt om sensor-verbindingen te tekenen.
- **rainbowMode:** `true`/`false` om de animatiestand voor ingeschakelde lampen te activeren.

Gebruik en beheer:
- De server leest `settings.json` bij het starten en periodiek via een lichte cache. Wijzigingen in dit bestand worden door de UI zichtbaar zodra de server ze opnieuw heeft ingelezen.
- Bepaalde bewerkingen in de UI (zoals het bijwerken van lamp- en sensor-meta) kunnen teruggeschreven worden naar `settings.json`, waardoor je configuratie persistent blijft.
- Zorg dat alle `id`s uniek en consistent zijn; verbindingen (`connections`) verwijzen naar bestaande lamp-`id`s.

### positions.json
Bevat de 2D-positie van lampen en (optioneel) sensoren voor visualisatie in de UI.
- Structuur: een mapping van `id` → `{ x: number, y: number }`.
- Deze posities worden door de frontend gebruikt om knooppunten op het canvas te plaatsen.
- Positie-updates kunnen via de UI of API worden doorgevoerd; de server schrijft ze terug naar `positions.json` zodat ze behouden blijven.

## Poorten & Toegang
- **Web UI & API:** poort 3000 (HTTP). Open in je browser: http://localhost:3000.
- **Lamp WebSocket:** poort 3090 — voor lamp-achtige apparaten die status/aansturing ontvangen en terugkoppelen.
- **Sensor WebSocket:** poort 3092 — voor sensoren die gebeurtenissen doorgeven en optioneel gekoppeld zijn aan lampen.

## Veelvoorkomende workflows
- **Straat activeren:** Gebruik de UI om een straat aan/uit te schakelen, helderheid/kleur te wijzigen en eventueel spillover toe te passen. De effecten verschijnen direct in de visualisatie.
- **Configuratie aanpassen:** Werk `settings.json` bij om lampen, straten, verbindingen en sensoren te beheren. Kleine wijzigingen kun je ook via de UI doen; de server houdt de JSON in sync.
- **Posities corrigeren:** Versleep in de UI of bewerk `positions.json` om knooppunten anders te plaatsen voor een duidelijke weergave.
- **Demomodus:** Zet rainbow mode aan om ingeschakelde lampen dynamisch van kleur te laten wisselen.

## Problemen oplossen
- Wijzigingen niet zichtbaar? Controleer of de server draait en vernieuw de browser. Bij grote wijzigingen kan het helpen de server opnieuw te starten.
- Onjuiste verbindingen of ontbrekende nodes? Verifieer `id`s en `connections` in `settings.json`.
- Poorten bezet? Pas de poortconfiguratie aan of sluit processen die al op 3000/3090/3092 luisteren.

## Licentie
Zie de licentie-informatie in dit project of in de package metadata.
