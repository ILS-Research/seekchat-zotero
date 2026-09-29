# Code-Review SeekChat (v0.12.0)

Stand: 2026-09-29 · Reviewer: Claude Opus 5.5 · Grundlage: nur Quellcode (`src/`, `bootstrap.js`, `prefs.js`,
`manifest.json`, `build.sh`), ohne CLAUDE.md, Readmes, Changelog und Logs („NODOCS“). Die Unit-Tests wurden nicht
ausgeführt (die Node-Version auf dem Host ist zu alt, vorgesehen ist `./build.sh test` in Docker).

## Gesamteindruck

Der Code ist ordentlich und gut aufgebaut. Die reine Logik (Parser, Limits, Zitate, Markdown, Plan) steckt in eigenen
Modulen mit Unit-Tests, und das Zotero- und DOM-Gerüst ist dünn gehalten. Die Kommentare erklären, *warum* etwas so
gemacht ist. Bei der Sicherheit ist die Grundlage gut:

- eine Host-Allowlist, die bei jedem Request geprüft wird,
- `redirect: 'error'`, damit keine Weiterleitung den Dokumenttext zu einem anderen Host bringt,
- Markdown wird nur über `textContent` gerendert, nirgends mit `innerHTML`,
- im Notiz-HTML ist alles escaped.

Die Probleme liegen fast alle in der Nebenläufigkeit rund um die Library-Chat-Pipeline und in Dingen, die mit der Zeit
gewachsen sind.

## Fehler (sollten behoben werden)

1. ~~**Überspringt man ein Buch, schlagen andere Bücher mit fehl**~~ – *behoben in 0.12.1* (`src/core/session.ts:790-797`)
   - Die Suchbegriffe pro Sprache werden als gemeinsames Promise zwischengespeichert, laufen aber über das
     `bookCtrl.signal` des *ersten* Buchs.
   - Überspringt der Nutzer dieses Buch, wird das Promise abgelehnt. Das `.catch(() => delete)` hilft nur späteren
     Büchern.
   - Ein zweites Buch, das schon auf `await pending` wartet, landet in seinem eigenen `catch`. Dort ist sein eigenes
     Signal nicht abgebrochen, deshalb bekommt es den Status **`error`** mit einer „aborted“-Meldung.
   - Lösung: Den gemeinsamen Aufruf an `ctrl.signal` (den Gesamtabbruch) hängen statt an das Signal eines Buchs. Oder
     bei einem Abbruch-Fehler aus einem fremden Promise erneut versuchen.

2. ~~**In der Historie können Fragen ohne Antwort landen**~~ – *behoben in 0.13.0* (`src/core/session.ts:215-218`)
   - `history()` filtert fehlerhafte Antworten heraus, lässt die zugehörige Nutzerfrage aber drin.
   - Nach einem Fehler schickt man deshalb zwei `user`-Nachrichten direkt hintereinander. Manche OpenAI-kompatiblen
     Server (strikte Chat-Templates, z. B. bei vLLM) lehnen das ab.
   - Abgebrochene Antworten gehen samt dem Text „Abgebrochen“ als Assistant-Nachricht an das Modell.
   - Außerdem zählt `maxTurns * 2` einzelne Nachrichten statt Frage-Antwort-Paaren.
   - Lösung: Die Historie aus vollständigen Paaren aufbauen.

3. ~~**Veralteter Kommentar und toter Code bei `IMPLEMENTED_STRATEGIES`**~~ – *behoben in 0.13.0* (`src/core/session.ts:112-113`)
   - Der Kommentar sagt „"vector" is not implemented yet“, die Liste enthält `vector` aber.
   - Damit ist `meta.strategyFallback` (`src/core/session.ts:916`) nicht mehr erreichbar.

4. ~~**Streams werden nicht abgebrochen**~~ – *behoben in 0.12.1* (`src/core/llm/http.ts:57-75`)
   - Wenn `onLine` den Wert `false` liefert (bei `done`), gibt `readLines` nur `releaseLock()` frei. Dasselbe passiert,
     wenn der Parser eine Exception wirft.
   - Das HTTP-Body wird nicht mit `reader.cancel()` beendet. Die Verbindung zum Modellserver kann dadurch weiterlaufen,
     bis sie von selbst endet.
   - Lösung: im `finally` `await reader.cancel().catch(() => {})` aufrufen, wenn noch nicht `done`.

5. ~~**Fest eingebauter deutscher Text**~~ – *behoben in 0.12.1* (`src/core/zotseek/client.ts:186`)
   - `'keine JSON-Antwort'` steht direkt im Code und läuft nicht über `t()`.

## Robustheit und Design

6. ~~**Rückfrage ohne `think` nach grobem Muster**~~ – *behoben in 0.13.0* (`src/core/llm/ollama-client.ts:40-45`)
   - Jeder HTTP-Fehler, dessen Text „think“ enthält, führt dazu, dass das Modell dauerhaft als `noThink` markiert wird.
   - Das ist grob, aber harmlos. Besser wäre, zusätzlich auf den Status 400 zu prüfen.

7. ~~**Ein eigener System-Prompt ersetzt die Zitieranweisung komplett**~~ – *behoben in 0.12.1* (`src/core/prompt.ts:145`)
   - Schreibt der Nutzer einen eigenen Prompt, fehlt die Anweisung zum Format `[S. n]`. Die klickbaren Zitate
     funktionieren dann nicht mehr.
   - Im Library-Chat wird `systemPrompt` bewusst ignoriert (`''`). Das ist nirgends für den Nutzer dokumentiert.
   - Vorschlag: Den Nutzer-Prompt *zusätzlich* anhängen oder die Zitierregel immer mitschicken.

8. ~~**Alles wird bei jedem Token neu gezeichnet**~~ – *behoben in 0.12.1* (`src/ui/chat-section.ts:173-218`, analog in `library-window.ts`)
   - Während des Streamings wird alle 60 ms per `replaceChildren` jede Nachricht neu erzeugt und das Markdown neu
     geparst.
   - Folgen: Text lässt sich während des Streamings nicht markieren, ein manuell aufgeklapptes `<details>` klappt
     wieder zu, und bei langen Chats wird es teuer.
   - Besser: Nur die laufende (letzte) Nachricht neu zeichnen.

9. **Speicher wächst ohne Grenze**
   - `sessions` (`src/core/session.ts:986`), `pageCache` und `labelCache` (`src/core/context/pdf-context.ts`) werden
     nur beim Shutdown geleert.
   - Bei vielen großen PDFs pro Zotero-Sitzung bleibt so viel Volltext im Speicher. Eine einfache LRU-Begrenzung
     (z. B. 20 Einträge) würde reichen.

10. **Private Zotero-Interna werden genutzt**
    - Zum Beispiel `Zotero.Reader._readers` und `_internalReader._state.primaryViewStats`, außerdem
      `Zotero.ZotSeek.vectorStore` und `Zotero.SeekBook.indexer`.
    - Das ist sauber mit try/catch abgesichert. Es kann aber mit jedem Zotero-Update brechen, und das Manifest erlaubt
      bis `10.0.*`.

11. **Datenschutz beim Logging**
    - Fragen (die ersten 120 Zeichen), der Plan und die Queries gehen auf Info-Ebene in die Debug-Ausgabe und die
      Browser-Konsole.
    - Nutzer hängen die Debug-Ausgabe gern an Bug-Reports an. Besser nur auf Debug-Ebene loggen oder abschaltbar
      machen.

12. ~~**API-Key und unverschlüsseltes HTTP**~~ – *behoben in 0.13.0*
    - Der Bearer-Key wird auch an erlaubte Remote-Hosts über `http:` gesendet.
    - Sinnvoll wäre eine Warnung in den Einstellungen oder, bei gesetztem Key, nur `https` für Nicht-Loopback-Hosts.

13. **`noteText`** (`src/core/session.ts:976`)
    - Numerische Entities wie `&#8211;` oder `&#x…;` werden außer `&#39;` nicht dekodiert.
    - Ein `DOMParser` aus dem Hauptfenster wäre robuster als die Regex-Kette.

## Wartbarkeit

- **`session.ts` hat 1000 Zeilen und ist ein Monolith.** `answerLibrary`, `readBooks`/`readBook` und `loadRequested`
  sind eine eigene Pipeline und gehören in ein eigenes Modul, etwa `library/pipeline.ts`. Dann wird auch das
  Abbruch-Handling (Fehler 1) übersichtlicher und lässt sich testen.
- ~~**Kleinigkeiten, die mit der Zeit liegen geblieben sind:**~~ – *behoben in 0.13.0*
  - doppelte Imports (`logger`/`logError` in pdf-context, zweimal `save-note` in chat-section),
  - Imports mitten im Code (`const L = …` vor `import` in den Clients),
  - der Re-Export von `bookDetails` mitten in `src/ui/turn-view.ts:50-51`,
  - in `ChatView` werden Felder nach dem Konstruktor deklariert (`hintEl`, `notesBox`).
- **Die HTTP-Hilfen für ZotSeek und SeekBook sind fast gleich** (`getJson` mit Header `Zotero-Allowed-Request`). Laut
  Kommentar ist das bei host-guard gewollt, hier aber ohne Grund doppelt.
- **Die Server-Clients sind nicht direkt getestet.** Die Parser haben Tests, die Clients für Ollama und OpenAI (Retry,
  Stream-Ende, Fehlerpfad) nicht. Ein Test mit einem gemockten `fetch` wäre günstig.

## Umsetzungsplan

| Schritt | Inhalt | Status |
|---|---|---|
| 1 | Fehler 1–5 beheben, je mit Unit-Test, wo möglich (Historie aus Paaren, gemeinsames Suchbegriff-Signal, `reader.cancel()`) | erledigt: 1, 4, 5 in 0.12.1; 2, 3 in 0.13.0 |
| 2 | Punkte 6, 7, 12, 13 (kleine Robustheitskorrekturen) | teilweise: 7 in 0.12.1; 6, 12 in 0.13.0; offen: 13 |
| 3 | Nur die laufende Nachricht neu zeichnen (8), LRU für Caches und Sessions (9) | teilweise: 8 in 0.12.1; offen: 9 |
| 4 | Library-Pipeline aus `session.ts` herauslösen, Aufräumarbeiten, Client-Tests mit gemocktem `fetch` | teilweise: Aufräumarbeiten und ein erster Ollama-Client-Test in 0.13.0; offen: Pipeline herauslösen, weitere Client-Tests |
| 5 | Logging-Datenschutz (11), Interna-Nutzung (10) beobachten und dokumentieren | offen |

Beim Abarbeiten die Status-Spalte pflegen.
