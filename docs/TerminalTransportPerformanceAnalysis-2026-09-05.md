# tlbx: End-to-End-Analyse von Terminal-Latenz und Browserlast

Stand: 2026-09-05. Untersucht: `dev`, Commit `50063d4549db7a15e7aa93c3398aaa97c371fc5f` (`v10.12.6-dev`), Checkout `Q:\repos\tlbx-3`. Analyse und Plan, keine Produktimplementierung, kein neues Release.

## Ergebnis

Es gibt mehrere voneinander unabhängige Ursachenklassen. Eine geringe Terminal-Datenrate schließt weder hohe Browserarbeit noch blockierte Eingaben aus.

1. **Im echten Browser reproduziert: Layout-Synchronisierung sendet endlos identische erfolgreiche PUTs.** Nach Ende der Terminaltests: 2.848 Anfragen in fünf Sekunden, bei null offenen Terminals. Eine zweite Messung ergab 2.768 in fünf Sekunden. Das ist ein konkreter Verursacher unnötiger Browser-/Serverarbeit außerhalb des Terminaldatenstroms.
2. **Mit der echten Writer-Klasse deterministisch reproduziert: Prioritätswechsel kann Daten derselben Session umordnen.** Neuere aktive Frames überholen ältere Hintergrundframes. Der Browser muss dann eine künstlich erzeugte Sequenzlücke reparieren.
3. **Im Quellcode bestätigt: Der gemeinsame Mux-Empfang wartet auf vollständige Recoveries und IPC-Schreibvorgänge.** Eine Session kann dadurch das Einlesen von Eingaben anderer Sessions blockieren. Die Latenz dieses Pfades unter einem künstlich langsamen Socket wurde hier noch nicht numerisch vermessen.
4. **Im Quellcode bestätigt: Das Browserlimit für unverarbeitete xterm-Daten zählt pro Drain-Aufruf, nicht persistent pro Terminal.** Der nominelle 512-KiB-Schutz ist daher kein verlässliches Gesamtlimit. Zusätzlich teilen sich alle xterm-Parser, Eingabeereignisse und Renderaufgaben den Hauptthread.
5. **Im CPU-Profil sichtbar: Zellweises Nachschlagen von Theme-Konfiguration und Glyphen-/Renderarbeit.** Das ist ein gezielter Optimierungskandidat, kein Beleg dafür, dass jede beobachtete Langsamkeit vom Renderer stammt.

Die seltenen mehrsekündigen Hänger wurden in der kurzen Browser-Matrix nicht reproduziert. Die beiden ersten Fehler sind dennoch direkt nachgewiesen. Die Analyse erklärt plausible Ketten bis zu den gemeldeten Symptomen, ohne sämtliche Produktionsaussetzer einer einzigen Ursache zuzuschreiben.

## Transportweg und gemeinsame Engstellen

```text
Browser-Eingabe / xterm.onData
  -> optionales Printable-Input-Coalescing
  -> ein Mux-WebSocket je Browserverbindung
  -> sequentieller Server-Empfang / ProcessFrameAsync
  -> TtyHostSessionManager -> sessionbezogener IPC-Schreiblock
  -> mthost -> PTY-Schreiblock -> ConPTY -> Shell/TUI
  -> dedizierter PTY-Lesethread
  -> Replay-Zustand + begrenzter Byte-Scrollback
  -> begrenzter IPC-Ausgabekanal
  -> globaler fairer Mux-Scheduler
  -> Client-Scheduler + SessionBuffer
  -> gemeinsamer priorisierter WebSocket-Writer
  -> Browser-Sessionqueue / Dekompressionsworker
  -> xterm-WriteBuffer und Parser auf dem Hauptthread
  -> WebGL/DOM, Glyphenatlas, Layout, Compositor -> sichtbares Bild
```

| Grenze | Aktueller Vertrag / Größenordnung | Bedeutung |
|---|---|---|
| Browser-Eingabe | Coalescing konfigurierbar 0–200 ms; Testwert 0; erstes Zeichen sofort | Keine Erklärung für die Test-Basislatenz durch aktiviertes Coalescing |
| Mux-Empfang | Ein `await ProcessFrameAsync` vor dem nächsten `ReceiveAsync` | Recovery oder blockiertes IPC kann alle Sessions dieses Browsers aufhalten |
| Windows-PTY | Synchrone Pipehandles; 64-KiB-Pipes; eigener blockierender Ausgabelesethread | Nicht pauschal auf `isAsync:true` umstellen; Handle-Vertrag beachten |
| mthost-Ausgabe | 256 IPC-Frames je Client; voller Kanal wartet synchron im Output-Callback | Langsamer IPC-Leser kann den PTY-Lesethread dieses Hosts zurückstauen |
| Globaler Mux | 1.000 Einträge / 8 MiB, Session-FIFO, aktiver Burst 32 | Fairness wurde bereits implementiert; nicht erneut als fehlend beschreiben |
| Mux je Browser | 1.000 Einträge / 4 MiB; Drain-Quantum 64; Sessionbuffer 256 KiB | Mehrere hintereinanderliegende begrenzte Puffer; Füllstand allein erklärt Wartezeit nicht |
| Flush | aktiv 12 ms, sonst sichtbar 15 ms, verborgen/montiert 250 ms; 32-KiB-Chunks | Sichtbare Panes werden nicht absichtlich auf 250 ms gedrosselt |
| Letzter Writer | 2.048 Frames / 8 MiB; strikte Priorität, ein physischer Send; 5-s-Sendtimeout | Upstream-Fairness garantiert weder hier Fairness noch Session-FIFO |
| Browser-Queue | 4 MiB / 2.000 Einträge je Session; 64-KiB-Batches; 8-ms-Drainbudget | Budget je Session ist kein gemeinsames Framebudget |
| xterm | eigener 12-ms-Write-Zeitschnitt, Prüfung nach Verarbeitung eines Chunks | Einzelne Chunks können länger dauern; mehrere Sessions teilen denselben Thread |
| Retention | Testkonfiguration 10.000 Zeilen; regulärer Host-Bytepuffer separat konfiguriert | Zeilentiefe und Byte-Retention sind unterschiedliche Verträge und bleiben erhalten |

Die Locks in `mthost` sind nicht ein globaler Lock über alle Terminals: Der reguläre Host ist sessionbezogen. Direkte sessionsübergreifende Kopplung liegt vor allem im gemeinsamen Browser, Mux-Empfang/-Writer und Serverprozess. Host-/OS-Ressourcenkonkurrenz bleibt eine weitere, separat zu messende Ebene.

## Befunde im Detail

### A. Layout-ACK wird verworfen, identischer Zustand sofort erneut gesendet

Datei: `src/Ai.Tlbx.MidTerm/src/ts/modules/layout/layoutStore.ts`, insbesondere `applyServerLayoutState` (534), `shouldIgnoreServerLayoutSnapshot` (575), `reconcilePendingServerLayoutSnapshot` (591), `syncLayoutToServer` (639), `scheduleLayoutSync` (686).

`shouldIgnoreServerLayoutSnapshot` verwirft einen Snapshot, wenn dessen Inhalt schon dem lokalen Zustand entspricht. Der Rücksprung erfolgt **vor** Aktualisierung der bestätigten Serverrevision und vor dem Löschen des ausstehenden lokalen Zustands. Auch ein passendes ACK kann damit ignoriert werden. `syncLayoutToServer` sieht weiterhin einen unbestätigten Zustand und plant im `finally` sofort den nächsten Versuch. Jeder Versuch serialisiert Layout, schreibt gegebenenfalls synchronen localStorage und führt Fetch/JSON-Verarbeitung aus.

Direkte Beobachtung im isolierten Chrome nach Schließen aller Testterminals:

```json
{
  "intervalSeconds": 5,
  "requests": 2848,
  "method": "PUT",
  "body": { "revision": 1, "root": null, "focusedSessionId": null },
  "completedStatus200": 2847,
  "openTerminals": 0
}
```

Die Differenz von einer Anfrage liegt an der Messfenstergrenze. Zweites Fenster: 2.768 Requests / 2.767 erfolgreiche Antworten. Es handelt sich nicht bloß um langsame Fehler-Retries. Ein diagnostisches Anhalten ausschließlich dieses PUT-Pfads im Testtab ließ die Anfragen enden. Keine Produktionskonfiguration wurde geändert.

### B. Session-FIFO geht im letzten Writer verloren

Dateien: `Services/WebSockets/PrioritizedWebSocketWriter.cs` (Prioritäten 8–15; Enqueue ca. 110/145), `MuxClient.cs` (`FlushBuffer`, ca. 1084–1220).

Der Writer kennt pro Eintrag nur Payload und Priorität, keine Session-Zugehörigkeit. FIFO gilt innerhalb einer Prioritätsklasse. `MuxClient` wählt die Priorität jedoch anhand des jeweils aktuellen Fokus-/Sichtbarkeitszustands.

Probe mit unveränderter echter Klasse und einem kontrolliert angehaltenen Fake-WebSocket:

```text
Zuerst ein fremder Send in-flight.
Dann: Session A, ältere Bytes 0..9, BackgroundLive.
Danach: Session A, neuere Bytes 10..19, ActiveLive.
Nach Freigabe gesendet: fremd -> A 10..19 -> A 0..9.
```

Das sind beschriftete Testpayloads, kein vollständiger Browser-Netzwerktest. Die tatsächliche Queue-Umordnung ist damit bewiesen; die daraus folgende Recovery-Kette ergibt sich aus der Sequenzlückenbehandlung im Browser. Auch Recovery-Grenzen müssen beim Fix gegen bereits eingereihte Live-Daten abgesichert werden. Ein globales `Control`-Vorrecht darf solche Session-Barrieren nicht überspringen.

### C. Recovery blockiert den gemeinsamen Eingang

`MuxWebSocketHandler.cs`: Empfangsschleife ca. 602–635, `ProcessFrameAsync` ca. 688–758, `SendSnapshotAsync` ca. 413–456.

BufferRequest, ActiveSessionHint und Sichtbarkeitshinweise warten auf Recovery. Recovery liest den Host-Snapshot und wartet für jeden Replay-Chunk auf dessen Send-Abschluss. Bis dahin wird die nächste Browsernachricht nicht gelesen. Eingaben, Ping und weitere Sessions stehen dahinter. Ein langsamer IPC-Schreibvorgang im Input-Pfad hat dieselbe Wirkung; `TtyHostClient.WriteAsync` wartet auf den Stream und nutzt hier keine separate kurze Schreibfrist.

Das erklärt insbesondere: kurzfristiger Hintergrund-/Replay-Rückstau -> später wenig Traffic -> trotzdem lange Eingabewartezeit. Die strikte Priorität des Writers kann Recovery hinter sichtbarer Dauerausgabe zusätzlich verzögern. Die konkrete Maximalverzögerung hängt vom Rückstau und der Verbindung ab; keine erfundene feste Latenzzahl.

### D. Pufferbudget und Main-Thread-Budget sind nicht end-to-end

`src/ts/modules/comms/muxChannel.ts`: Grenzen 417–424, `processSessionOutputQueue` 703 ff. `unparsedTerminalBytes` beginnt in jedem neuen Drain bei null. Viele nacheinander abgearbeitete kleine Browserqueues können daher mehr als 512 KiB an xterm übergeben, ohne jemals in einem einzelnen Drain die Schwelle zu erreichen. Der 5-s-Parsebarrier-Timeout löst zusätzlich nur eine Wartebarriere, nicht den zugrunde liegenden Rückstau.

Die genauen Maxima dieses Pfades wurden hier nicht mit einem verzögerten Fake-Parser reproduziert; ein gezielter Regressionstest gehört in die Umsetzung. Die vorhandenen Tests prüfen große zusammenhängende Bursts, nicht ausreichend viele getrennte Drain-Aufrufe mit zurückgehaltenen Parse-Callbacks.

Bereits vorhanden und zu erhalten: Dekompression erfolgt normalerweise in einem Worker (`src/ts/utils/protocol.ts`), File-Radar hat Worker/Filter/Debouncing und läuft im aktuellen Output-Pfad nur für die aktive Session. Ein weiterer pauschaler Worker-Umbau wäre keine begründete erste Maßnahme.

### E. Renderzustand und Arbeit pro Zelle

Im CPU-Profil ist der WebGL-Helper `Ut` prominent; die aktuell gebaute Datei ordnet ihn dem Zugriff `terminal.element.ownerDocument.defaultView.__MIDTERM_XTERM_FG_BOOST__` zu. Das geschieht im Zellfarbpfad, zusammen mit wiederholter Typ-/Bereichsprüfung. Im ersten Profil entfallen darauf ca. 342 ms Selbstzeit über 74 s; außerdem `_updateModel`, Glyphenatlas und `getImageData`. Das ist kein Gesamt-CPU-Prozentsatz; `(program)`-Samples und GPU-/Compositorarbeit sind darin nicht sinnvoll als JavaScript-Funktionskosten zuzuordnen.

`terminal/manager.ts` besitzt bereits WebGL-Kontextverwaltung, Reattach-Backoff von 1,5 bis 30 s und DOM-Fallback. Ein Wechsel des Renderers kann das Verhältnis von Datenrate zu CPU plötzlich ändern. Er muss in Latenzaufzeichnungen sichtbar sein. `preserveDrawingBuffer` wird für Screenshots benötigt: nicht ungeprüft deaktivieren. Ligaturen, Transparenz und sichtbare Terminalpanes bleiben funktional erhalten.

## Messungen und ihre Grenzen

Isolierte Quellinstanz auf `https://localhost:2100`, installierter Host; stabile Installation auf Port 2000 unangetastet. Chrome-Perf-Skill, Headless Chrome mit dessen `--disable-gpu`-Startoption; xterm meldete WebGL für das aktive Terminal. Dies ist kein Nachweis nativer GPU-Leistung des Benutzerbrowsers. 6.000 erzeugte History-Zeilen bei unveränderter Konfiguration von 10.000 Zeilen, drei echte PTYs, je Phase 45 einzeln bestätigte Zeichen.

Messpunkt: `terminal.input(..., true)` -> echter Mux-/IPC-/ConPTY-/ReadKey-Echo-Rundweg -> `onWriteParsed`. Kein physisches Keyboard-Event und kein bestätigter Pixel-Present. Scrollen wurde über xterms `scrollLines` angeregt, nicht durch reale Mausrad-/Touchereignisse. Der Latency-Overlay war aktiviert.

| Phase | Eingabe p50 | Eingabe p95 | Maximum | RAF p95 |
|---|---:|---:|---:|---:|
| Andere Sessions ruhig | 21,1 ms | 22,9 ms | 28,8 ms | 16,7 ms |
| Kleine Cursoranimation in versteckter montierter Session | 21,6 ms | 22,8 ms | 23,7 ms | 16,7 ms |
| Zwei sichtbare ASCII-Animationen | 20,4 ms | 33,6 ms | 36,1 ms | 16,7 ms |
| Zusätzlich History-Scrollen | 25,2 ms | 38,3 ms | 38,5 ms | 16,7 ms |
| Nach Ende der Last | 22,1 ms | 23,2 ms | 24,3 ms | 16,8 ms |

225/225 Echos, keine Timeouts, keine neuen Sequenzlücken/Datenverlustmeldungen in den Phasen; am Ende konvergierte `receivedSeq = submittedSeq = renderedSeq`. Das ersetzt keinen vollständigen Scrollback-Inhaltsvergleich. Die kleinen Input-Trace-Stichproben zeigen meist nur ca. 0,1–0,4 ms zwischen Empfang und Parserabschluss des Echo-Bytes; der überwiegende Teil der gemessenen Rundlaufzeit liegt davor. Daraus lässt sich ohne weitere Zeitmarken nicht allein Server-, Netzwerk- oder Browser-Eventloopzeit isolieren.

Zusätzlicher Isolationslauf mit ausschließlich diagnostisch angehaltener Layout-Persistierung: 225/225 Echos; p95 ca. 23,5 / 23,9 / 33,1 / 52,3 / 23,3 ms. In der Scrollphase RAF-p95 33,3 ms. Dieser Lauf überschnitt sich teilweise mit dem ressourcenintensiven Trace-Export des ersten Laufs; er ist **kein belastbarer Vorher/Nachher-Geschwindigkeitsvergleich**. Er zeigt auch, dass die Layout-Schleife nicht alle Latenzquellen erklärt.

Der erste vollständige Trace-Export wurde wegen stark wachsendem Speicher-/CPU-Bedarf des Collectors abgebrochen; Szenario-Daten und CPU-Profil wurden gesichert. Zwei frühere Vorläufe scheiterten an einem zu engen Marker-Suchbereich im Testskript, nicht an bewiesenem Terminalverlust. Der abschließende Isolationslauf lieferte einen vollständigen Skill-Summary: `ok=true`, Heap nach Cleanup +4,38 MiB, DOM +700 Nodes / +90 Listener, 0 zusätzliche Dokumente; keine Long Tasks in den gemessenen Phasen, Gesamtmaximum 119 ms während des gesamten Szenarios. Ein einzelner Lauf beweist weder Leakfreiheit noch einen Leak.

Vorhandene Latenztraces verbessern: Sie enden bei Parserabschluss, markieren die erste passende Ausgabe nach Input und verwerfen abgelaufene 5-s-Traces. Bei animierenden TUIs ist diese Ausgabe nicht zwingend das kausale Echo. Ausfälle/Timeouts müssen als eigene Samples gezählt werden, sonst fehlt gerade der relevante lange Verteilungsschwanz.

## Umsetzungsplan in Prioritätsreihenfolge

### 1. Layout-Synchronisierung zur Ruhe bringen — zuerst, kleiner eigenständiger Fix

- Bestätigung/Revision/pending-Zustand verarbeiten, auch wenn sich der sichtbare Inhalt nicht ändert. Gleichheit darf DOM-Arbeit vermeiden, aber keine ACK-Verarbeitung.
- ACK des exakt gesendeten Zustands von inzwischen neuerem lokalem Edit unterscheiden; altes ACK darf neuen Edit nicht löschen. Idempotentes HTTP-200-ACK mit gleicher Revision und 409-Konflikt ausdrücklich testen.
- Identischen erfolglosen Reconcile nicht als Null-Delay-Endlosschleife planen. Neue Benutzeränderung, neue Serverrevision und tatsächlicher Retry sind getrennte Gründe.
- localStorage nur bei tatsächlicher Persistenzänderung schreiben.
- Abnahme: nach einer bestätigten Layoutänderung keine weiteren identischen PUTs über 60 s; Tests für verzögerte/vertauschte ACKs, gleiche Inhalte/neue Revision, konkurrierende Browser und Löschen fokussierter Sessions. Keine neue dauerhafte Synchronisierungsschleife hinzufügen.

### 2. Endgültigen Writer ordnungs- und fairnesstreu machen

- Pro Session geordnete Versandkette; priorisiert wird nur zwischen versandberechtigten Session-Köpfen. Fokuswechsel darf die ältere Sessionfolge nicht überholen.
- RecoveryBegin/Replay/RecoveryEnd und bereits eingereihte Live-Daten brauchen explizite Session-Barrieren. Unabhängige Ping-/Verbindungssteuerung darf davon getrennt bevorzugt werden.
- Begrenztes Fairnessquantum auch im letzten Writer, damit Replay und nichtaktive sichtbare Sessions Fortschritt behalten. Größen anhand Messung wählen, nicht blind Warteschlangen vergrößern.
- Gepooltes Buffer-Eigentum bis tatsächlichem Send-Abschluss, Fehler-/Cancel-/Shutdown-Pfade genau einmal freigeben. Queued und tatsächlich gesendet in Diagnostik auseinanderhalten.
- Abnahme: Fokuswechsel unter Send-Stall, Replay plus Live, mehrere Produzenten, Queuevoll, Abbruch/Dispose; bytegenaue Session-FIFO und endlicher Fortschritt. Die vorhandene Writer-Probe muss anschließend FIFO liefern.

### 3. Mux-Empfang von langen Recovery-Arbeiten entkoppeln

- Empfang validiert und übergibt an begrenzte koordinierte Arbeit; keine komplette Replay-Übertragung im gemeinsamen Read-Loop abwarten.
- Sessionbezogene Ordnung und Input-/Trace-Marker-Zusammengehörigkeit bewahren; gepufferten Empfangsspeicher vor Wiederverwendung korrekt übernehmen.
- Recoveries je Session zusammenfassen, keine unbegrenzten `Task.Run`-Aufgaben. Langsames IPC einer Session darf fremde Eingaben nicht festhalten. Überlast/Abbruch explizit, keine still verlorenen Tasten.
- Abnahme: großer Replay und künstlich langsamer IPC-/WebSocket-Peer für A, während B kontinuierlich tippt und C sichtbar animiert. Eingabe von B darf nicht auf Abschluss von As Replay warten; Reihenfolge/Replay-Cursors bleiben korrekt.

### 4. Tatsächliche xterm-Schulden begrenzen, sichtbare Panes fair bedienen

- Persistente Anzahl ausstehender Bytes/Batches je Session und Generation; erst echte Parse-Callbacks bauen sie ab. Timeout darf keinen Parserfortschritt vortäuschen.
- Gemeinsame zeitlich begrenzte Ausgabeplanung über Sessions, nicht nur acht Millisekunden für jede einzelne Session. Parser- und Renderkosten separat messen; Chunkgrößen nach Bearbeitungszeit statt allein Bytes tunen.
- Sichtbare Terminals bleiben echt aktiv. Beliebige ANSI-/UTF-8-Bytes dürfen weder zusammengefasst im semantischen Sinn noch verworfen werden; nur Transportstücke batchingfähig zusammenhängen.
- Abnahme: kleine getrennte Drains bei angehaltenem Parser, große Bursts, 1/2/4/8 sichtbare Sessions, Replay-/Generationswechsel. Kein Überschreiten des zugesicherten In-flight-Budgets; Input und Scrollen bekommen messbar regelmäßig Hauptthreadzeit.

### 5. Verbleibende Renderer- und Hostkosten gezielt reduzieren

- Theme-/FG-Boost-Konfiguration einmal pro Renderdurchlauf bzw. Theme-Revision lesen, nicht pro Zelle über DOM-Objekte nachschlagen. Exaktes Farbergebnis, Transparenz, Ligaturen und Screenshotfähigkeit erhalten.
- Rendererwechsel, Kontextverluste, Atlas-Neuaufbau und Resize/Reflow gemeinsam mit Latenz erfassen. Keine pauschale Neuinitialisierung bei jedem Fokusereignis ergänzen.
- Erst bei belegter Host-Wartezeit Snapshot-Kopien unter `_bufferLock`, Replay-State-Trim, IPC-Ausgabebackpressure und synchrone PTY-Inputoperationen optimieren. Backpressure nicht durch Output-Dropping ersetzen.
- Kompakt auf vorhandener Diagnostik aufbauen: Input-Event/Send/Server-Empfang, Queuealter und -bytes je Grenze, submitted/parsed/presented, Recoverygrund, Renderer, echte Timeout-Samples. Kein neuer permanenter Volltrace oder zusätzliches Dashboard erforderlich.

## Verbindliche Integritäts- und Abnahmegrenzen

- Scrollback-Zeilen und Host-Byte-Retention unverändert lassen. Kein vermeintlicher Performancegewinn durch weniger Verlauf, versteckte sichtbare Panes oder Auslassen von Terminalausgabe.
- Innerhalb der verfügbaren Retention: monotone, lückenlose Session-Sequenzen; keine Duplikate; identischer Parser-/Screen-/Historyzustand nach Catch-up. Ende der Retention weiterhin ausdrücklich melden, nicht kaschieren. Endliche Speichergrenzen können keinen unendlich langsamen Client verlustfrei über beliebig lange Zeit halten.
- UTF-8-Splits, CSI/OSC/DCS, Alternate Screen, Synchronized Output, Farben, Maus-/Keyboardmodi, Resize-Ownership-Epochen und lokale/Hub-Routen abdecken. Durch Performanceänderungen keine neue Protokollannahme einschleusen.
- Performance-Abnahme auf definierter Hardware/Viewport/Renderer und gleicher Ausgabe: mehrere Wiederholungen, native Keyboard-/Wheel-Ereignisse, Input-to-present separat von Parserzeit; p50/p95/p99/max plus Timeoutquote. Vergleich erst ohne parallele Trace-Exports oder fremde Last.
- Zusätzlich längerer ruhiger Lauf, Lastende, Fokuswechsel, mehrere Minuten echter Hintergrundzustand, Reconnect und Frontend-Neuladen. Kontrolliertes dauerhaftes Heavy-Output-Szenario darf das Tippen in einer anderen sichtbaren Session nicht von deren Durchsatz abhängig machen.
- Erste Lieferungen sind kleine getrennte Änderungen in Reihenfolge 1–4. Kein großer Protokollneubau, keine pauschale Vergrößerung aller Puffer und kein Socket je Session ohne weiteren Nachweis.

## Artefakte

- Vollständiger Skill-Summary: `C:\Users\johan\.codex\artifacts\chrome-perf\20260905-015314-tlbx-e2e-layout-isolation\summary.json` (CPU-Profil, Trace und Metriken im selben Ordner).
- Unveränderter Produktlauf: `C:\Users\johan\.codex\artifacts\chrome-perf\20260905-014857-tlbx-e2e-latency-matrix\analysis-summary.json` und `cpu-profile.cpuprofile`; vollständiger Trace-Export abgebrochen, kein behaupteter erfolgreicher vollständiger Profile-Gate.
- Reproduzierbare, ignorierte Diagnoseprogramme: `Q:\repos\tlbx-3\.dev\transport-analysis\` (`WriterProbe.csproj`, `Program.cs`, `writer-probe.log`, `browser-matrix.js`, `inspect-browser.mjs`). Sie sind keine Produktänderungen.
- Quellinstanz-Logs: `Q:\repos\Jpa\.tlbx\runs\20260904T234220494Z-4926f009\stdout.log` und `stderr.log`.

Zum Abschluss der ursprünglichen Analyse nicht durchgeführt: produktiver Fix, Release, automatische Aktualisierung der installierten Instanz, formaler Langzeit-/Hardware-GPU-/Hub-Performance-Nachweis. Die bisherigen Recovery-Verbesserungen werden durch diesen Plan nicht zurückgenommen.

## Umsetzung und gezielte Verifikation (anschließender Auftrag)

Die erste Lieferung setzt die Korrektheitsfixes aus Schritten 1–4 um:

- Layout-ACKs bestätigen auch identische Inhalte; verzögerte Antworten löschen keine neueren lokalen Änderungen. Ohne neue Revision oder Änderung gibt es keinen automatischen Null-Fortschritt-Retry. Identische localStorage-Schreibvorgänge entfallen.
- Der endgültige WebSocket-Writer plant ausschließlich Session-Köpfe, erhält damit FIFO über Fokuswechsel und Recovery-Barrieren und lässt nach höchstens 32 bevorzugten Frames wartende niedrigere Prioritäten fortschreiten. Kapazitätsgrenzen und Buffer-Eigentum bleiben erhalten; ein fehlgeschlagener Writer nimmt keine weiteren Frames an.
- Nach dem initialen Sync werden Input/Trace-Marker und Recovery in begrenzten, getrennten Session-Lanes verarbeitet. Die gemeinsame Receive-Schleife wartet bei normalen Lasten nicht auf Replay oder fremde Session-IPC. Überlast wartet auf Kapazität. Wiederholte Recovery-Arbeit wird nach Full > Delta > Sichtbarkeitshinweis zusammengefasst. Schließen lässt bereits angenommene Eingaben zunächst auslaufen; Abbruchpfade sind getestet. Der initiale verbindungsweite Sync bleibt als bestehende Startbarriere erhalten.
- Tatsächliche Parser-Schulden überleben einzelne Drains und Socket-Generationen; echte Parse-Callbacks geben nur ihre eigenen Bytes frei. Die gemeinsame Ausgabeverarbeitung teilt ein Zeitbudget über Sessions. Ein fünf Sekunden blockierter Parser wird sessionlokal ersetzt und aus dem Host-Verlauf wiederhergestellt; ein Timeout erzeugt keine fiktive Byte-Gutschrift. Alte Callbacks dürfen den Ersatzparser nicht verändern.

Gezielte Tests: Layout und Mux-Frontend 59/59; Writer, Dispatcher, MuxClient und Fragment-Empfang zunächst 35/35 mit Warnungen als Fehler, danach zusätzliche Hint-Prioritätsregression im vollständigen Release-Gate. Die ursprüngliche Writer-Probe liefert nach dem Fix `sessionFifoPreserved=true`.

Realer Chrome-Fehlerinjektionslauf: Ein Parser nahm absichtlich keine Daten/Callbacks mehr an; die zweite Session blieb währenddessen aktiv. Nach 5.412 ms erfolgte die automatische Rekonstruktion, bei 523.226 an den angehaltenen Parser übergebenen Bytes. 796.640 Replay-Bytes wurden nachgeladen; anschließend waren `receivedSeq = submittedSeq = renderedSeq = 798137`, mit null Recovery-Gaps und null Datenverlustmeldungen. Neue Eingaben/Ausgaben funktionierten. Nach bestätigtem Layout: null weitere PUTs in fünf Sekunden (vorher 2.848). Der 60-Sekunden-Ruhezustand ist zusätzlich mit kontrollierten Timern im Regressionstest abgedeckt.

Artefakt: `C:\Users\johan\.codex\artifacts\chrome-perf\20260905-022715-tlbx-fixed-parser-recovery\summary.json`, Gesamturteil und Szenario `ok=true`, sämtliche angelegten Test-Sessions entfernt.

Verbleibend: Schritt 5 (Renderer-/FG-Boost-Hotpath) ist eine getrennte Optimierung, kein Bestandteil dieser Korrektheitslieferung. Native Input-to-Pixel-Messungen, lange reale Hintergrundphasen auf mehreren Geräten sowie Hardware-GPU-/Hub-Lasttests bleiben offen. Parserabschluss ist keine Bestätigung tatsächlich präsentierter Pixel; keine Behauptung, damit jede seltene Produktionslatenz beseitigt zu haben.
