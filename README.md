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

## Netwerkprotocollen

### UDP broadcast (auto-discovery voor lampen)
- **Doel:** Lamp-apparaten automatisch laten ontdekken waar ze moeten verbinden.
- **Mechanisme:** De server berekent alle lokale broadcast-adressen op basis van de actieve IPv4-netwerkinterfaces en stuurt elke 2 seconden een UDP-pakket naar poort `3091`.
- **Bericht:** JSON-payload met minimaal `{ "type": "lamp_server_announce", "ws_port": 3090 }`.
- **Verwachte client-actie:** Lampen die op UDP `3091` luisteren, lezen `ws_port` en maken (of houden) vervolgens een WebSocket-verbinding met `ws://<server>:3090`.

### WebSocket-pakketten (overzicht)
De server gebruikt drie WebSocket-kanalen: één voor de UI (browser), één voor lampen en één voor sensoren. Berichten zijn JSON-objecten met een `type`-veld en verdere data afhankelijk van het type.

#### UI WebSocket (poort 3000)
- **init:** `{ type: "init", graph, states, positions }` — volledige initiale snapshot.
- **update:** `{ type: "update", graph, states, events }` — incrementele updates na acties (bijv. straatactivatie).
- **positions:** `{ type: "positions", positions }` — bevestiging/broadcast van gewijzigde posities.
- **device_status:** `{ type: "device_status", connectedIds }` — lijst met online apparaat-IDs (lampen + sensoren).
- **street_activated:** `{ type: "street_activated", street }` — signaal dat een straat is geactiveerd (bijv. door een apparaat).

#### Lamp WebSocket (poort 3090)
- **request_id → assigned_id:** Lamp vraagt een ID aan: `{ type: "request_id" }`; server antwoordt met `{ type: "assigned_id", id }`.
- **authorize → authorized:** Lamp meldt zich met ID: `{ type: "authorize", id }`; server bevestigt `{ type: "authorized", id }` en kan direct de gewenste `state` pushen.
- **legacy register:** `{ type: "register", id }` — oudere registratiepad; gebruik bij voorkeur `request_id`/`authorize`.
- **activated (server → lamp):** `{ type: "activated", id, state }` — stuurt gewenste/actuele toestand naar het apparaat.
- **state (lamp → server):** `{ type: "state", id, state }` — terugkoppeling van apparaatstatus; engine/UI worden bijgewerkt.
- **activate_street (lamp → server):** `{ type: "activate_street", id }` — triggert straatactivatie met spillover; UI en andere lampen worden geïnformeerd.
- **error:** `{ type: "error", code, message }` — bijv. `unauthorized_id`, `no_street`.
- **heartbeat:** Periodieke JSON-`ping` van de server: `{ type: "ping", ts }`; daarnaast gebruikt de server WebSocket `pong` events voor levenscontrole.

#### Sensor WebSocket (poort 3092)
- **request_sensor_id → assigned_sensor_id:** `{ type: "request_sensor_id" }` → `{ type: "assigned_sensor_id", id }`.
- **authorize_sensor → authorized_sensor:** `{ type: "authorize_sensor", id }` → `{ type: "authorized_sensor", id }`.
- **sensor_activate (sensor → server):** `{ type: "sensor_activate", id }` — triggert activatie van de gelinkte lamp/straat (met spillover), inclusief UI-notificatie.
- **sensor_triggered (server → sensor):** `{ type: "sensor_triggered", id, street }` — bevestiging van verwerking.
- **error:** `{ type: "error", code, message }` — bijv. `unauthorized_id`, `no_link`, `no_street`.
- **heartbeat:** Periodieke JSON-`ping` van de server: `{ type: "ping", ts }`.

Opmerking: De concrete payloadvelden (`graph`, `states`, `events`, `positions`, `state` enz.) volgen de interne datastructuren van de engine. Voor de meest actuele structuur kun je de JSON in de browserconsole inspecteren of de broncode raadplegen.
