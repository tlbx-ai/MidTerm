# Files und Git: Produktionsreife UI/UX

Auftrag vom 11.10.2026: alle 42 Befunde des Browseraudits einzeln lösen,
einschließlich echter Backendfunktionen, konsistenter Bedienung und
Ende-zu-Ende-Abnahme. Die Nummern entsprechen unverändert der Liste im Chat.
Ausgangsstand: installiert `10.17.35-dev`, Commit `786357d2`.

## Arbeitsweise und Abschluss

- `[ ]` offen; `[~]` in Arbeit; `[x]` implementiert und mit den genannten
  Abnahmekriterien überprüft. Eine reine Implementierung schließt keine Aufgabe.
- Pro Aufgabe Befund, Umsetzung und konkreten Nachweis erhalten. Neue Erkenntnisse
  korrigieren den Befund nachvollziehbar; kein stilles Wegdefinieren des Umfangs.
- Nacheinander arbeiten. Files-Reihenfolge: 12, 13, 14, 25, 26, 27, 11, 15, 16,
  17, 18, 19, 20, 21, 22, 23, 24, 28, 29, 3, 4, 5, 6, 9, 10.
- Danach Files vollständig integriert prüfen und über `scripts/release-dev.ps1
  -Bump minor` veröffentlichen. Versionsnummer erst beim Release bestimmen.
- Git-Reihenfolge: 1, 2, 7, 8, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40,
  41, 42. Gemeinsame Aufgaben 3–6, 9–10 anschließend ausdrücklich in Git prüfen.
- Danach Git vollständig integriert prüfen und einen zweiten Dev-Minor-Release
  veröffentlichen. PR, Tag, CI, Archive/SBOMs und Release-Ausgang nachweisen.
- Der vollständige Auftrag umfasst mindestens sieben Stunden sorgfältige Arbeit
  ab Auftragsstart. Zeit ersetzt keine Funktionsnachweise. Vor Abschluss alle
  42 Aufgaben, beide Releases, Cleanup und tatsächliche Laufzeit erneut prüfen.
- Bestehender Supervisor bleibt während der Entwicklung verfügbar. Isolierten
  Source-Dev-Loop mit getrennten stdout/stderr-Logs verwenden; Testdaten und
  Browserprofile isolieren. Keine Aktionen auf produktiven Benutzerdateien testen.
- E2E: echte Dateien und Git-Repositories; Desktop, schmale Breiten, Tastatur,
  Touch-Emulation, verschiedene Themes/Transparenzen; verspätete Antworten,
  Abbruch, fehlende Rechte, Netzwerkfehler und konkurrierende Änderungen prüfen.
- Offene Smartphone-/Betriebssystem-/Plattformnachweise ehrlich benennen.
  Ein grüner Transporttest oder DOM-Snapshot ersetzt keine gerenderte Abnahme.

Audit-Artefakte: `.tlbx/artifacts/ui-ux-audit`. Implementierungsnachweise werden
unter `.dev/file-git-production` als Logs, Screenshots und JSON gespeichert.

## Nummerierte Aufgaben

### 1. [ ] Git-Inspector innerhalb des Docks vollständig sichtbar machen

**Befund (hoch, reproduziert):** Der Standarddock ist 400 px breit, innen 399 px.
Seine beiden Mindestspalten verlangen 260 + 280 = 540 px. Bei 1440 px Fensterbreite
liegt der Inspector-Rand bei 1581 px; 141 px von Diff, Dateititel und Aktionen sind
abgeschnitten. Ursache: `.git-panel-shell`, `app.css:16272`.

**Aufgabe:** Layout nach real verfügbarer Panelbreite aufbauen; Liste und Detail
vollständig erreichbar halten. Keine bloße Verkleinerung der Schrift.

**Abnahme:** Dockbreiten 250–600 px bei Fenstern 900/1440/1920 px, lange Pfade,
Diffs und Aktionen ohne unzugänglichen Inhalt prüfen. Pixel-/Geometrienachweis.

### 2. [ ] Responsive Git-Navigation an die Panelbreite binden

**Befund (hoch, reproduziert):** Unter 980 px Fensterbreite funktioniert derselbe
400-px-Dock einspaltig mit Back; im größeren Fenster wird er abgeschnitten.
Die Media Query misst das Fenster statt der verfügbaren Sidebarfläche.

**Aufgabe:** Verlässlicher Listen-/Detailwechsel abhängig vom Container; Auswahl,
Scrollposition und Rückweg beim Resizen erhalten.

**Abnahme:** Während einer Dateiprüfung Dock/Fenster mehrfach verbreitern und
verkleinern. Inhalt, Fokus und Rückweg bleiben konsistent; kein Layoutsprungverlust.

### 3. [ ] Mehrfaches Stapeln transparenter Hintergründe beseitigen

**Befund (mittel, reproduziert):** Bei uiTransparency=65 ergibt die Palette Alpha
0,408. Drei Ebenen im Baum ergeben etwa 79 % Deckkraft, sechs im Editor etwa 96 %.
Gleiche Farbvariablen erzeugen durch Verschachtelung unterschiedliche Oberflächen.

**Aufgabe:** Pro funktionaler Fläche eine verantwortliche Hintergrundebene;
untergeordnete Layoutcontainer transparent halten. Files und Git einbeziehen.

**Abnahme:** DOM-Ebenen und gerenderte Pixel bei niedriger/mittlerer/hoher
Transparenz vergleichen; kein vom Elementnest abhängiges Verdunkeln.

### 4. [ ] Leere und befüllte Vorschau visuell konsistent halten

**Befund (mittel, reproduziert):** Leere Files-Vorschau zeigt großflächig das Bild;
nach Textauswahl wird dieselbe Fläche fast schwarz. Der Baum bleibt deutlich heller.
Die Helligkeit folgt derzeit der Rendererverschachtelung.

**Aufgabe:** Einheitliche Lesefläche für Empty, Loading, Error, Text, Bild, PDF,
Audio und Video; bewusste Unterschiede zwischen Navigation und Inhalt definieren.

**Abnahme:** Alle Zustände/Medientypen wechseln und Screenshots vergleichen.
Keine unbeabsichtigte Änderung der Flächentransparenz beim Dateiöffnen.

### 5. [ ] Transparenzpolitik für Modal, Dock und Tab vereinheitlichen

**Befund (mittel, reproduziert):** Modalhintergrund ist deckend rgb(22,24,33),
Dock und Files sind transparent. Andocken ändert den visuellen Charakter stark.

**Aufgabe:** Konsistente, lesbare Policy für dieselbe Datei in allen drei
Darstellungen. Modal-Abschirmung darf bewusst abweichen, Inhaltssurfaces nicht zufällig.

**Abnahme:** Eine Datei ohne Edit-/Scrollverlust in Tab/Modal/Dock/Fullscreen
betrachten; alle Themes und Hintergrundbild an/aus prüfen.

### 6. [ ] Lesbarkeit sekundärer Informationen auf Hintergrundbildern sichern

**Befund (mittel, reproduziert):** Gedämpfte Größen, Pfade und Metadaten verlieren
über hellen Wolken/Landschaften Kontrast. Der zufällige Bildausschnitt entscheidet
über die Lesbarkeit; hohe Transparenz verschärft das.

**Aufgabe:** Text-/Flächenkontrast in Files und Git schützen, inklusive Auswahl,
Hover, Lade-/Fehlerzuständen. Transparenz nicht global still deaktivieren.

**Abnahme:** Helle/dunkle/strukturierte Hintergründe, Themes und Transparenzstufen;
repräsentative Textkontraste messen und gerenderte Sichtbarkeit prüfen.

### 7. [ ] Git-Diffs lesbar umbrechen oder horizontal scrollen lassen

**Befund (mittel, reproduziert):** pre-wrap und overflow-wrap:anywhere zerlegen
lange Codezeilen im schmalen Inspector innerhalb von Wörtern. Einrückungen und
Zeilengrenzen werden schwer vergleichbar; keine Wahl des Umbruchmodus.

**Aufgabe:** Diffgerechter Umbruch/No-Wrap-Umschalter mit erreichbarem horizontalem
Scrollen; lange Zeilen, Tabs und Unicode korrekt darstellen.

**Abnahme:** Breite Code-/Markdownzeilen in mehreren Dockbreiten; vollständiger
Inhalt, erhaltene Einrückung und stabile Alt-/Neu-Zeilenzuordnung.

### 8. [ ] Beschriftete Git-Aktionen mit passenden Buttons darstellen

**Befund (mittel, reproduziert):** Copy und Send sind 26×26 px; Text benötigt
bereits etwa 29 px und läuft aus der Iconklasse heraus. Schmal wirkt es wie CopySend.
Zusatzbefund aus 16: Der mobile Git-Einstieg dispatcht auf das Layout-div mit
`data-action="git"`; der Klickhandler sitzt am enthaltenen Button und wird so nicht erreicht.

**Aufgabe:** Echte Textbuttons mit Abstand, Zuständen, lokalisierten Namen und
geeigneten Touchzielen; Sidebar-Iconklasse hier entfernen.

**Abnahme:** Desktop/schmal/Touch, lange Übersetzungen, Fokus und Busy/Errorzustand
ohne Überlaufen oder überlappende Klickflächen.

### 9. [ ] Vollständige Namen und Pfade trotz Ellipsis erreichbar machen

**Befund (mittel, reproduziert):** MidtermMultiagentOperation.md wird im 280-px-Baum
gekürzt, ohne Tooltip. Git-Zeilen kürzen ebenfalls Namen ohne vollständigen Pfad.

**Aufgabe:** Verlässliche Namen-/Pfadinformation per Tooltip, zugänglichem Namen
und sinnvoller Detailanzeige; nicht allein auf Hover verlassen.

**Abnahme:** Gleichnamige Dateien in tiefen Ordnern per Maus, Tastatur und Touch
eindeutig identifizieren; Pfad ohne abgeschnittene Teile kopieren können.

### 10. [ ] Dateistatus in Files und Git einheitlich codieren

**Befund (mittel, reproduziert):** Files zeigt M grün und Untracked als ?, Git M
orange und Untracked als A. Derselbe Zustand hat verschiedene Farben/Buchstaben.

**Aufgabe:** Gemeinsame semantische Statusdarstellung für modified, untracked,
added, deleted, renamed und conflict; verständliche Labels neben Farbcodierung.

**Abnahme:** Alle Zustände in echten Git-Fixtures erzeugen und in beiden Views
vergleichen; Farbenblindheit/Screenreaderinformation berücksichtigen.

### 11. [x] Ausgewählte Dateien auf schmalen Bildschirmen sichtbar öffnen

**Befund (hoch, reproduziert):** Bei 390 px bleibt der Baum sichtbar, Vorschau
display:none. Dateiklick markiert/lädt die Datei, öffnet aber weder Detail noch Modal.

**Aufgabe:** Vollständiger schmaler Tree→Detail→Back-Ablauf mit Auswahl-/Scroll-
und Entwurferhalt. File-/Medienaktionen müssen dort ebenfalls erreichbar sein.

**Abnahme:** Mehrere Dateien und Medientypen bei 390/768 px öffnen, bearbeiten,
zurückkehren und Größe wechseln. Zusätzlich Touch-Emulation prüfen.

**Nachweis 11.10.2026:** Containerabhängige Baum-/Detailansicht bis 768 px mit
echter Zurückaktion. Wiederöffnen derselben Auswahl erhält denselben Editor,
Entwurf, Caret und Scroll; ein Wechsel zu einer anderen Datei verwendet den
Save/Discard/Cancel-Schutz. Resize erhält die Ansicht ohne Neuladen.
Mobile Tabs werden jetzt bei Sessionauswahl synchronisiert. Die visuelle Abnahme
fand zusätzlich unsichtbare native Audiocontrols durch Padding und eine
Editorhöhe, die Metadaten/Status aus der Vorschau schob; beide Layoutfehler behoben.
14 echte Chromium-Touchabläufe bei 390/768 px bestehen einschließlich Disk-Save,
Cancel, Desktopwechsel, Baumscroll, PNG-Originaldownload, Binär- und WAV-Vorschau.
37 Bearbeitungsregressionen und acht große-Datei-Abläufe bestehen weiterhin.
Screenshots/geometrische Messungen: `.dev/file-git-production/task-11-verified`,
Regressionsdaten `task-11-regression-final` und `task-11-large-regression`.
Typecheck, ESLint, Stylelint und Localecheck ohne Fehler; bestehende Warnungen
über andere fehlende Übersetzungen bleiben sichtbar. Reale Geräte/OS-Tastatur
sind durch Touch-Emulation nicht nachgewiesen und bleiben in der Files-Gesamtabnahme.

### 12. [x] Ungespeicherte Änderungen beim Dateiwechsel schützen

**Befund (hoch, reproduziert):** Marker im Editor, andere Datei auswählen, erste
erneut öffnen: Marker verloren, keine Rückfrage. Das Experiment schrieb nichts auf Disk.

**Aufgabe:** Explizite Entscheidung Speichern/Verwerfen/Abbrechen vor Verlust;
gescheitertes Speichern verhindert den Wechsel. Entwürfe sinnvoll erhalten.

**Abnahme:** Wechsel per Baum, Pfad, Verlauf, Tab, Session und Schließen; jeweils
alle drei Entscheidungen und Save-Fehler prüfen. Kein stiller Entwurfverlust.

**Nachweis 11.10.2026:** Gemeinsamer Dokument-Editzustand mit expliziter
Save/Discard/Cancel-Entscheidung, Schutz vor Navigation bei Savefehler und
Browser-Unload-Schutz. Elf reale Chromiumabläufe bestehen einschließlich
Disk-Schreibnachweis, Modalwechsel/-schließen, Sessionwechsel/-schließen,
Tabwechsel und abgebrochenem Browserreload. Save während weiterer Eingaben
behält den jüngeren Entwurf (Unitregression). Nachweise:
`.dev/file-git-production/task-12-navigation-final/summary.json`, zugehörige
Screenshots, `editState.test.ts`. Neue Verlaufs-/Dockabläufe aus 13/15 werden
in der integrierten Files-Abnahme erneut gegen diesen Schutz geprüft.
Zusatznachweis aus 16: Wechsel vom File-Dock zu Git ruft denselben Schutz auf;
Cancel, Save-Fehler und Save vor dem Panelwechsel sind mit realen Git-Buttons
abgenommen. Commands verwendet ebenfalls die gemeinsame Close-Entscheidung;
sein Einstieg ist im bestehenden Produkt verborgen und wurde nicht als sichtbarer
Browserablauf behauptet. Doppelte direkte Store-/DOM-Teardowns wurden entfernt.

### 13. [x] Editzustand beim Andocken, Undocken und Refresh erhalten

**Befund (hoch, reproduziert):** Modal→Dock lädt Diskinhalt neu; Refresh ebenfalls.
Beide Wege verwarfen den Marker ohne Rückfrage. resetEditState löscht Editzustand.

**Aufgabe:** Präsentationswechsel überträgt Dokumentzustand, Cursor und Scroll;
Refresh bei Dirty-Datei fragt nach bzw. bietet kontrollierte Konfliktbehandlung.

**Abnahme:** Modal/Dock/Fullscreen-Wechsel mit Änderungen, Dirty-Refresh,
Save-Fehler, Cancel und Browser-Back; Zustand und Pfadidentität bleiben erhalten.

**Nachweis 11.10.2026:** Modal und Dock verschieben denselben gerenderten
Dokumentknoten statt ihn neu zu laden. Editoridentität, Text, Auswahl und
vertikaler/horizontaler Scroll bleiben erhalten; Refresh wartet auf die explizite
Dirty-Entscheidung, Speicherfehler ersetzen den Editor nicht. Fullscreen→Dock
und Browser-Back mit Cancel bestehen. Achtzehn integrierte Chromiumfälle
einschließlich Aufgabe 12 bestehen:
`.dev/file-git-production/task-13-back-final/summary.json` und Screenshots.
Typecheck, fokussiertes ESLint und acht Editor-/Navigationstests bestehen.

### 14. [x] Veraltete Dateianfragen dürfen neuere Auswahl nicht überschreiben

**Befund (hoch, reproduziert):** Agents.md-Anfrage 700 ms verzögert, dann CLAUDE.md
ausgewählt: Baum zeigt CLAUDE.md, Vorschau nach beiden Antworten Agents.md.

**Aufgabe:** Aktuelle Dokumentidentität/Anfragegeneration vor jedem Render prüfen;
veraltete Requests abbrechen oder verwerfen, auch bei Medien und Sessionwechsel.

**Abnahme:** Vertauschte Antwortreihenfolge, Abbruch und Fehler für schnelle
A→B→C-Wechsel; Titel, Inhalt, Aktionen und Speicherziel gehören immer zu C.
Zusätzlich das Andocken während noch laufender Datei-/Metadatenanfragen prüfen:
die Antwort muss im aktuellen sichtbaren Ziel erscheinen, kein versteckter
Container darf nachträglich wieder mit altem Inhalt befüllt werden.

**Nachweis 11.10.2026:** Dokumentanfragen besitzen unveränderliche Datei-/Session-
Identität, AbortSignal und einen mitbewegten Zielcontainer. Überholte Antworten
und Fehler werden auch nach Body-Decoding verworfen. Dateilink-Auflösung nimmt
bereits beim Klick eine Navigationsgeneration und die Session des angeklickten
Terminals auf. Alte Metadaten dürfen keinen neuen Viewer öffnen. Tree-Auswahl
wird nur für die letzte akzeptierte Navigation übernommen. 25 reale
Chromiumfälle bestehen, einschließlich Text→Binär→Text, verspäteter Metadaten,
Speicherzielprüfung, Schließen und Andocken während Laden:
`.dev/file-git-production/task-14-final/summary.json`. Unitregression mit einem
Transport, der Abort ignoriert, bestätigt alte Erfolgs- und Fehlerantworten.
Typecheck, fokussiertes ESLint und 14 relevante Unit-/Navigationstests bestehen.

### 15. [x] Durchgängigen Rückweg und echte Ordnerhierarchie anbieten

**Befund (mittel, reproduziert):** .. erscheint nur nach Navigation im Modal,
nicht beim direkten Öffnen von agent. Dateiöffnung entfernt Liste ohne Rückweg.

**Aufgabe:** Back/Forward/Up mit nachvollziehbarer Historie und sicheren erlaubten
Roots. Rückweg vom Dokument zum Ordner bewahrt Auswahl und Scrollposition.

**Abnahme:** Direkter Unterordner, Ordner→Datei→Back, mehrere Ebenen, gelöschte
Historienziele und unerlaubte Parentpfade; keine Verwechslung History/Parent.

**Nachweis 11.10.2026:** Getrennte Back/Forward/Up-Aktionen und Browser-Back
verwenden einen echten Verlauf. `..` verwendet den serverseitig ermittelten,
autorisierten Elternordner. Rückkehr aus Dokumenten stellt Ordnerauswahl und
Scrollposition wieder her; Save/Discard/Cancel bleibt vor jeder Navigation wirksam.
Ein gelöschtes Verlaufsziel zeigt einen Fehler, ohne den sicheren Rückweg zu verlieren.
Die neue Hierarchie-API prüft logische und physisch aufgelöste Pfade; eine isolierte
Dateifreigabe erlaubt keinen Elternordner. Die vorhandene Allowlist und Rootprüfung
verwenden auf Unix nun case-sensitive Vergleiche, sodass ein anders geschriebener
Nachbarpfad keine Rootfreigabe erbt. 19 Backendtests und 25 fokussierte Frontendtests
bestehen unter Windows. Neun neue reale Browserfälle und 37 Editregressionen bestehen.
Nachweise: `.dev/file-git-production/task-15-final/summary.json`, visuell geprüfter
Screenshot `restored-directory.png`, `task-15-edit-regression/summary.json`,
`task-15-unit/navigation-and-access.trx`. Der Unix-Testzweig benötigt noch echte
Unix-Ausführung in der integrierten Plattformabnahme. Ordner im Dock folgt separat in 16.
Die integrierte Junction-Prüfung aus 16 fand danach abweichende Alt-Lesewege:
List/Tree/View/Download ließen den Ausbruch noch zu. Check/Resolve/List/Tree/View/
Download und Document/Save verwenden jetzt dieselbe logische/physische Prüfung;
Metadaten werden am geprüften Pfad gelesen. Eine bewusst gewählte Junction-CWD
bleibt zulässig, eine Junction aus der bestehenden Root heraus wird abgewiesen.

### 16. [x] Ordner-Andocken tatsächlich unterstützen

**Befund (mittel, reproduziert):** Aktiver Dockbutton bei Ordner führt nur zu
Directories not supported in dock und ersetzt die nutzbare Ordneransicht.

**Aufgabe:** Ordnernavigation auch im Dock mit denselben Aktionen/Fehlerzuständen
bereitstellen; kein Button, dessen normales Ziel nur eine Fehlermeldung ist.

**Abnahme:** Ordner öffnen, andocken, navigieren, Datei öffnen, zurück, undocken;
Historie, Auswahl und Refresh funktionieren Ende zu Ende.

**Nachweis 11.10.2026:** Ordnerlisten und die bestehende Navigationsleiste werden
gemeinsam in den Dock übertragen. Unterordner und Dateien bleiben beim Öffnen
gedockt; Back/Forward/Up, Dirtyentscheidungen und Refresh verwenden dieselben
Lade-/Editregeln. Die bestehende Session-Dockablage bewahrt jetzt zusätzlich
Verlauf, Ordnerauswahl und Scroll; Restore bleibt an die aktuelle Session gebunden.
Refresh entdeckt echte neu angelegte Dateien und bewahrt die Auswahl. Undocken
erhält dieselbe Ansicht und ihren Verlauf. Der Wechsel zu Git schützt den Entwurf
vor dem Teardown. Windows-Junctions wurden tatsächlich erzeugt: ein Ausbruch
blockiert alle sechs Lesewege mit 403 sowie Check/Resolve ohne Metadaten;
eine ausdrücklich gewählte Junction-Root bleibt lesbar. Die Namen eigener Links
bleiben in Elternlisten sichtbar, ohne Inhalt/Metadaten ihres verbotenen Ziels zu lesen.
19 Directory-/Dock-/Root-/Git-Wechselabläufe, 37 Editregressionen, acht große-Datei-
und 14 Touchabläufe bestehen auf dem aktuellen Source-Stand. 673 Frontendtests
(136 Dateien, plus Kitty-Protokolltest) und 41 Backendtests bestehen; Typecheck,
ESLint und Diffcheck ebenfalls. Screenshot `refreshed-directory-dock.png` geprüft.
Artefakte: `.dev/file-git-production/task-16-accepted`, `task-16-edit-final`,
`task-16-large-final`, `task-16-mobile-final`, `task-16-unit`.

### 17. [x] Eigene Navigation für den Files-Tab bereitstellen

**Befund (mittel, Erwartungslücke):** Keine editierbare Adresse, Breadcrumbs,
Up/Back/Forward oder expliziter Rootwechsel; Startpunkt folgt Session-CWD.

**Aufgabe:** Filemanager-Navigation mit editierbarem Pfad/Breadcrumbs und Roots
innerhalb serverautorisierter Bereiche. CWD-Nachführung nachvollziehbar gestalten.

**Abnahme:** Navigation ohne Terminaleingabe, Pfadpaste, Back/Forward, ungültiger
Pfad, CWD-Wechsel und Zugriff außerhalb erlaubter Roots sicher behandeln.

**Nachweis 11.10.2026:** Eigene Adresszeile für Ordner/Dateien, Back/Forward/Up,
serverseitige Breadcrumbs und Auswahl autorisierter Roots. Roots stammen aus CWD,
Session-Repositories und bereits erfolgreich gelesenen Ordnern; Dateifreigaben
erteilen keine Elternfreigabe. Erfolgreich besuchte Ordner bleiben beim CWD-Wechsel
erreichbar. Die Ansicht folgt CWD-Wechseln nicht mehr kommentarlos: der explizite
CWD-Button verwendet denselben Entwurfsschutz. Fehlende/unerlaubte Ziele erhalten
die vorhandene Ansicht; verspätete Verzeichnisantworten überschreiben keine neuere
Navigation. Baum-Auswahl, Expansion und Scroll werden je besuchtem Ordner erhalten.
Dateipfade öffnen den tatsächlichen Inhalt und bei erlaubtem Parent dessen Baum.
Doppelklick öffnet Ordner; normales Aufklappen bleibt vorhanden. Tab-Aktivierung
zerstört keinen bestehenden Baum mehr. Die visuelle Abnahme fand einen bisherigen
Git-Seiteneffekt: Lesen eines anderen Repositories setzte dessen CWD-Bindung um.
Dieser Teardown ist entfernt; Dateibrowsing fragt den passenden Status explizit ab.
Elf reale Navigationsfälle einschließlich echtem Terminal-CWD-Wechsel und zusätzlicher
Repo-Root bestehen. 37 Edit-, 19 Directory/Dock/Root-, 14 Touch- und acht große-Datei-
Regressionsfälle bestehen ebenfalls (89 Browserfälle). 673 Frontendtests, 23 Backend-
Navigation-/Allowlist-/GitWatcher-Tests, Typecheck, ESLint, Stylelint und Diffcheck
bestehen; Desktop-/Mobile-Screenshots visuell geprüft. Nachweise:
`.dev/file-git-production/task-17-accepted`, `task-17-edit`, `task-17-mobile`,
`task-17-directory-final`, `task-17-large-final`, `task-17-unit`.

### 18. [x] Sichtbarkeit von ignorierten/versteckten Dateien kontrollierbar machen

**Befund (mittel, reproduziert/Code):** Files filtert nach Git-Pfaden und blendet
z.B. .git/.tlbx aus; Ordner-Modal zeigt sie. Kein Label oder Umschalter erklärt das.

**Aufgabe:** Konsistente explizite Filter für Hidden/Ignored zwischen Files,
Modal und Dock. Normale Dateiansicht darf Git-Ignore nicht mit Nichtexistenz verwechseln.

**Abnahme:** Git- und Nicht-Git-Ordner, leere/ignorierte/versteckte Verzeichnisse;
Umschalter und Filteranzeige korrekt, keine heimlich fehlenden Dateien.

**Nachweis 11.10.2026:** Gemeinsame serverseitige Verzeichnisauflistung ersetzt
die abweichenden Baum-/Modal-Filter. Native Hidden-Attribute und Git-eigene Ignore-
Prüfung liefern dieselben Flags und Filterzahlen; ignorierte Dateien sind standardmäßig
sichtbar. Normale Ordner wie `bin`/`node_modules`, leere Ordner und Git-Metadaten
werden nicht mehr durch eine unsichtbare Skipliste entfernt. Shared Checkboxen und
persistierte Browserpräferenz gelten für Tab/Modal/Dock; aufgeklappte Unterordner
werden mit erneuert. Filterwechsel erhalten den aktuellen Editor samt Entwurf;
Fehler erhalten die vorhandene Liste und eine nutzbare Wiederholungsaktion.
Hidden/Ignored sind beschriftet, tatsächlich leere und vollständig weggefilterte
Listen haben unterschiedliche Meldungen. Filter im Ordner-Viewer bleiben beim
Scrollen erreichbar. Gitabfragen verwenden begrenzte Argumentbatches, vorhandene
Service-User-Ausführung und explizite Nichttreffer; keine verlusthafte Pfaddekodierung.
Tests decken Unicode/Leerzeichen, getrackte Dateien, getrackte Inhalte in ignorierten
Ordnern, leere Ignore-Ordner und Windows-Hidden ab. Zehn reale neue Browserfälle
und alle 89 bisherigen Fälle bestehen (99); 673 Frontendtests plus Kitty-Protokoll,
15 Backendtests und eine zusätzliche Mixed-Directory-Abnahme bestehen. Typecheck,
ESLint, Stylelint und Diffcheck bestehen; Desktop/Dock-Paint visuell geprüft.
Nachweise: `.dev/file-git-production/task-18-final-all`, `task-18-navigation-accepted`,
`task-18-directory`, `task-18-mobile`, `task-18-edit`, `task-18-large`, `task-18-unit`.
Ein paralleler Source-Start zeigte zeitweise unvollständig geladenes CSS; zusätzlich
wurde der Navigations-Testselektor nach den neuen Checkboxen auf die Adresszeile
präzisiert. Der stabile Einzelablauf besteht; Asset-Hotsync bleibt Workflow-Follow-up.

### 19. [x] Dateibaum aktuell halten und gezielt refreshen

**Befund (mittel, Code):** treeData cached Unterordner dauerhaft; Reopen lädt
nicht erneut. Rootgleichheit behält Cache, Files hat keinen Refreshbutton.
Zusatzbefund aus 15: Der globale Datei-Metadatencache verwendet auch auf Unix
case-insensitive Keys; bei dort verschiedenen Dateinamen darf er keine Einträge vermischen.

**Aufgabe:** Aktuelle Dateiänderungen und manuellen Refresh unterstützen;
Auswahl/Expansion/Fokus/Scroll bei inhaltlichen Aktualisierungen bewahren.

**Abnahme:** Dateien extern erstellen/umbenennen/löschen, offenen Baum refreshen;
mehrere Sessions und große Ordner ohne Pollingsturm oder DOM-Neuaufbauverlust.

**Nachweis 11.10.2026:** Expliziter Refresh sowie kurz gebündelte FileSystemWatcher-
Ereignisse über einen abbrechbaren SSE-Leseweg. Offene Unterordner werden in Batches
bis vier geladen; sichtbare Files-Tabs beobachten ihren Root, inaktive Tabs/Sessions
schließen den Stream und brechen laufende Refresh-/Unterordnerabfragen ab. Im Leerlauf
gibt es keine periodischen Listingrequests. Wiederaufklappen liest den Ordner erneut.
Der Baum reconciled nach vollständigem Pfad; Handler lesen gepatchte Metadaten und
unveränderte Zeilen behalten ihre DOM-Identität. Auswahl/Expansion/Fokus/Scroll und
der aktuelle Editor samt Entwurf bleiben erhalten. Der ungenutzte direkte Root-
Resetpfad ist entfernt. Directory-Metadaten umgehen gezielt veraltete Cacheeinträge;
Cachekeys verwenden nun die Plattform-Case-Regel. Tests prüfen sofortige Größe/
Delete-Änderungen und den Unix-Case-Zweig (Windows-Ausführung aktuell nachgewiesen).
Sechs neue reale Browserfälle mit 600 Root-Dateien bestehen: Änderungen im offenen
Unterordner, Zeilenidentität/Fokus, Reopen, echter Watcher, zusammengefasster 20-Dateien-
Burst, Rename/Delete und zwei Sessions. Die erste Inaktivprüfung fand eine nachlaufende
Childabfrage; expliziter Abort repariert sie, erneute Prüfung besteht. Alle 99 bisherigen
Browserfälle bestehen ebenfalls (105 insgesamt). 673 Frontendtests plus Kitty und zehn
Backend-Metadata-/Visibilitytests bestehen; Typecheck/ESLint/Diffcheck ebenfalls.
Screenshot `refreshed-tree.png` visuell geprüft. Artefakte:
`.dev/file-git-production/task-19-final`, `task-19-edit`, `task-19-visibility`,
`task-19-navigation`, `task-19-directory`, `task-19-mobile`, `task-19-large`, `task-19-unit`.

### 20. [ ] Auswahl, Öffnen und Mehrfachauswahl klar trennen

**Befund (mittel, Erwartungslücke):** Ordnerliste öffnet sofort auf Einzelklick;
keine dauerhafte Auswahl oder Shift/Ctrl-Mehrfachauswahl. Baumvorschau und Liste
verwenden verschiedene, unerklärte Auswahlmodelle.

**Aufgabe:** Verlässliche Auswahl mit Mehrfachauswahl, Tastatur, Touch und
explizitem Öffnen; Preview darf Auswahl nicht mit destruktiven Aktionen vermischen.

**Abnahme:** Einzelauswahl, Bereiche, Ctrl/Meta-Toggle, Doppelklick/Enter,
Touch-Auswahl und Aktionen auf exakt der ausgewählten Menge prüfen.

### 21. [ ] Echte Dateioperationen und Kontextmenüs implementieren

**Befund (mittel, Erwartungslücke):** Nur Vorschau, Inhaltskopie und Download;
keine serverseitigen Rename/Move/Duplicate/Delete/New File/New Folder/Copy-Paste.

**Aufgabe:** Autorisierte Backendoperationen mit klaren Konflikt-/Overwrite-
Entscheidungen, recoverable Delete und Undo wo angeboten; keine UI-Scheinaktionen.

**Abnahme:** Echte Diskprüfung jeder Operation; Mehrfachauswahl, Unicode,
Namenskollision, Rechtefehler, symlinks, Rootgrenzen und Undo prüfen.
Für Link-Mutationen den erlaubten Linkeintrag und seinen Elternordner prüfen;
ein Link-Delete darf den Zielinhalt nicht löschen. Die kanonische Leseprüfung aus
15/16 darf nicht unverändert als „Link löschen = Ziel löschen“ verwendet werden.

### 22. [ ] Dateiansicht, Sortierung, Filter und Metadaten vervollständigen

**Befund (mittel, Erwartungslücke):** Nur Ordner-zuerst/Namen/Größen; kein Datum,
Typ, Sortierung, Details-/Symbolansicht oder lokale Filterleiste.

**Aufgabe:** Sinnvolle Details-/Symbolansicht, Sortierung nach Name/Datum/Typ/Größe,
lokaler Filter und relevante Metadaten; Zustände pro Arbeitskontext erhalten.

**Abnahme:** Neueste Datei/PDFs finden, natürliche Namenssortierung, leere Treffer,
große Ordner und Ansichtwechsel mit erhaltener Auswahl prüfen.

### 23. [ ] Files-Trennflächen und Viewer-Dock anpassbar machen

**Befund (mittel, Code/reproduziert):** Baum fix 280 px, File-Dock fix 400 px ohne
Resize; Git hat dagegen einen Griff. Lange Namen und breite Inhalte leiden.

**Aufgabe:** Bedienbare, begrenzte Split-/Dockgrößen mit persistierter Präferenz,
Tastaturzugang und sauberem schmalem Layout.

**Abnahme:** Resize, Reload, kleine Fenster, kombinierte Panels und Terminal-
Geometrie prüfen; keine Inhalte über Rand, keine unerwartete Session-Übernahme.

### 24. [ ] Einheitliche Vorschau-/Editmodi anbieten

**Befund (mittel, reproduziert/Code):** Markdown in Files sofort Editor, andere
Texte Readonly mit Edit, Modal stets Textarea; Markdown bleibt Quelltext.

**Aufgabe:** Konsistenter Preview/Edit-Wechsel, Markdown-Rendering plus Source,
erkennbare Schreibbarkeit und Dirtyzustand in Tab/Modal/Dock.

**Abnahme:** Markdown/Code/Text/Readonly, Modewechsel mit Entwurf, Syntaxanzeige,
keine unbeabsichtigten Writes; Tastatur und Screenreader-Modusinformation prüfen.

### 25. [x] Gleichzeitige Dateiveränderungen beim Speichern schützen

**Befund (hoch, Code):** Save sendet nur Pfad/Inhalt; File.WriteAllTextAsync prüft
keine gelesene Version. Ein Agent kann zwischen Lesen und Speichern Änderungen
machen, die ein späteres Speichern still überschreibt.

**Aufgabe:** Serverseitige Versionsprüfung und sicherer Schreibpfad; Konflikt mit
Reload/Compare/gezieltem Overwrite, Entwurf bleibt bis zur Entscheidung erhalten.

**Abnahme:** Zwei Clients und externe Änderung zwischen Read/Save; kein Lost
Update, sauberer Conflictstatus, neuer/gelöschter Pfad und parallele Saves prüfen.

**Nachweis 11.10.2026:** `/api/files/document` liefert Inhalt und an den
aufgelösten Pfad gebundene SHA-256-Version aus demselben Snapshot. Save benötigt
`expectedVersion`, serialisiert konkurrierende Writes und publiziert eine
vollständig vorbereitete Datei; aktuelle und ersetzte Bytes werden geprüft.
Konflikt erhält den Entwurf. Compare zeigt Entwurf und echten Diskinhalt;
Overwrite benötigt die ausdrücklich geprüfte Version und scheitert bei einer
erneuten Änderung. Reload ersetzt erst nach Bestätigung und aktualisiert die
Save-Basis. Gelöschte Dateien werden nicht automatisch angelegt. BOM/Encoding
und normale CRLF-Dateien bleiben erhalten; partielle Texte sind nicht editierbar.
32 Windows-Backendtests bestehen (16 Dokumentfälle plus vorhandene Filetests),
14 fokussierte Frontendtests, Typecheck/ESLint/Stylelint und 32 echte Chromium-
Flows bestehen. Nachweise: `.dev/file-git-production/task-25-unit/task-25-final.trx`,
`task-25-final/summary.json`, `conflict-comparison.png`. OpenAPI-Vertrag und
generierte TS-Typen sind synchron. Linux/macOS-Dateisystemannahmen bleiben
Teil der Plattform-/Releaseabnahme; der aktuelle Lauf ist Windows-Evidenz.

### 26. [x] Speichern mit sichtbaren Erfolgs-/Fehlerzuständen versehen

**Befund (mittel, Code):** Fehler werden geloggt bzw. Save wieder aktiviert;
keine brauchbare Anzeige für Permission/Netzwerkfehler oder unsicheren Speicherstand.

**Aufgabe:** Saving/Saved/Unsaved/Error mit konkreter Abhilfe; Entwurf behalten,
Doppelrequests verhindern, keine falsche Erfolgsmeldung.

**Abnahme:** HTTP403/409/500, Offline, verspätete Antwort und Retry; nur tatsächlicher
Disk-Erfolg bestätigt Speicherung, Fehler blockieren verlustbringende Navigation.

**Nachweis 11.10.2026:** Ready/Unsaved/Saving/Saved/Error/Unknown werden aus
dem Dokumentzustand angezeigt. Rechte-, belegte/gelöschte Datei-, Speicherplatz-
und Verbindungsfehler haben konkrete lokalisierte Meldungen. Retry und Download
des tatsächlichen Entwurfs stehen bei Fehlern bereit. Ein verlorener Response
nach echtem Disk-Commit bleibt Unknown; erst bestätigter idempotenter Retry
setzt Saved. Während Save verhindern Busy-Zustand und gemeinsame Pending-Promise
Doppelwrites; spätere Keystrokes bleiben Unsaved. Toolbar-Beschriftung stammt
ebenfalls aus diesem Zustand, kein veraltetes Saving-Label. 37 echte Chromium-
Flows bestehen einschließlich Exportdatei-/Diskprüfung und Lost-Ack-Simulation;
18 fokussierte Tests, Typecheck und ESLint bestehen. Nachweise:
`.dev/file-git-production/task-26-final/summary.json`, `save-outcome-unknown.png`.

### 27. [x] Große Textdateien überall konsistent und sicher behandeln

**Befund (mittel, Code):** Modal begrenzt initial auf 500 KiB, Files lädt alles.
Modal-Ausschnitt ist editierbar, obwohl vollständiges Laden fürs Save nötig ist.

**Aufgabe:** Einheitliche begrenzte Vorschau/Nachladen; partielle Inhalte nicht
als vollständiges Dokument speichern; klare Größen-/Encodinginformation.

**Abnahme:** Große UTF8/Unicode/BOM-Dateien, abgeschnittene Codepoints,
Nachladefehler und Memoryverhalten in allen Views prüfen.

**Nachweis 11.10.2026:** Gemeinsame 512-KiB-Vorschau in Files/Modal/Dock;
bytegenaue Vor-/Zurücknavigation hält UTF-Codepoints und CRLF zusammen.
Partielle Dokumente besitzen keine Save-Version und bleiben schreibgeschützt.
Vollständiges Editieren ist explizit bis 32 MiB möglich; größere Dateien bleiben
seitenweise lesbar und als Original herunterladbar. Größen-/Encoding-/EOL-Angabe
und Bytebereich stehen in allen Ansichten; Nachladefehler erhalten den aktuellen
Ausschnitt und die Wiederholungsaktion. Auch nach Save/Reload werden Metadaten erneuert.
22 Backend-Dokumenttests bestehen, darunter UTF-8/UTF-16-BOM, Seitengrenzen und
eine 64-MiB-Datei mit weniger als 12 MiB gemessener Backend-Allokation für die Vorschau.
23 Frontendtests, acht reale große-Datei-Browserabläufe und die bisherigen
37 Bearbeitungsabläufe bestehen. Chromium-JS-Heap im 64-MiB-Vorschautest:
7.07 auf 7.26 MB nach GC (kein Nachweis des gesamten Browser-Prozessspeichers).
Screenshots wurden visuell geprüft; DOM-Vorschau und HTTP-Inhalte bleiben begrenzt.
Artefakte: `.dev/file-git-production/task-27-final/summary.json`,
`task-27-regression/summary.json`, `task-27-unit/task-27-pages.trx`.

### 28. [ ] Dateinavigation und Viewer vollständig per Tastatur bedienen

**Befund (mittel, reproduziert/Code):** Baum/Liste bestehen aus klickbaren divs
ohne Fokus/Tree-Semantik/Pfeile. Modal hat keine Dialogsemantik/Fokusführung;
Editor versteckt den Fokusrahmen.

**Aufgabe:** Tree-/Listen-/Dialogsemantik, roving focus, Pfeile/Home/End/Enter,
Typ-to-select, sichtbarer Fokus, Fokusreturn und korrekter Dialog-Fokusbereich.

**Abnahme:** Kompletter Dateiablauf ohne Maus; Screenreaderstruktur, Escape/Tab,
Modalwechsel, Resize und keine Weitergabe von Navigationskeys an Terminal prüfen.

### 29. [ ] Ausreichende Bedienziele für schmale und Touchansichten schaffen

**Befund (mittel, reproduziert):** Baumzeilen circa 25 px, Viewericons 28×28 px,
Close etwa 14×24 px. Schmale Ansicht vergrößert die Ziele nicht.

**Aufgabe:** Touchgeeignete Ziele bei erhaltener Desktopdichte; Chevron/Zeile/
Toolbaraktionen klar trennen, Bedienelemente nicht kollidieren lassen.

**Abnahme:** Pointer coarse/Touch-Emulation, lange Namen, dichtes Panel,
Toolbar-Wrapping und Fehlklickfreiheit über Zielgeometrie/Interaktion prüfen.

### 30. [ ] Vollständigen Stage–Review–Commit-Ablauf in Git implementieren

**Befund (hoch, Erwartungslücke):** Keine direkten Datei-/Gruppenaktionen zum
Stage/Unstage und kein Commitfeld/Button; nur vorgeschlagene Terminalbefehle.

**Aufgabe:** Echte repo-bound Backendaktionen für Stage/Unstage/Commit mit
Identitäts-/Fehler-/Busybehandlung; Review und Stagingzustand nachvollziehbar halten.

**Abnahme:** Echte Repos mit gemischt staged/unstaged/untracked, selektiver Commit,
Committext, fehlender Gitidentität, Hooks/Fehlern und Statusaktualisierung prüfen.

### 31. [ ] Git-Aktionen und Befehle an das ausgewählte Repository binden

**Befund (hoch, Code):** Multi-Repo-Sidebar erzeugt relative git-Befehle ohne -C.
Inspector zeigt tlbx-2, Terminal-CWD Jpa: Ausführung arbeitet im falschen Repo.

**Aufgabe:** Serverseitig validierte Repoidentität für alle Operationen; verbleibende
Copybefehle explizit -C. Auswahlwechsel darf laufende Aktionen nicht umadressieren.

**Abnahme:** Zwei Repos mit gleichen Pfaden, abweichende CWDs, Switch während
Request, manipuliertes Repo und nicht gebundener Root: exakt ein erlaubtes Ziel.

### 32. [ ] Unsichere Send-to-Terminal-Automatik ersetzen

**Befund (hoch, Code):** Send pastet Text und Return an aktives Terminalprogramm;
bei Codex/Claude/TUI ist das keine Shellausführung. Discard kann als Send erscheinen.

**Aufgabe:** Gitoperationen durch eigene Backendverträge ausführen. Optionale
Terminalübergabe klar als Copy/Insert ohne verstecktes Enter und ohne Agentturn.

**Abnahme:** Shell, beschäftigtes TUI und Agent Controller; direkte Gitaktion
funktioniert unabhängig davon, keine fremden Prompts/Keys/unerwarteten Mutationen.

### 33. [ ] Shellabhängige Befehlsquotierung korrekt lösen

**Befund (mittel, Code):** quoteGitPath backslash-escaped Sonderzeichen unabhängig
von Shell. Dollar/Backtick/Quote sind in PowerShell anders zu behandeln als Bash.

**Aufgabe:** Backendoperationen als getrennte argv; Copy/Insert-Darstellung für
bekannte Shell korrekt, unbekannte Shell ehrlich begrenzen.

**Abnahme:** Pfade mit Spaces/Unicode/$/Backtick/Quotes und --ähnlichen Namen in
PowerShell und Bash. Kein zusätzlicher Befehl, keine Expansion, exakt richtiger Pfad.

### 34. [ ] Inhalt ungetrackter Dateien in Git prüfbar machen

**Befund (hoch, reproduziert):** WhatsAppPermissions.md zeigt No patch text available
und +0/-0. Show diff schlägt git diff vor, das untracked-Inhalt nicht zeigt.

**Aufgabe:** Neue Textdatei als Addition gegen leere Basis, Binärdatei als
passende Vorschau/Metadaten; Stage nach tatsächlicher Inhaltsprüfung.

**Abnahme:** Text/Binär/leer/groß/untracked-Verzeichnis, keine Nullstatistik als
scheinbar inhaltslose Datei; Review→Stage→Commit Ende zu Ende.

### 35. [ ] Untracked und Added in Git unterscheiden

**Befund (mittel, reproduziert):** statusToLetter liefert für untracked/added A;
VS Code verwendet U für untracked. Farbe und +0/-0 verschleiern Indexzustand.

**Aufgabe:** U/A mit korrekter Statusbeschriftung und Index-/Worktreezuordnung,
kongruent zu Aufgabe 10.

**Abnahme:** Neue Datei vor/nach Stage, weitere Änderung nach Stage, Unstage;
korrekte Gruppe/Buchstabe/Diff und erreichbare Statusbeschreibung.

### 36. [ ] Diffprüfung und selektives Staging vervollständigen

**Befund (mittel, Erwartungslücke):** Unified Patch ohne Alt-/Neuansicht,
Zeilennummern, Wortmarkierung, Änderungsnavigation oder Hunk-/Zeilenstaging.

**Aufgabe:** Inline und Side-by-side, echte Zeilenzuordnung/Wortdiff und Next/Prev;
Stage/Unstage ausgewählter Hunks/Zeilen mit verifizierter Patchanwendung.

**Abnahme:** Mehrere Hunks, partielle Auswahl, CRLF/Unicode/Rename/Deletion,
veralteter Diff und parallele Änderungen: korrekter Indexinhalt und Konflikterkennung.

### 37. [ ] Merge-Commits nachvollziehbar gegen Parents vergleichen

**Befund (mittel, reproduziert/Code):** Merge 786357d2 zeigt Metadaten/Text ohne
Patches, obwohl first-parent-Vergleich Dateien enthält. Normales git show erklärt
die Mergebesonderheit nicht; Parentauswahl fehlt.

**Aufgabe:** Expliziter Defaultvergleich und Parentwahl mit korrekten Dateipatches;
Rootcommit und normale Commits ebenfalls verständlich behandeln.

**Abnahme:** Normaler/Merge-/Rootcommit, beide Parents und leerer Vergleich;
Dateiliste/Statistik/Diff entsprechen tatsächlichem Gitvergleich.

### 38. [ ] Git-Dateilisten flexibel und effizient bedienen

**Befund (mittel, Erwartungslücke):** Nur Tree; Ordnerzeilen nicht einklappbar,
keine Flatlist/Suche/Mehrfachauswahl. Tiefenpfade erzeugen lange starre Listen.

**Aufgabe:** Tree/List-Umschaltung, Folderfolding, Filter, Mehrfachauswahl und
Tastaturnavigation; Zustände bei WebSocketaktualisierung erhalten.

**Abnahme:** Viele Änderungen, tiefe Ordner, gleiche Namen, Filter und Bulkaktionen;
Auswahl/Focus/Scroll stabil ohne unnötigen vollständigen DOM-Neuaufbau.

### 39. [ ] Git-Laden, fehlendes Repo und Abfragefehler unterscheiden

**Befund (mittel, reproduziert/Code):** Erstöffnung von gebundenem Repo zeigt
Not a git repository vor Antwort. RESTfehler werden null und teilen diesen Zustand.

**Aufgabe:** Explizit Loading/Ready/No Repo/Error/Stale mit Retry; letzte gute
Daten nicht als aktuell ausgeben, Fehlerdetails sinnvoll übersetzen.

**Abnahme:** Verzögerung, 401/403/404/500, Offline/Reconnect und Repoentfernung;
kein falsches No-Repo, Retry funktioniert und Authablauf bleibt korrekt.

### 40. [ ] Branch-, Remote-, Stash- und Konfliktabläufe tatsächlich anbieten

**Befund (mittel, Erwartungslücke):** Branch/Ahead/Behind/Stash nur Anzeigen;
keine Branchwahl, Fetch/Pull/Push oder Konfliktauflösung im Gitworkflow.

**Aufgabe:** Repo-bound Branchwechsel/-erstellung, Fetch/Pull/Push mit expliziten
Remotes/Fehlern, Stashverwaltung und echte Konfliktauflösung einschließlich Abschluss.

**Abnahme:** Isolierte lokale Bare-Remotes/Clones, Divergenz/Authfehler/Dirtybranch,
Stashkonflikt und Mergeconflict. Kein Forcepush/Reset als versteckter Normalpfad.

### 41. [ ] Clean-Zustand kompakt halten und Verlauf nutzbar machen

**Befund (mittel, reproduziert):** Working tree clean füllt große Fläche;
Historie unten bekommt kleinen eigenen Scrollbereich, Inspector bleibt daneben.

**Aufgabe:** Kompakte Cleananzeige, sinnvoll nutzbare History/Listfläche und
bedarfsgerechter Inspector. Verlauf ohne künstliche Leerflächen durchsuchen.

**Abnahme:** Clean/Dirty/Selectionwechsel, lange History und kleine Panels;
Historypagination, Scroll und Fokus ohne verdrängte Inhalte.

### 42. [ ] Git-Texte, Lokalisierung und Informationshierarchie vereinheitlichen

**Befund (niedrig/mittel, Code/reproduziert):** worktree, Suggested terminal
commands und Back fest englisch neben lokalisierten Labels; Pfade mehrfach,
volle Parenthashes raumgreifend und Commitbetreff gleichzeitig gekürzt.

**Aufgabe:** Einheitliche lokalisierte UItexte und klare Index/Working-Treebegriffe;
Titel priorisieren, redundante Pfadboxen entfernen, Hashdetails bei Bedarf erreichbar.

**Abnahme:** Englisch/Deutsch/lange Übersetzungen, schmale Panels, vollständiger
Betreff/Pfad/Hash erreichbar; keine Platzhalter oder technischen Backendlabels.

## Release- und Abschlussnachweise

- Files-Minor: offen. PR / Version / Commit / CI / Assets / E2E-Nachweise ergänzen.
- Git-Minor: offen. PR / Version / Commit / CI / Assets / E2E-Nachweise ergänzen.
- Finale 42-Punkte-Abnahme: offen; Code, gerenderte UI und echte Dateisystem-/Git-
  Ergebnisse je Aufgabe prüfen. Fehlende Nachweise bleiben offen.
- Cleanup: offene Devprozesse, Browser, Testsessions und Branches prüfen;
  sichere unmittelbare Bereinigungen erledigen, echte Folgepunkte gezielt erfassen.
