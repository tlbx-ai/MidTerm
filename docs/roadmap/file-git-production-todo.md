# Files und Git: Produktionsreife UI/UX

Auftrag vom 11.10.2026: alle 42 Befunde des Browseraudits einzeln lösen,
einschließlich echter Backendfunktionen, konsistenter Bedienung und
Ende-zu-Ende-Abnahme. Die Nummern entsprechen unverändert der Liste im Chat.
Ausgangsstand: installiert `10.17.35-dev`, Commit `786357d2`.

Ergänzung vom 13.10.2026: abschließender strenger UI-/UX-Designpass für Files
und Git als Aufgabe 43. Bestehende Nummern und Abnahmen bleiben erhalten.

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
- Vor der abschließenden integrierten Abnahme Aufgabe 43 für Files und Git
  umsetzen; die laufende Funktionsarbeit wird dafür nicht unterbrochen.
- Danach Git und die visuell überarbeiteten Files vollständig integriert prüfen und einen zweiten Dev-Minor-Release
  veröffentlichen. PR, Tag, CI, Archive/SBOMs und Release-Ausgang nachweisen.
- Der vollständige Auftrag umfasst mindestens sieben Stunden sorgfältige Arbeit
  ab Auftragsstart. Zeit ersetzt keine Funktionsnachweise. Vor Abschluss alle
  43 Aufgaben, beide Releases, Cleanup und tatsächliche Laufzeit erneut prüfen.
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

### 1. [x] Git-Inspector innerhalb des Docks vollständig sichtbar machen

**Befund (hoch, reproduziert):** Der Standarddock ist 400 px breit, innen 399 px.
Seine beiden Mindestspalten verlangen 260 + 280 = 540 px. Bei 1440 px Fensterbreite
liegt der Inspector-Rand bei 1581 px; 141 px von Diff, Dateititel und Aktionen sind
abgeschnitten. Ursache: `.git-panel-shell`, `app.css:16272`.

**Aufgabe:** Layout nach real verfügbarer Panelbreite aufbauen; Liste und Detail
vollständig erreichbar halten. Keine bloße Verkleinerung der Schrift.

**Abnahme:** Dockbreiten 250–600 px bei Fenstern 900/1440/1920 px, lange Pfade,
Diffs und Aktionen ohne unzugänglichen Inhalt prüfen. Pixel-/Geometrienachweis.

**Nachweis 12.10.2026:** Die tatsächliche Git-Dock-Bodybreite ist der CSS-Container.
Unter 540 px zeigen Liste und Inspector einzeln den vollständig verfügbaren
Raum; breite Panels zeigen beide Spalten. Leere Inspectorflächen bleiben in
der schmalen Liste verborgen. Lange Dateipfade, Commitauthors und Parenthashes
brechen innerhalb ihres eigenen Inhaltsbereichs um. 21 reale Dateilayouts bei
250/300/400/539/540/541/600 px und drei Fensterbreiten plus neun normale Commit-
Inspectoren bestehen: kein Inspector-/Buttonüberlauf, echter Diffinhalt und
erreichbare Copy-/Detailsaktionen inklusive Clipboard-/Vollpfadprüfung.
Screenshots von Datei/Commit bei schmalen/breiten Docks sind visuell geprüft.
Null Terminal-Inputframes; 707 Frontendtests plus Kitty/Typecheck/ESLint/Stylelint
bestehen. Evidenz: `.dev/file-git-production/git-task-1-final/summary.json`,
`git-task-1-verify.*.log`. Die separaten Copy/Send-Buttonformate und Diff-
Umbruchmodi bleiben ausdrücklich Aufgaben 8 beziehungsweise 7.

### 2. [x] Responsive Git-Navigation an die Panelbreite binden

**Befund (hoch, reproduziert):** Unter 980 px Fensterbreite funktioniert derselbe
400-px-Dock einspaltig mit Back; im größeren Fenster wird er abgeschnitten.
Die Media Query misst das Fenster statt der verfügbaren Sidebarfläche.

**Aufgabe:** Verlässlicher Listen-/Detailwechsel abhängig vom Container; Auswahl,
Scrollposition und Rückweg beim Resizen erhalten.

**Abnahme:** Während einer Dateiprüfung Dock/Fenster mehrfach verbreitern und
verkleinern. Inhalt, Fokus und Rückweg bleiben konsistent; kein Layoutsprungverlust.

**Nachweis 12.10.2026:** Listen-/Detailansicht ist von der Auswahl getrennt;
Zurück erhält die ausgewählte Datei und den bereits geladenen Diff. CSS meldet
den tatsächlichen Container-Modus; ein begrenzter Layoutcontroller erhält
Scroller und führt den Fokus aus ausgeblendeten Bereichen zu Rückweg/Auswahl.
Observer/Listener werden bei Suspend/Destroy beendet. Browser-Scroll-Anchoring
ist für diese Scroller deaktiviert, damit ein Reflow die Leseposition nicht
verschiebt. Git verwendet den vorhandenen Pane-Resize-Helper mit Pointer-
Capture, Tastatur, Grenzen und gespeicherter Breite; alte globale Mouse/Touch-
Listener sind entfernt. Unter 769 px ist Git ein Vollflächen-Overlay ohne
Terminal-Marginreservierung; Rückkehr stellt die Desktopbreite wieder her.
Drei reale Abläufe bestehen: Back/Enter mit gleicher Auswahl/DOM/Scroll und
null Refetches; drei echte Tastatur-/Fenster-Resizezyklen mit erhaltenem Fokus;
Pointerresize, gespeicherte 600 px, 390-px-Overlay und Desktopreturn. Null
Terminal-Inputframes. 30 Inspector-Geometrien bleiben grün, ebenso sieben
Files-/Resize-/Followerfälle, 19 Ordner-/Dirty-/Git-Dockwechsel und 707
Frontendtests plus Kitty/Typecheck/ESLint/Stylelint. Mobile und Desktop-
Screenshots sind visuell geprüft. Evidenz: `git-task-2-fourth/summary.json`,
`git-task-2-layout-regression`, `git-task-2-files-regression`,
`git-task-2-directory-regression`, `git-task-2-verify.*.log` unter
`.dev/file-git-production`. Initialer Overlayfokus und umfassende Git-
Tab-/Escape-Navigation werden zusätzlich in Aufgabe 38 abgenommen.

### 3. [x] Mehrfaches Stapeln transparenter Hintergründe beseitigen

**Befund (mittel, reproduziert):** Bei uiTransparency=65 ergibt die Palette Alpha
0,408. Drei Ebenen im Baum ergeben etwa 79 % Deckkraft, sechs im Editor etwa 96 %.
Gleiche Farbvariablen erzeugen durch Verschachtelung unterschiedliche Oberflächen.

**Aufgabe:** Pro funktionaler Fläche eine verantwortliche Hintergrundebene;
untergeordnete Layoutcontainer transparent halten. Files und Git einbeziehen.

**Abnahme:** DOM-Ebenen und gerenderte Pixel bei niedriger/mittlerer/hoher
Transparenz vergleichen; kein vom Elementnest abhängiges Verdunkeln.

**Nachweis 12.10.2026:** Files-Tab, File-Dock, Modal und Git-Panel besitzen je
einen Inhalts-Hintergrundowner; Baum, Previewbody, Textstack, Viewer/Editor,
Scroller, Git-Inspector, Patchflächen und Commitbody tragen keine weitere
Basisfarbe. Chrome/Controls und semantische Diff-/Auswahlmarkierungen bleiben
eigene bewusste Flächen. Der reservierte Terminalhintergrund malt innerhalb
der Terminal-/Agent-Panels und liegt nicht mehr unter File-/Git-Docks. 108 echte
DOM-/Pixelproben bestehen in Dark/Light/Solarized-Dark/-Light bei 0/65/90 %:
Baum, Source, Editor, Modal, Dock, Gitliste, Inspector, Diff und Commitbody.
Jede Lesefläche hat eine Hintergrundebene; Screenshot-RGB stimmt mit einmaliger
Alpha-Komposition über einem tatsächlich geladenen PNG überein (Toleranz 3/255).
Screenshots wurden visuell geprüft; Source-Settings/Bild und Sessions sind
zurückgesetzt. 689 Frontendtests, Kitty, Typecheck/ESLint/Stylelint bestehen.
Evidenz: `.dev/file-git-production/task-3-full/summary.json`, `task-3-verify.*.log`.
Zusatzbefund: der Dock-Terminal-Seam zeigt bei DPR 1,25/2 dieselben Deltas
5/33 sowohl mit neuer als auch ursprünglicher Wrapperregel. Als vorhandener
Renderer-Folgepunkt im Tracker erfasst; eine Seam-Reparatur wird nicht behauptet.

### 4. [x] Leere und befüllte Vorschau visuell konsistent halten

**Befund (mittel, reproduziert):** Leere Files-Vorschau zeigt großflächig das Bild;
nach Textauswahl wird dieselbe Fläche fast schwarz. Der Baum bleibt deutlich heller.
Die Helligkeit folgt derzeit der Rendererverschachtelung.

**Aufgabe:** Einheitliche Lesefläche für Empty, Loading, Error, Text, Bild, PDF,
Audio und Video; bewusste Unterschiede zwischen Navigation und Inhalt definieren.

**Abnahme:** Alle Zustände/Medientypen wechseln und Screenshots vergleichen.
Keine unbeabsichtigte Änderung der Flächentransparenz beim Dateiöffnen.

**Nachweis 12.10.2026:** Die Hintergrundownership aus Aufgabe 3 gilt auch für
Empty/Loading/Error und PNG/Audio/Video/PDF. 40 echte Prüfungen in vier Themes
bei 65 % Transparenz bestehen: gleiche Root-/Pixelkomposition für leere,
ladende, fehlerhafte und gefüllte Leseflächen sowie Bilder/Audio/Video. PNG ist
tatsächlich decodiert; WAV und ein im Browser erzeugtes WebM werden abgespielt.
Der native PDF-Viewer malt seine echte Dokumentseite (mehr als 90.000 weiße
Pagepixel im Testlauf); sein App-Container besitzt dieselbe Hintergrundebene.
PDF-Papier, Videoframes und native Playercontrols sind bewusste Dokumentflächen;
sie werden nicht als zusätzliche Layout-Hintergründe gezählt. Screenshots von
Bild, Video und fertigem PDF sind geprüft. Zoomcontrols bekommen auch auf
breiten Coarse-Pointer-Geräten 44-px-Ziele. Source-Bild/Settings sind restauriert.
Evidenz: `.dev/file-git-production/task-4-final/summary.json`; die gemeinsame
Containeränderung ist in `0721b2a0` abgenommen. Stylelint besteht.

### 5. [x] Transparenzpolitik für Modal, Dock und Tab vereinheitlichen

**Befund (mittel, reproduziert):** Modalhintergrund ist deckend rgb(22,24,33),
Dock und Files sind transparent. Andocken ändert den visuellen Charakter stark.

**Aufgabe:** Konsistente, lesbare Policy für dieselbe Datei in allen drei
Darstellungen. Modal-Abschirmung darf bewusst abweichen, Inhaltssurfaces nicht zufällig.

**Abnahme:** Eine Datei ohne Edit-/Scrollverlust in Tab/Modal/Dock/Fullscreen
betrachten; alle Themes und Hintergrundbild an/aus prüfen.

**Nachweis 12.10.2026:** Der File-Modal verwendet denselben Pane-Backgroundtoken
wie Files und Dock. Sein bewusster Modal-Backdrop dimmt die Umgebung; Fullscreen
besitzt einen Wallpaper-/Theme-Backdrop, der darunterliegende Appinhalte verdeckt.
Die Inhaltsfarbe und Alpha sind in Tab, Modal, Dock und Fullscreen identisch.
32 echte differenzielle Pixelprüfungen in vier Themes mit Bild an/aus bestehen:
temporär transparent gemessener Untergrund plus einmalige Inhaltskomposition
entsprechen dem echten Screenshot. Derselbe Editor/Entwurf, Cursorbereich und
Scrollwert 500 bleiben durch Fullscreen/Dock/Undock erhalten; Disk bleibt bis
zur ausdrücklichen Entscheidung unverändert. Screenshots aller Darstellungen
sind geprüft. Source-Settings/Bild und Sessions sind restauriert. Stylelint besteht.
Evidenz: `.dev/file-git-production/task-5-first/summary.json`.

### 6. [x] Lesbarkeit sekundärer Informationen auf Hintergrundbildern sichern

**Befund (mittel, reproduziert):** Gedämpfte Größen, Pfade und Metadaten verlieren
über hellen Wolken/Landschaften Kontrast. Der zufällige Bildausschnitt entscheidet
über die Lesbarkeit; hohe Transparenz verschärft das.

**Aufgabe:** Text-/Flächenkontrast in Files und Git schützen, inklusive Auswahl,
Hover, Lade-/Fehlerzuständen. Transparenz nicht global still deaktivieren.

**Abnahme:** Helle/dunkle/strukturierte Hintergründe, Themes und Transparenzstufen;
repräsentative Textkontraste messen und gerenderte Sichtbarkeit prüfen.

**Nachweis 12.10.2026:** Files-/Git-Leseflächen und deren Chrome haben eine
lokale Mindestdeckkraft 0,88; globale UI-/Terminaltransparenz bleibt unverändert.
Eine reine Lesepalette erhält Themefarben soweit möglich und schützt primäre,
sekundäre, gedämpfte, Syntax- und Statusfarben gegen Wallpaperextreme sowie
Auswahl/Hover. Der Slider erklärt die begrenzte Leseflächentransparenz in allen
zehn Sprachen. 16 numerische Palettefälle prüfen vier Themes und 0/65/90/100 %
einschließlich semantischer Hintergründe. 720 tatsächliche Browsermessungen
verwenden aufgelöste Textfarben und Screenshot-Untergründe bei hellen/dunklen/
strukturierten Bildern, vier Themes und 0/65/90 %. Größen, Pfade, Metadaten,
Syntax, Auswahl, Hover, Loading, Error und beide Diff-Markierungen bestehen;
Minimum 4,979355:1 ohne Rundung der Abnahmeschwelle 4,5:1. Screenshots sind geprüft.
108 Background-/Git-Diff-/Commitproben und 32 Modal/Dock/Fullscreen-/Entwurf-
Regressionsproben bestehen weiter. 705 Frontendtests plus Kitty, Typecheck,
ESLint und Stylelint bestehen. Quelle der Schwelle und Messmethode:
https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html.
Evidenz: `.dev/file-git-production/task-6-final/summary.json`,
`task-6-{surface,policy}-regression/summary.json`, `task-6-verify.*.log`.

### 7. [x] Git-Diffs lesbar umbrechen oder horizontal scrollen lassen

**Befund (mittel, reproduziert):** pre-wrap und overflow-wrap:anywhere zerlegen
lange Codezeilen im schmalen Inspector innerhalb von Wörtern. Einrückungen und
Zeilengrenzen werden schwer vergleichbar; keine Wahl des Umbruchmodus.

**Aufgabe:** Diffgerechter Umbruch/No-Wrap-Umschalter mit erreichbarem horizontalem
Scrollen; lange Zeilen, Tabs und Unicode korrekt darstellen.

**Abnahme:** Breite Code-/Markdownzeilen in mehreren Dockbreiten; vollständiger
Inhalt, erhaltene Einrückung und stabile Alt-/Neu-Zeilenzuordnung.

**Nachweis 12.10.2026:** Default ist No-Wrap mit fokussierbaren horizontalen
Scrollregionen; ein lokalisierter, gespeicherter Umbruchschalter gilt für alle
Hunks der Ansicht. Änderungszeichen haben eine eigene beim Scrollen sichtbare
Spalte; Code beginnt an seiner eigenen Tabposition (4), ohne Präfixverschiebung.
Wrap toggelt ausschließlich CSS/ARIA; gleiche DOMzeilen/Hunkheader und exactes
Difftext-/Kind-Ordering bleiben erhalten. Der vorige horizontale Offset kehrt
beim Abschalten des Umbruchs zurück. Reale CRLF-/Tab-/Unicode-/Literal-HTML-
Fixtures in 250/400/600 px bestehen: gleiches Tab-/Vier-Space-Glyph-X, einzeiliges
No-Wrap, echte Mehrzeilen-Wrap-Geometrie, native Tastaturscrolls, unveränderte
Diskbytes, null Gitwrites und null Terminal-Input. Reload erhält den Modus.
Screenshots sind visuell geprüft. Drei Navigation-/Cache-/Resizefälle und 720
echte Kontrastmessungen bestehen (Minimum 4,979355:1), außerdem 707 Frontendtests
mit Kitty/Typecheck/ESLint/Stylelint. Die Surface-/Pfad-/Statusharnesses nutzen
nun den echten Git-Resize-Griff statt nach Appstart localStorage zu manipulieren;
damit sind auch beim ersten Matrixfall Git-Metadaten und Liste sichtbar.
Evidenz: `.dev/file-git-production/git-task-7-accepted/summary.json`,
`git-task-7-navigation-regression`, `git-task-7-contrast-complete`,
`git-task-7-verify.*.log`. Sichtbare Zeilennummern/Side-by-side und partielle
Stagingaktionen bleiben der ausdrücklich weiter offenen Aufgabe 36 zugeordnet.

### 8. [x] Beschriftete Git-Aktionen mit passenden Buttons darstellen

**Befund (mittel, reproduziert):** Copy und Send sind 26×26 px; Text benötigt
bereits etwa 29 px und läuft aus der Iconklasse heraus. Schmal wirkt es wie CopySend.
Zusatzbefund aus 16: Der mobile Git-Einstieg dispatcht auf das Layout-div mit
`data-action="git"`; der Klickhandler sitzt am enthaltenen Button und wird so nicht erreicht.

**Aufgabe:** Echte Textbuttons mit Abstand, Zuständen, lokalisierten Namen und
geeigneten Touchzielen; Sidebar-Iconklasse hier entfernen.

**Abnahme:** Desktop/schmal/Touch, lange Übersetzungen, Fokus und Busy/Errorzustand
ohne Überlaufen oder überlappende Klickflächen.

**Nachweis 12.10.2026:** Copy/Einfügen sind normale lokalisierte Textbuttons mit
36-px-Desktop-/44-px-Coarse-Zielen; Befehle und Aktionen stehen in eigenen
Zeilen mit erreichbaren Fokusmarkierungen. Copy und Einfügen zeigen Busy,
bestätigten Erfolg oder konkreten Fehler und bleiben retryfähig. Lange
Fehlertexte umbrechen vollständig im Panel. Die frühere Send-Funktion ist
entfernt: Einfügen verwendet den bestehenden bestätigten Pastevertrag ohne
Enter und ist für explizite Controller-/nicht verfügbare Terminals gesperrt.
Ein zusätzlicher Grenztest schützt Controller trotz vorhandenem unbenutztem
Terminalstate. Mobiler Git-Handler klickt den tatsächlichen Button; das zuvor
bei sichtbaren Tabs versteckte Menü ist erreichbar. Suchbutton und Menü haben
eigene Fläche; ein redundanter kleiner-480-px-Paddingreset ist entfernt.
Vier reale EN/DE/Bengali-Browserabläufe bestehen: Labels bei 250 px, Keyboard-
Clipboard, Busy/Permissionfehler/Retry, reale Paste-ACK/503 ohne Enter/Provider-
Turn sowie echter mobiler Menü-Einstieg und mindestens 44 px bei 390 px. Desktop,
Touch und Fehlerscreenshots sind visuell geprüft. 14 mobile Files-Regressions-
abläufe und 708 Frontendtests plus Kitty/Typecheck/ESLint/Stylelint bestehen.
Evidenz: `.dev/file-git-production/git-task-8-complete/summary.json`,
`git-task-8-mobile-files-regression`, `git-task-8-verify.*.log`. Repo-bound
Schreibaktionen und deren echte Shell/TUI/Controller-Gesamtabnahme bleiben
Aufgaben 30–33; sie werden nicht durch Pastebuttons ersetzt.

### 9. [x] Vollständige Namen und Pfade trotz Ellipsis erreichbar machen

**Befund (mittel, reproduziert):** MidtermMultiagentOperation.md wird im 280-px-Baum
gekürzt, ohne Tooltip. Git-Zeilen kürzen ebenfalls Namen ohne vollständigen Pfad.

**Aufgabe:** Verlässliche Namen-/Pfadinformation per Tooltip, zugänglichem Namen
und sinnvoller Detailanzeige; nicht allein auf Hover verlassen.

**Abnahme:** Gleichnamige Dateien in tiefen Ordnern per Maus, Tastatur und Touch
eindeutig identifizieren; Pfad ohne abgeschnittene Teile kopieren können.

**Nachweis 12.10.2026:** Files-/Directory-/Gitzeilen haben vollständige native
Pfade als Tooltip und zugänglichen Namen. Details in Auswahlleiste, Preview,
Modal, Dock und Git-Inspector zeigt ungekürzte auswählbare Namen/Pfade und
kopiert die tatsächlichen Pfade; kein Hoverzwang. Gleichnamige Dateien in tiefen
Unicode-/Space-Ordnern bestehen in vier echten Browser-Szenarien einschließlich
390 px, Fokusreturn und Clipboardprüfung; keine Filesystem-Mutationsrequests.
Der Test fand einen Backendfehler: Porcelain-v2 wurde an allen Spaces zerlegt.
Status liest nun NUL-Datensätze mit begrenztem Feldsplit; Rename konsumiert die
separate Originalpfad-Record. Drei C#-Prüfungen schützen Spaces/Unicode/Controls,
Renamepaare und Konfliktpfade ohne Trim. Reale Git-Fixtures bestätigen beide
vollständigen Pfade im UI. Sieben Keyboard-/Dialog-/Dirtyabläufe und 705
Frontendtests plus Kitty/Typecheck/ESLint/Stylelint bestehen. Source-Instanz mit
neuem Backend läuft separat; Supervisor unverändert.
Evidenz: `.dev/file-git-production/task-9-native-ui/summary.json`,
`task-9-keyboard-regression/summary.json`, `task-9-native/task-9-parser.trx`,
`task-9-verify.*.log`. Breite/Touchdetails wurden visuell geprüft.

### 10. [x] Dateistatus in Files und Git einheitlich codieren

**Befund (mittel, reproduziert):** Files zeigt M grün und Untracked als ?, Git M
orange und Untracked als A. Derselbe Zustand hat verschiedene Farben/Buchstaben.

**Aufgabe:** Gemeinsame semantische Statusdarstellung für modified, untracked,
added, deleted, renamed und conflict; verständliche Labels neben Farbcodierung.

**Abnahme:** Alle Zustände in echten Git-Fixtures erzeugen und in beiden Views
vergleichen; Farbenblindheit/Screenreaderinformation berücksichtigen.

**Nachweis 12.10.2026:** Gemeinsame Darstellung für Files und Git: M geändert,
U ungetrackt, A hinzugefügt, D gelöscht, R umbenannt und ! Konflikt; auch C/T
werden eindeutig behandelt. Gemeinsame semantische Themefarben, ausgeschriebene
lokalisierte Tooltip-/ARIA-Beschreibungen und Status im tastatur-/touchbedienbaren
Detailsdialog. Ordnerstatus beschreibt enthaltene Änderungen; gelöschte Dateien
bleiben aus dem physischen Dateibaum entfernt und markieren den vorhandenen
Elternordner, während Git den gelöschten Eintrag zeigt. Backend-Aggregation
priorisiert Konflikte und bewahrt Unix-Backslashes sowie Case-Unterschiede.
48 echte Zustandspaare in vier Themes und Deutsch/Englisch bestehen inklusive
echtem Mergekonflikt, Unicode-Rename und separaten Index-/Worktree-Einträgen.
Chrome-AX bestätigt volle Pfadnamen und ausgeschriebene Statusbeschreibungen.
390-px-Touch und tatsächliches Stage/Unstage unterscheiden U/A; keine vom UI
ausgelösten Datei-Mutationsrequests. Die Bildprüfung fand einen zusätzlichen
Dialogfehler in hellen Themes: alte dunkle Dialogflächen und transparente
Buttontextfarben passten nicht zur Lesepalette. Details-/Dateioperations-,
Unsaved- und Vergleichsflächen verwenden jetzt die geschützte Lesefläche;
Dangeraktionen behalten eine rote Text-/Randmarkierung. 84 tatsächliche
Dialogtext-/Button-Kontrastmessungen bestehen, Minimum 7,277336:1; Screenshots
von hell/dunkel und Touch sind geprüft. 707 Frontendtests plus Kitty/Typecheck/
ESLint/Stylelint und sechs C#-Status-/Pfadtests bestehen. Native CI nimmt die
neuen Git-Statusprüfungen in ihre Windows/Linux/macOS-Matrix auf.
Evidenz: `.dev/file-git-production/task-10-final/summary.json`,
`task-10-native/task-10-status.trx`, `task-10-verify.*.log`,
`task-10-dialog-css.*.log`. Git-Aufgabe 35 bleibt bis zur eigenen Workflow-
Abnahme mit Review/Diff und Stagingaktionen offen.

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

### 20. [x] Auswahl, Öffnen und Mehrfachauswahl klar trennen

**Befund (mittel, Erwartungslücke):** Ordnerliste öffnet sofort auf Einzelklick;
keine dauerhafte Auswahl oder Shift/Ctrl-Mehrfachauswahl. Baumvorschau und Liste
verwenden verschiedene, unerklärte Auswahlmodelle.

**Aufgabe:** Verlässliche Auswahl mit Mehrfachauswahl, Tastatur, Touch und
explizitem Öffnen; Preview darf Auswahl nicht mit destruktiven Aktionen vermischen.

**Abnahme:** Einzelauswahl, Bereiche, Ctrl/Meta-Toggle, Doppelklick/Enter,
Touch-Auswahl und Aktionen auf exakt der ausgewählten Menge prüfen.

**Abgenommen (2026-10-11):** Gemeinsames Auswahlmodell für Dateibaum und
Ordnerliste: Ctrl/Meta-Toggle, vorwärts/rückwärts gerichtete Shift-Bereiche,
Ctrl+Shift, Ctrl+A, Pfeile/Home/End/Leertaste, sichtbare Touch-Checkboxen und
explizites Enter/Öffnen. Einzelklick in der Ordnerliste wählt; Doppelklick öffnet.
Die Baumvorschau bleibt per Einzelklick erreichbar; Modifier/Checkboxen ändern
nur die Auswahl. Mehrere ausgewählte Einträge deaktivieren das einzelne Öffnen.
Kopierte Pfade und echte Downloads enthalten exakt die gewählte Menge; Ordner
werden nicht als Datei-Download angeboten. Clipboard-Verweigerung ist sichtbar.
Die vorhandenen Entwurfsentscheidungen schützen explizites Öffnen. Auswahl und
Shift-Anker überleben Verlauf, Dock-Wechsel, Refresh und Sitzungsrückkehr;
verschwundene Einträge werden vor Aktionen entfernt. Keyed Ordnerzeilen und
lineare Auswahl-/Metadatenzugriffe ersetzen den bisherigen HTML-Neuaufbau.
13 neue reale Chromium-Fälle einschließlich 390px Touch, echter Clipboard-
Auslese und Diskvergleich der Downloads bestehen; alle 105 bisherigen Fälle
bestehen weiterhin (118 insgesamt). 678 Frontendtests plus Kitty-Selbsttest,
Typecheck, ESLint, Stylelint und Diffcheck bestehen. Neue Labels sind in allen
zehn Sprachen vorhanden. Der strikte Locale-Check bleibt wegen unveränderter
Alt-Lücken außerhalb der neuen Labels rot (Baselinevergleich ohne neue Lücken).
Evidenz: `.dev/file-git-production/task-20-final-selection`,
`task-20-accepted-{directory,navigation,refresh}`,
`task-20-regression-{edit,large,mobile,visibility}` und `task-20-unit`.
Reale Mobilgeräte und die vollständige ARIA-/Touch-Zielgrößen-Abnahme aus
28/29 bleiben gesonderte Prüfungen. Kein Phasenrelease vor Files-Abschluss.

### 21. [x] Echte Dateioperationen und Kontextmenüs implementieren

**Befund (mittel, Erwartungslücke):** Nur Vorschau, Inhaltskopie und Download;
keine serverseitigen Rename/Move/Duplicate/Delete/New File/New Folder/Copy-Paste.

**Aufgabe:** Autorisierte Backendoperationen mit klaren Konflikt-/Overwrite-
Entscheidungen, recoverable Delete und Undo wo angeboten; keine UI-Scheinaktionen.

**Abnahme:** Echte Diskprüfung jeder Operation; Mehrfachauswahl, Unicode,
Namenskollision, Rechtefehler, symlinks, Rootgrenzen und Undo prüfen.
Für Link-Mutationen den erlaubten Linkeintrag und seinen Elternordner prüfen;
ein Link-Delete darf den Zielinhalt nicht löschen. Die kanonische Leseprüfung aus
15/16 darf nicht unverändert als „Link löschen = Ziel löschen“ verwendet werden.

**Zwischenstand (2026-10-11, noch nicht abgenommen):** C#-Operationen für
Create/Rename/Move/Copy/Duplicate/Delete/Restore sind mit realen Dateisystem-
änderungen vorhanden; dauerhafte Receipts verhindern blindes Wiederholen nach
verlorener Antwort. Konflikte, Keep both, explizites Ersetzen einschließlich
Ordnern, verschachtelte Auswahl, fehlende Restore-Eltern und Rollback bei
Windows-Dateisperren sind geprüft. Junctions werden als Einträge kopiert und
entfernt, ohne ihren externen Zielinhalt zu lesen oder zu löschen. Ein Native-
Cleanup-Test fand die Gefahr einer bereits entfernten Junction-Zieldirectory;
die Fixture-Cleanup entfernt Links jetzt vor den übrigen eigenen Verzeichnissen.
Windows-Service-Zugriffe verwenden verifizierten mthost-PID plus Startzeit,
übernehmen dessen Account auch bei deferred Download-Results und trennen
Recovery-Vaults pro Windows-SID. Öffentliche GET/POST-Verträge und erzeugte
Types sind synchron. 61 native Prüfungen bestehen; ein echter Unix-Modus-Test
ist auf Windows ausdrücklich übersprungen. Sieben HTTP-Fälle gegen die echte
Source-Instanz verifizieren Diskbytes, Konflikte, Recovery und Rootgrenzen.
Evidenz: `.dev/file-git-production/task-21-unit/operations-backend-v3.trx`
und `task-21-api-first/summary.json`. Das beweist die interaktive Windows-
Source-Identität; die reale LocalSystem-Grenze ist noch separat zu prüfen.

**Vor Abnahme weiterhin nötig:** Bedienbare Aktionen/Kontextmenüs, Copy/Cut/
Paste, Konflikt- und Recovery-Dialoge, Entwurfsschutz für betroffene offene
Dateien, vollständige Browserabnahme. Originale ACLs/Ownership bei Restore
und fehlenden Eltern brauchen gezielte Prüfung/Erhalt. Lange Delete-/Copy-
Staging darf währenddessen nicht als Git-Worktree-Inhalt stagebar sein;
Quarantäne-/Publikationsorte müssen dafür vor der UI-Abnahme überprüft werden.
Cross-volume- und Unix/macOS-Filesystem-/Case-Akzeptanz fehlen weiterhin.
Kein Files-Minor vor dem vollständigen Phasenabschluss.

**Weitere Backendprüfung (2026-10-11, weiterhin offen):** Recovery verschiebt
jetzt das echte Dateisystemobjekt statt eines Inhaltsklons; dadurch bleiben
Windows-ACL, Besitzer, Links und alternative Streams erhalten. Bei einem anderen
Storage-Volume liegt der private Payload auf dem Ursprungsvolume, in Git-Fällen
im administrativen Git-Verzeichnis. Windows nutzt MoveFileEx ohne impliziten
Cross-Volume-Copy-Fallback; die .NET-Implementierung kann einen Move sonst als
Copy/Delete ausführen. Private Kopiercontainer liegen bei Git-Zielen ebenfalls
außerhalb des Worktrees. Cross-Volume-Move publiziert die geprüfte Kopie und
behält das Original in Recovery. Snapshotdaten stellen Rechte fehlender Restore-
Eltern wieder her; SACL wird dabei nicht angefordert. Der Test fand und reparierte
hier einen unbeabsichtigten SeSecurityPrivilege-Request. Native Windows-Copy
bewahrt auch Alternate Data Streams. Überlappende Auswahl wird über ausgewählte
Vorfahren eingeordnet, statt quadratische Filesystem-Metadataprobes auszuführen.
64 native Prüfungen bestehen, ein Unix-Test bleibt explizit übersprungen.
Ein echter ReFS-Q:/NTFS-C:-Test prüft EXDEV, ACL/Owner, Cross-Volume-Move und
Git-Status ohne Recovery-/Stagingdateien; NTFS prüft geschützte ACL und ADS.
Sieben echte Source-HTTP-/Diskfälle bestehen erneut. Evidenz:
`task-21-unit/native-copy-final.trx` und `task-21-final-safety-api/summary.json`.
Unix-native Rename/Volume-Semantik und weitere Plattformakzeptanz bleiben vor
Release zu prüfen. UI/Kontextmenüs, Clipboard, Konflikte/Recovery und die gesamte
Browserabnahme sind weiterhin nicht implementiert/abgenommen.

**UI-Zwischenstand (2026-10-11):** Gemeinsame echte Aktionen in Baum,
Ordner-Modal und Dock: Create/Rename/Duplicate/Move/Delete, internes Copy/Cut/
Paste, Rechtsklick, F2/Del/Ctrl-C/X/V, klare Konfliktentscheidungen, Recovery-
Auswahl nach Namen/Datum und Undo. Keine internen Recovery-IDs im Bedienablauf.
Neue Controls sind in allen zehn Sprachen beschriftet. Betroffene offene Entwürfe
werden vor Rename/Move/Delete/Replace entschieden; Savefehler verhindern die
Mutation. Auswahl folgt dem neuen Namen; Late-Response-Nachbearbeitung prüft
Ort/Sitzung erneut. Partialfehler bleiben nach Konflikt-Retry erhalten und Cut-
Clipboard behält nur fehlgeschlagene Quellen. Undo-Cancel erhält die Möglichkeit
zur Wiederherstellung. Client-Acknowledgements prüfen Command-ID/Action/Items;
verlorene Antworten werden über echte Receipts gelesen und nicht blind erneut
als POST gesendet. 17 neue reale Browserfälle einschließlich 390px Touch und
Modal/Dock bestehen, ebenso alle 118 vorherigen Fälle (135 insgesamt).
684 Frontendtests plus Kitty, Typecheck, ESLint, Stylelint und Diffcheck bestehen.
Evidenz: `task-21-ui-final`, `task-21-ui-undo-conflict`,
`task-21-regression-{selection,edit}`, `task-21-large-keyboard`,
`task-21-final-{mobile,directory,navigation,visibility,refresh}` und
`task-21-unit/ui-final-tests.*`. Große UTF-16-Eingabe: Playwright locator.fill
lief trotz sichtbarem/editierbarem Editor reproduzierbar ins Timeout; echte
Klick/Ctrl-A/Tastatureingabe und BOM/CRLF-Diskprüfung bestehen. Als Harness-Gap
vermerkt; keine Reparatur des Editors aus diesem Befund behauptet. Punkt 21
bleibt wegen der bereits genannten Native-/Plattform-/Recovery-Lifecycle-
Restprüfungen offen; das vollständige Phasenrelease bleibt ausstehend.

**Native-/Recovery-Abnahme (2026-10-11):** Linux läuft jetzt mit verifiziertem
SDK 10.0.303 in einem eigenen Container und realen Overlay-/tmpfs-Volumes:
60 Prüfungen bestehen, fünf Windows-Fälle sind übersprungen. Native no-replace
Renames ersetzen den impliziten Unix-Copy/Delete-Fallback; Kollisionen bleiben
unangetastet. Cross-volume-Move behält ein originales, über Hardlink/Inode
geprüftes Recovery-Objekt. Externe Git-Metadaten auf anderem Volume verwenden
einen Ausweichort außerhalb des Worktrees; Git-Status enthält keine internen
Payloads. Recovery-Verweise bleiben bei Parent-Rename/-Delete und Neustart
gültig; gespeicherte Kandidatenpaare funktionieren vor und nach dem Rename.
Ordnerkopien/Fingerprints schließen nur registrierte interne Recovery-Container
aus; gelöschte Inhalte werden nicht wieder mitkopiert. 66 Windows-Prüfungen
einschließlich Caller-Identity und sieben Source-HTTP-/Diskfälle bestehen.
Evidenz: `task-21-unit/{native-relocation-accepted.trx,linux-files.trx}` und
`task-21-native-accepted-api/summary.json`. Originale Windows- und Unix-Prüfungen
sind damit belegt; macOS-Case-Verhalten und echte LocalSystem-Service-Abnahme
bleiben offen. Punkt 21 ist weiterhin nicht vollständig abgeschlossen.

**Service-/macOS-Prüfung (2026-10-11):** `b3dfb12a` ergänzt echte Plattform-CI
und einen isolierten LocalSystem-Runner. SYSTEM darf die private Testdatei nicht
direkt lesen; der verifizierte Caller kann reale Create/Duplicate/Rename/Move/
Delete/Restore-Aktionen und Git-Abfragen ausführen. Der Git-Prozess übernimmt
den Caller-Token statt einer allgemeinen Desktop-Benutzersuche. Eine tatsächlich
ausgeführte LocalSystem-Prüfung besteht (TRX: 1/1); die Task wird entfernt.
Git bekommt das Repository als separates `-C`-Argument und einen festen Prozess-
Arbeitsordner. Warn-as-error-Fehler am Copy-Helfer ist korrigiert. Reale Case-
Renames und Pfade mit Shell-Zeichen bestehen. macOS fand `/var`-/`/private/var`-
Unterschiede in Test-Roots und Git-Ignore-Berechnung; `4240b3f3` korrigiert diese.
macOS, Linux, CodeQL und Frontend-CI sind dort grün; Windows-CI läuft noch.
Sieben neue Source-HTTP-/Diskfälle und zehn reale Visibility-Browserfälle bestehen.
Evidenz: CI-Runs `38132512559` / `38133598180`,
`task-21-unit/ci-windows`, `task-21-service-build-api/summary.json`,
`task-21-service-visibility/summary.json`. Punkt 21 bleibt bis zum terminalen
Windows-Ergebnis des letzten Commits offen; beide Phasenreleases stehen aus.

**Abgeschlossen:** Native-CI `38133938113` ist terminal erfolgreich auf Windows,
macOS und Linux einschließlich realem LocalSystem-Caller-Test. PR-Server,
Frontend, CodeQL und Build-System-Prüfungen am Stand `485169f9` sind ebenfalls
erfolgreich. UI-/Disk-/Recovery-Kriterien sind damit abgenommen; der Files-Minor
folgt weiterhin erst nach allen verbleibenden Files-Aufgaben.

### 22. [x] Dateiansicht, Sortierung, Filter und Metadaten vervollständigen

**Befund (mittel, Erwartungslücke):** Nur Ordner-zuerst/Namen/Größen; kein Datum,
Typ, Sortierung, Details-/Symbolansicht oder lokale Filterleiste.

**Aufgabe:** Sinnvolle Details-/Symbolansicht, Sortierung nach Name/Datum/Typ/Größe,
lokaler Filter und relevante Metadaten; Zustände pro Arbeitskontext erhalten.

**Abnahme:** Neueste Datei/PDFs finden, natürliche Namenssortierung, leere Treffer,
große Ordner und Ansichtwechsel mit erhaltener Auswahl prüfen.

**Nachweis 12.10.2026:** Files bietet Baum-, Details- und Symbolansicht; Modal
und Dock teilen Details/Symbole. Name/Datum/Typ/Größe sortieren natürlich,
Ordner bleiben vorne, unbekannte Metadaten hinten, Nullbyte-Dateien zeigen 0 B.
Der ausdrücklich lokale Filter berücksichtigt geladene Namen und Typen und
zeigt leere Treffer separat. Ansicht/Sortierung/Filter bleiben pro Sessionkontext
über Reload erhalten; Auswahl und Baumexpansion überstehen Ansichtwechsel.
Ausgefilterte Auswahl ist für Aktionen inaktiv und wird bei Filterrücknahme
wiederhergestellt; extern gelöschte Einträge werden entfernt. Metadaten passen
sich der tatsächlichen Panelbreite an, ohne horizontale Verdrängung der Controls.
689 Frontendtests, Kitty, Typecheck, ESLint und Stylelint bestehen. Vier neue
reale Chromium-Szenarien einschließlich 600 Dateien (Filter: 22 ms im Testlauf)
und 390-px-Touchansicht sowie 13 bestehende Auswahl-/Dirty-/Diskfälle bestehen.
Screenshots von Details, Symbolen und Directory-Dock wurden geprüft.
Evidenz: `.dev/file-git-production/task-22-responsive/summary.json`,
`task-22-selection-regression/summary.json` und `task-22-verify.*.log`.

### 23. [x] Files-Trennflächen und Viewer-Dock anpassbar machen

**Befund (mittel, Code/reproduziert):** Baum fix 280 px, File-Dock fix 400 px ohne
Resize; Git hat dagegen einen Griff. Lange Namen und breite Inhalte leiden.

**Aufgabe:** Bedienbare, begrenzte Split-/Dockgrößen mit persistierter Präferenz,
Tastaturzugang und sauberem schmalem Layout.

**Abnahme:** Resize, Reload, kleine Fenster, kombinierte Panels und Terminal-
Geometrie prüfen; keine Inhalte über Rand, keine unerwartete Session-Übernahme.

**Nachweis 12.10.2026:** Files-Baum und Viewer-Dock haben begrenzte, gespeicherte
Breiten und fokussierbare ARIA-Separatoren. Pointer-Capture, Pfeile (Shift für
größeren Schritt), Home/End, Escape-Abbruch und Doppelklick-Reset funktionieren.
Die aktuelle Panelbreite begrenzt die Darstellung, ohne die gespeicherte
Präferenz beim temporären Verkleinern zu überschreiben. Schmale Files bleiben
bei Baum/Detail-Navigation; der Viewer verwendet bei zu wenig Platz oder auf
Mobilgeräten eine Vollfläche. Ein bestehender CSS-Fehler reservierte dabei
weiter 400 px Terminalplatz; Overlay-Docks reservieren jetzt keinen Seitenraum.
Sieben reale Chromium-Szenarien prüfen Reload, 390 px, gemeinsame Browser-/File-
Docks, Begrenzung und Abbruch. Ein zweiter Browser verändert weder die
kanonischen Terminalspalten/-zeilen des ersten noch fordert er Größenownership
an. Kombinierte Panels und Overlay wurden visuell geprüft. 689 Frontendtests,
Kitty, Typecheck, ESLint und Stylelint bestehen.
Evidenz: `.dev/file-git-production/task-23-final/summary.json`,
`task-23-verify.*.log`, `combined-docks.png`, `dock-overlay-390.png`.

### 24. [x] Einheitliche Vorschau-/Editmodi anbieten

**Befund (mittel, reproduziert/Code):** Markdown in Files sofort Editor, andere
Texte Readonly mit Edit, Modal stets Textarea; Markdown bleibt Quelltext.

**Aufgabe:** Konsistenter Preview/Edit-Wechsel, Markdown-Rendering plus Source,
erkennbare Schreibbarkeit und Dirtyzustand in Tab/Modal/Dock.

**Abnahme:** Markdown/Code/Text/Readonly, Modewechsel mit Entwurf, Syntaxanzeige,
keine unbeabsichtigten Writes; Tastatur und Screenreader-Modusinformation prüfen.

**Nachweis 12.10.2026:** Alle Textdateien starten in einer expliziten Vorschau.
Files, Modal und Dock verwenden denselben Preview/Edit-Vertrag; Markdown bietet
gerenderte Überschriften/Tabellen/Code und zusätzlichen Quelltext. Code-/Text-
Vorschau erhält Zeilennummern und Syntaxfarben. Rohes HTML und unsichere Links
werden durch den bestehenden Markdownrenderer entschärft. Schreibbarkeit,
Dirtyzustand und aktiver Modus sind sichtbar und per ARIA zugänglich; readonly
und partielle Dokumente erlauben keinen Editwechsel. Der Editor entsteht erst
bei ausdrücklichem Editieren. Moduswechsel erhalten dieselbe Editorinstanz,
Entwurf, Auswahl und Scroll; Dockwechsel verschieben diese Instanz unverändert.
Eine Vorschau des Entwurfs speichert nichts; Ctrl/Cmd-S und Save bleiben
ausdrückliche Aktionen. Veraltete Editorbuttons/-stile sind entfernt.
Vier neue echte Chromium-Szenarien prüfen Markdown/Sicherheit, Text/Code,
Readonly in allen Views, fünf wiederholte Modewechsel, Tastatur-Save und 390 px.
37 Dirty-/Konflikt-/Late-Response-Fälle, 13 Auswahl-/Touchfälle und acht große-
Datei-/UTF-16-/Paging-/Diskfälle bestehen weiterhin mit explizitem Editwechsel.
689 Frontendtests, Kitty, Typecheck, ESLint und Stylelint bestehen. Screenshots
von gerenderter Vorschau und schmalem Modal wurden visuell geprüft.
Evidenz: `.dev/file-git-production/task-24-final/summary.json`,
`task-24-{edit,large}-regression/summary.json`,
`task-24-selection-final/summary.json`, `task-24-verify-final.*.log`.

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

### 28. [x] Dateinavigation und Viewer vollständig per Tastatur bedienen

**Befund (mittel, reproduziert/Code):** Baum/Liste bestehen aus klickbaren divs
ohne Fokus/Tree-Semantik/Pfeile. Modal hat keine Dialogsemantik/Fokusführung;
Editor versteckt den Fokusrahmen.

**Aufgabe:** Tree-/Listen-/Dialogsemantik, roving focus, Pfeile/Home/End/Enter,
Typ-to-select, sichtbarer Fokus, Fokusreturn und korrekter Dialog-Fokusbereich.

**Abnahme:** Kompletter Dateiablauf ohne Maus; Screenreaderstruktur, Escape/Tab,
Modalwechsel, Resize und keine Weitergabe von Navigationskeys an Terminal prüfen.

**Nachweis 12.10.2026:** Tree/List verwenden roving focus, natürliche Pfeil-/
Home-/End-/Space-/Enterauswahl und lokales Typ-to-select mit Unicode-Graphemen.
Links/Rechts falten Baumordner und wechseln zu Parent/erstem Child. ARIA-owns
verknüpft die vorhandenen Kindgruppen korrekt mit dem Treeitem; die echte Chrome-
Accessibility-Struktur bestätigt Child unter Parent. Tastatur-Open verschiebt
den Fokus sichtbar in die Vorschau. Listen halten Fokus auch nach Row-Entfernung.
Der Viewer ist ein benannter modaler Dialog; Tab/Shift-Tab bleiben innerhalb,
Escape respektiert Fullscreen/Dirtyentscheidung und stellt den Auslösefokus wieder
her. Dock-/Undock-/Close erhalten bzw. restaurieren sinnvollen Fokus. Auch ein
Save-Entscheidungsdialog mit deaktivierten Buttons hält den Fokus während Save.
Sieben echte Browser-Szenarien prüfen Baum, Directory-Open/Back, 60 Tab-Schritte,
Modal/Dock, Dirty-Save und 390 px. Baum- und Dirtydialog-Keysequenzen senden
null Mux-Inputframes (`0x14`) an das Terminal. 689 Frontendtests und Kitty/
Typecheck/ESLint/Stylelint bestehen. Die Accessibility-Abnahme ist echte Chrome-
AX-Evidenz; eine konkrete NVDA-/VoiceOver-Sprachausgabe wird damit nicht behauptet.
Evidenz: `.dev/file-git-production/task-28-final/summary.json`,
`task-28-verify.*.log`; Resize-/Ownership-Evidenz zusätzlich aus Aufgabe 23.

### 29. [x] Ausreichende Bedienziele für schmale und Touchansichten schaffen

**Befund (mittel, reproduziert):** Baumzeilen circa 25 px, Viewericons 28×28 px,
Close etwa 14×24 px. Schmale Ansicht vergrößert die Ziele nicht.

**Aufgabe:** Touchgeeignete Ziele bei erhaltener Desktopdichte; Chevron/Zeile/
Toolbaraktionen klar trennen, Bedienelemente nicht kollidieren lassen.

**Abnahme:** Pointer coarse/Touch-Emulation, lange Namen, dichtes Panel,
Toolbar-Wrapping und Fehlklickfreiheit über Zielgeometrie/Interaktion prüfen.

**Nachweis 12.10.2026:** Coarse-Pointer-Zeilen, Checkbox-Labels, Chevronbuttons,
Modi, Navigation, Vieweraktionen und Resize-Griffe haben 44-px-Ziele. Rand-Taps
auf Checkboxlabels toggeln genau einmal; Chevron-Taps falten unabhängig von
Auswahl/Preview. Fine-Pointer-Zeilen bleiben kompakt. Touch-Eingaben verwenden
16-px-Controls; lange Header umbrechen mit festem Eigenplatz statt unter die
Navigation zu schrumpfen. Der Actions-Popup begrenzt Position/Höhe an seinem
tatsächlich sichtbaren Scrollpanel und reagiert auf dessen Resize. Seine
Listener/Observer werden beim Schließen/Dispose entfernt. Sechs reale Szenarien
prüfen Pointer-coarse, Zielrechtecke, Rand-Taps, Popupbounds, 390×844/390×500,
lange Namen und einen separaten Fine-Pointer-Browser; Screenshots sind geprüft.
Sieben Ansicht-/Resize-/Ownershipfälle und 17 tatsächliche Dateioperations-/
Disk-/Recoveryfälle bestehen. 689 Frontendtests und Kitty/Typecheck/ESLint/
Stylelint bestehen. Browserharnesses prüfen fertige CSS-/Localeassets vor Start,
damit Source-Hotcopy-Zwischenstände keine UI-Abnahme vortäuschen.
Evidenz: `.dev/file-git-production/task-29-touch-accepted/summary.json`,
`task-29-resize-accepted/summary.json`, `task-29-actions-final/summary.json`,
`task-29-verify-final.*.log`. Konkrete Smartphonehardware bleibt Feldabnahme.

### 30. [x] Vollständigen Stage–Review–Commit-Ablauf in Git implementieren

**Befund (hoch, Erwartungslücke):** Keine direkten Datei-/Gruppenaktionen zum
Stage/Unstage und kein Commitfeld/Button; nur vorgeschlagene Terminalbefehle.

**Aufgabe:** Echte repo-bound Backendaktionen für Stage/Unstage/Commit mit
Identitäts-/Fehler-/Busybehandlung; Review und Stagingzustand nachvollziehbar halten.

**Abnahme:** Echte Repos mit gemischt staged/unstaged/untracked, selektiver Commit,
Committext, fehlender Gitidentität, Hooks/Fehlern und Statusaktualisierung prüfen.

**Nachweis 12.10.2026:** Native repo-bound Stage/Unstage/Commit-API mit echtem
Indexlock, separatem Transaktionsindex, geprüfter Index-/HEADversion und dauerhaftem
Operationsbeleg. Datei-/Gruppenaktionen, Commitentwurf, Busy/Fehler/Retry und
bestätigter Commithash sind angebunden. Native Hooks und Identitätsfehler bleiben
wirksam. 14 Git-/Parsertests bestehen einschließlich externem Lock, konkurrierender
Wiederholung, Abbruch sowie bereits erstelltem Commit mit fehlgeschlagener
Indexveröffentlichung; letzterer nennt den Hash und behält den vorbereiteten Index.
Sechs echte Browserabläufe bestehen: selektiver Indexreview/Commit bei nachträglich
geänderter Arbeitskopie; Unicode Stage/Unstage ohne Diskänderung; fehlende Identität
mit erhaltenem Entwurf; echter abweisender Hook und korrigierter Retry; verlorene
Commitantwort mit gesperrten neuen Mutationen und gleicher Operations-ID ohne
zweiten Commit; Stage-all/Unstage-all. Null Terminal-Inputframes und Browserfehler.
Neu entstandene Zielgruppen öffnen sich; das wiederverwendete Commitfeld wird nach
bestätigtem Erfolg tatsächlich geleert. Screenshots sind geprüft. 30 Inspector-
Geometrien sowie 708 Frontendtests, Kitty/Typecheck/ESLint/Stylelint bestehen.
Evidenz: `git-task-30-accepted/summary.json`, `git-task-30-layout-regression`,
`git-task-30-native/git-task-30.trx`, `git-task-30-verify-accepted.*.log` unter
`.dev/file-git-production`. Sourceprüfung läuft mit prozesslokal deaktivierten
zusätzlichen Codeanalysatoren, nachdem der normale csc-Build über eine Stunde
CPU-Zeit verbraucht hatte; Releaseprüfung bleibt regulär und dieser Hänger muss
vor Veröffentlichung geklärt werden. Keine LocalSystem-Schreibabnahme behauptet.

### 31. [x] Git-Aktionen und Befehle an das ausgewählte Repository binden

**Befund (hoch, Code):** Multi-Repo-Sidebar erzeugt relative git-Befehle ohne -C.
Inspector zeigt tlbx-2, Terminal-CWD Jpa: Ausführung arbeitet im falschen Repo.

**Aufgabe:** Serverseitig validierte Repoidentität für alle Operationen; verbleibende
Copybefehle explizit -C. Auswahlwechsel darf laufende Aktionen nicht umadressieren.

**Abnahme:** Zwei Repos mit gleichen Pfaden, abweichende CWDs, Switch während
Request, manipuliertes Repo und nicht gebundener Root: exakt ein erlaubtes Ziel.

**Nachweis 12.10.2026:** Copy-/Insertbefehle tragen den gewählten absoluten Root
als `git -C`; Dateibefehle nutzen Literal-Pathspecs. Die nötige PowerShell-/Bash-
Quotierung ist als Voraussetzung umgesetzt; unbekannte/noch nicht unterstützte
Shells zeigen eine lokalisierte Begrenzung. Native Aufrufe entfernen geerbte
Git-Repository-/Index-/Config-Umleitungen und behalten nur ausdrücklich interne
Overrides. Rootseparatoren und echte Randspaces werden korrekt erhalten.
16 native Git-/Parsertests bestehen, inklusive absichtlich falscher Umgebungs-
Roots und zurückgezogener Bindung vor dem Schreiben. Drei echte Browserabläufe
mit A/B/C und gleichnamigen Dateien bestehen: aus A ausgeführter Clipboard-Diff
zeigt exakt B; verzögerte B-Stage bleibt bei Wechsel zu A auf B und überschreibt
die A-Ansicht nicht; ungebundener C-Root, manipulierter Unterroot und entfernte
B-Bindung werden mit 403 ohne Index-/Diskmutation abgewiesen. Null Terminalinput
und Browserfehler; Screenshot geprüft. 708 Frontendtests mit Kitty/Typecheck/
ESLint/Stylelint bestehen. Die Index-Lebensdauer wurde in einem kleinen Besitzer
gebündelt; native Prüfungen und Source-Dev-Loop bauen wieder mit regulären
Analysatoren, ohne die temporäre Suppression. Evidenz: `git-task-31-second`,
`git-task-31-native/git-task-31.trx`, `git-task-31-verify-accepted.*.log` unter
`.dev/file-git-production`; Source-Logs im JPA-Run `20261012T140957371Z-fcf474c6`.
Die gesamte PowerShell-/Bash-Sonderzeichenmatrix bleibt ausdrücklich Aufgabe 33.

**Integrierte Regression:** Vollständige Repo-Pushes aktualisieren nun auch das
passende offene/defaultaufgelöste Panel. Der Badge konnte vorher neuer sein als
die Liste. Ein zusätzlicher Grenztest verhindert Updates aus einem anderen Root.
Alle sechs Commitabläufe und drei Multi-Repoabläufe bestehen erneut;
709 Frontendtests bestehen. Evidenz: `git-task-31-commit-accepted`,
`git-task-31-repository-accepted`, `git-task-31-verify-complete-final.*.log`.

### 32. [x] Unsichere Send-to-Terminal-Automatik ersetzen

**Befund (hoch, Code):** Send pastet Text und Return an aktives Terminalprogramm;
bei Codex/Claude/TUI ist das keine Shellausführung. Discard kann als Send erscheinen.

**Aufgabe:** Gitoperationen durch eigene Backendverträge ausführen. Optionale
Terminalübergabe klar als Copy/Insert ohne verstecktes Enter und ohne Agentturn.

**Teilumsetzung durch Aufgabe 8:** Source-Pastebuttons fügen ohne Enter ein und
Controller sind gesperrt; die alte Submit-/Agent-Turn-Funktion wurde entfernt.
Eigene Git-Schreibverträge und echte Busy-TUI-/Controller-Abnahme fehlen noch.

**Abnahme:** Shell, beschäftigtes TUI und Agent Controller; direkte Gitaktion
funktioniert unabhängig davon, keine fremden Prompts/Keys/unerwarteten Mutationen.

**Nachweis 12.10.2026:** Git-Schreibaktionen verwenden die eigenen repo-bound
Backendverträge aus 30/31. Optionales Einfügen bleibt ohne Enter und ist im UI
nur für den Shell-Vordergrund verfügbar; Prozesswechsel aktualisieren die Buttons.
Der Server liest vor Git-Paste zusätzlich einen frischen Hostsnapshot und weist
Vordergrundanwendungen und explizite Controller vor dem Schreiben ab.
28 native Tests inklusive sechs Vordergrund-/Shellgrenzen und vorhandener Paste-/
Gitverträge sowie 709 Frontendtests mit Kitty/Typecheck/ESLint/Stylelint bestehen.
Drei reale Browserabläufe bestehen: Shell mit Stage/Unstage und bestätigtem
Paste ohne CR/LF; echte Raw-Mode-/Alternate-Screen-TUI mit null aufgenommenen
Eingabebytes trotz Copy, erzwungenem Insert-Klick und Stage/Unstage; echter Codex-
Agent Controller mit Session-CWD JPA und gebundenem Fixturetarget, ebenfalls
Stage/Unstage ohne Paste oder Provider-Turn-Requests. Direkte Git-Pasteversuche
gegen TUI und Controller liefern 409. Null Mux-Inputframes und Browserfehler.
Screenshots sind geprüft; alle Test-Sessions/Browser werden geschlossen.
Evidenz: `git-task-32-fifth/summary.json`, `git-task-32-native/git-task-32.trx`,
`git-task-32-verify-fourth.*.log` unter `.dev/file-git-production`.
Kein Live-Modellturn wurde zur Prüfung ausgelöst.

### 33. [x] Shellabhängige Befehlsquotierung korrekt lösen

**Befund (mittel, Code):** quoteGitPath backslash-escaped Sonderzeichen unabhängig
von Shell. Dollar/Backtick/Quote sind in PowerShell anders zu behandeln als Bash.

**Aufgabe:** Backendoperationen als getrennte argv; Copy/Insert-Darstellung für
bekannte Shell korrekt, unbekannte Shell ehrlich begrenzen.

**Abnahme:** Pfade mit Spaces/Unicode/$/Backtick/Quotes und --ähnlichen Namen in
PowerShell und Bash. Kein zusätzlicher Befehl, keine Expansion, exakt richtiger Pfad.

**Nachweis 13.10.2026:** Shellgerechte Literalstrings für PowerShell (einschließlich
typografischer Apostrophe) und Bash/Zsh; keine Befehlsübergabe für nicht unterstützte
Shells. Native Dateioperationen und dateibezogene Diffreads verwenden getrennte
argv und Literal-Pathspecs. Git-C-quoted UTF8-Namen, Randspaces und Renameverzeichnisse
werden erhalten; NUL-numstat vermeidet falsche Nullstatistiken. Physische Root-/Gitdir-
Identität behandelt macOS-/Symlinkaliasse korrekt, einschließlich aliasierter
Eltern eines Linkziels. Der generierte PowerShell-Helfer wählt genau ein natives
Curl-Programm auch auf Unix. 11 echte Browserfälle bestehen: zehn tatsächliche
Clipboard-/Diff-/Stage-/Unstage-/Diskprüfungen plus sichtbare CMD-Begrenzung bei
funktionierenden nativen Aktionen; alle zehn Namen zeigen den richtigen Patch
und +1/-1. Null Nebenbefehle, Terminalinput und JSfehler; Screenshots geprüft.
Sechs Commitregressionen und 709 Frontendtests bleiben grün. Native Gesamtprüfung
CI `38309365277` besteht auf `298b9e1c`: Windows 118/127, Linux 120/127, macOS
117/127; übrige Fälle sind explizite Plattform-/Dienstskips. Reale Shellmatrix:
Windows 20, Linux/macOS je 28 Fälle; letztere prüfen zusätzliche auf Windows
unzulässige Doublequote-/Backslash-/Pathspecnamen. Der echte LocalSystem-Test
besteht 1/1 einschließlich Stage/Unstage/Commit mit geschütztem Caller-Token.
Lokale erweiterte Files-/Git-/CLI-Regressionssuite: 135 bestanden, acht Skips.
Evidenz: `git-task-33-browser-complete`, `git-task-33-final-{windows,linux,macos-refreshed}`,
`git-task-33-native-nested-final`, `git-task-33-final-commit-regression` unter
`.dev/file-git-production`. Frühere fehlgeschlagene CIläufe bleiben als Diagnose
erhalten; keine Prüfungen wurden abgeschwächt.

### 34. [x] Inhalt ungetrackter Dateien in Git prüfbar machen

**Befund (hoch, reproduziert):** WhatsAppPermissions.md zeigt No patch text available
und +0/-0. Show diff schlägt git diff vor, das untracked-Inhalt nicht zeigt.

**Aufgabe:** Neue Textdatei als Addition gegen leere Basis, Binärdatei als
passende Vorschau/Metadaten; Stage nach tatsächlicher Inhaltsprüfung.

**Abnahme:** Text/Binär/leer/groß/untracked-Verzeichnis, keine Nullstatistik als
scheinbar inhaltslose Datei; Review→Stage→Commit Ende zu Ende.

**Verifiziert 13.10.2026:** Sechs reale Browserabläufe bestehen für Unicode-Text,
leere Datei, decodierte PNG-Vorschau, begrenzte große Textdatei und Dateien in
untracked-Verzeichnissen; anschließend Stage/Commit mit bytegenauem HEAD-/Disk-
Vergleich aller Dateien. Keine Terminaleingabe oder Browserfehler. Gerenderte
Text-/Binärvorschau geprüft; Gestaltung bleibt ausdrücklich Aufgabe 43.
26 native Tests bestanden, zwei Unix-Fälle unter Windows ausdrücklich übersprungen.
Frontendprüfung: 709 Tests plus Typecheck/Lints bestanden. Evidenz:
`git-task-34-third/summary.json`, Screenshots und `git-task-34-native-final`.

### 35. [x] Untracked und Added in Git unterscheiden

**Befund (mittel, reproduziert):** statusToLetter liefert für untracked/added A;
VS Code verwendet U für untracked. Farbe und +0/-0 verschleiern Indexzustand.

**Aufgabe:** U/A mit korrekter Statusbeschriftung und Index-/Worktreezuordnung,
kongruent zu Aufgabe 10.

**Abnahme:** Neue Datei vor/nach Stage, weitere Änderung nach Stage, Unstage;
korrekte Gruppe/Buchstabe/Diff und erreichbare Statusbeschreibung.

**Zusätzlich reproduziert 13.10.2026:** Index-/Worktree-Numstat wurde je Pfad
zusammengezählt und in beiden Gruppen doppelt angezeigt. Nach erneutem Stage
konnte der Inspector außerdem den zuvor gecachten Indexdiff behalten. Berechnung
wird je Vergleich getrennt; Auswahl folgt ihrem tatsächlichen U/A/M-Zustand,
Indexänderungen laden die Vorschau erneut, überholte Antworten werden verworfen.
**Verifiziert 13.10.2026:** Fünf reale Browserabläufe U→A→A+M→A→U bestehen mit
passenden Beschreibungen, getrennter +1-Statistik, tatsächlichen Indexbytes und
aktuellen Vorschauen. Screenshots geprüft; keine Terminaleingaben/Browserfehler.
Sechs Commit-Regressionsabläufe bestehen einschließlich Hook-/Identitätsfehlern
und Lost-ACK-Replay. 31 native Tests bestanden, zwei explizite Unix-Skips;
709 Frontendtests plus Typecheck/Lints bestanden. Evidenz `git-task-35-third`,
`git-task-35-commit-regression`, `git-task-35-native-final` und Verify-Logs.

### 36. [~] Diffprüfung und selektives Staging vervollständigen

**Befund (mittel, Erwartungslücke):** Unified Patch ohne Alt-/Neuansicht,
Zeilennummern, Wortmarkierung, Änderungsnavigation oder Hunk-/Zeilenstaging.

**Aufgabe:** Inline und Side-by-side, echte Zeilenzuordnung/Wortdiff und Next/Prev;
Stage/Unstage ausgewählter Hunks/Zeilen mit verifizierter Patchanwendung.

**Abnahme:** Mehrere Hunks, partielle Auswahl, CRLF/Unicode/Rename/Deletion,
veralteter Diff und parallele Änderungen: korrekter Indexinhalt und Konflikterkennung.

**Teilstand 13.10.2026:** Backendprojektion liefert echte Alt-/Neu-Zeilennummern
und begrenzte Unicode-Wortvergleiche. Inlineansicht zeigt passende Gutter und
Wortmarkierung; ein fälschlich angehängter leerer Patch-Kontext wurde entfernt.
13 native Tests bestehen, ein Unix-Skip unter Windows. Reale Browserprüfung
bei 250/400/600px besteht für Koordinaten, Wortmarkierung, CRLF/Unicode,
Tab-/Leerzeicheneinzug, Wrap/Scroll/DOM-Erhalt und unveränderte Diskbytes ohne
Schreibaktionen/Terminaleingaben. `git-task-36-projection-native-final` und
`git-task-36-reading-first` enthalten die Nachweise. Dieser frühe Teilstand
deckte Side-by-side, Änderungsnavigation und selektives Staging noch nicht ab.

**Implementiert und lokal geprüft 13.10.2026:** Side-by-side nutzt die volle
Dockbreite mit Rückweg zur Liste; Backend-Zuordnung hält Alt-/Neu-Zeilen und
Wortmarkierungen zusammen. Vorherige/nächste Änderung fokussiert echte Hunks.
Zeilenauswahl per Klick/Ctrl/Shift/Tastatur erhält DOM-Identität. Hunk-/Zeilen-
Stage und Unstage erzeugen serverseitig einen versionierten Patch und prüfen
ihn mit Git im gesperrten temporären Index vor Veröffentlichung. 39 native
Tests bestehen, zwei explizite Unix-Skips; darunter neun echte Gitfälle für
CRLF/Unicode, neue/gelöschte/umbenannte Dateien, veraltete Diffs/Indizes,
Parallelität, leeres Repository und Replay ohne doppelte Anwendung. Sechs
Browserabläufe und 15 Diff-/Commit-/New-File-Regressionsabläufe bestehen;
Screenshots nach Korrektur der Side-by-side-Breite geprüft. 709 Frontendtests
plus Typecheck/Lints bestehen. Nachweise: `git-task-36-partial-wide`,
`git-task-36-selection-native-final`, `git-task-36-regression-*`, Side-Verify-Logs.
Layout-/Navigationsregression besteht zusätzlich mit drei realen Abläufen für
Back/Cache/Scroll/Fokus, wiederholtes Keyboard-/Pointer-Resizing und 390px-Overlay
mit Desktop-Rückkehr (`git-task-36-layout-navigation`). Abschluss bleibt offen
bis Plattform-/LocalSystem-CI verifiziert ist. Der Designpass bleibt Aufgabe 43.

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

Zusätzlich: initialen Fokus im mobilen Git-Overlay setzen, Tab/Shift-Tab und
Escape ohne Eingabe an das verdeckte Terminal prüfen; Fokus nach Dockclose
sinnvoll zurückgeben.

### 39. [ ] Git-Laden, fehlendes Repo und Abfragefehler unterscheiden

**Befund (mittel, reproduziert/Code):** Erstöffnung von gebundenem Repo zeigt
Not a git repository vor Antwort. RESTfehler werden null und teilen diesen Zustand.

**Aufgabe:** Explizit Loading/Ready/No Repo/Error/Stale mit Retry; letzte gute
Daten nicht als aktuell ausgeben, Fehlerdetails sinnvoll übersetzen.

**Abnahme:** Verzögerung, 401/403/404/500, Offline/Reconnect und Repoentfernung;
kein falsches No-Repo, Retry funktioniert und Authablauf bleibt korrekt.

Zusätzlich: ein fehlgeschlagener Status-/HEADread nach einer Schreibaktion darf
keinen leeren Hash als bestätigten Commit ausgeben. Die tatsächliche Commit-
Identität separat bestätigen und unsichere Ergebnisse als solche erhalten.

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

### 43. [ ] Strengen UI-/UX-Designpass für Files und Git abschließen

**Verbindlicher Zusatzauftrag 13.10.2026:** Files und Git müssen am Ende als
bewusst gestaltete, konsistente tlbx-Oberflächen wirken. Funktionsprüfungen
allein schließen diese Aufgabe nicht ab. Johannes beanstandet übermäßige
Buttonflächen, schwer erkennbare Buttons, fehlende Hierarchie und inkongruenten
Stil. Datei-Checkboxen werden aus diesem Poweruser-Werkzeug entfernt.

**Aufgabe:** Bestehende tlbx-Designmuster anhand gerenderter Referenzflächen
übernehmen; Navigation, Inhalt und Aktionen klar priorisieren. Seltene Aktionen
kontextuell unterbringen, häufige Aktionen kompakt und eindeutig gestalten;
keine dauerhaften großflächigen Bedienfelder ohne belegten Nutzwert. Einheitliche
Button-, Icon-, Fokus-, Hover-, Auswahl-, Abstands- und Typografiesprache herstellen.
Dateiauswahl ohne Checkboxen über OS-konforme Klick-/Ctrl-/Cmd-/Shift- und
Tastaturinteraktionen anbieten. Dieselbe harte Prüfung auf Git anwenden,
einschließlich Stage/Review/Commit, Verlauf, Diff und schmalen Panels.

**Abnahme:** Reale visuelle Prüfung und Interaktion in Files und Git bei Desktop,
schmalem Dock und Touch-Emulation; vorhandene tlbx-Flächen als konkreter Vergleich.
Erkennbare Aktionen, sinnvolle Flächennutzung, geringe visuelle Unruhe, vollständige
Poweruser-/Tastaturbedienung und erhaltene Mehrfach-/Bulkaktionen nachweisen.
Screenshots und Arbeitsabläufe prüfen; ein grüner Funktionstest genügt nicht.
Erst danach integrierte Schlussabnahme und zweiter Minor-Dev-Release.

**Prozessreparatur:** Nach vollständiger Funktionsabnahme ist die gerenderte
Gestaltung ein eigenes verbindliches Abschlusskriterium. Nicht allein aus
funktionierenden Buttons, DOMgeometrie oder bestandenen Tests Designqualität
ableiten. Bestehende Kriterien für Auswahl bleiben wirksam; checkboxspezifische
alte Abnahmen werden durch die ausdrücklich angeordnete Poweruserauswahl ersetzt.

## Release- und Abschlussnachweise

- Files-Minor: `v10.18.0-dev` veröffentlicht, Gesamtabnahme bestanden. 17 serialisierte
  Browsergruppen bestehen mit 159 echten Funktionsabläufen plus 108 Hintergrund-,
  40 Medien-, 32 Projektions-/Entwurf- und 720 Kontrastproben (Minimum 4,979355:1).
  Evidenz: `.dev/file-git-production/files-integrated/summary.json` und die dort
  verlinkten Einzelgruppen. Repräsentative finale Screenshots sind geprüft.
  Native CI `38211188234` besteht: Windows 73/79, Linux 74/79, macOS 71/79;
  übrige Fälle sind plattformspezifische Skips, keine Fehler. Alle sechs neuen
  Git-Status-/Pfadprüfungen bestehen auf jeder Plattform; echte LocalSystem-
  Caller-Abnahme zusätzlich 1/1. TRX/Logs: `task-10-platform-ci`.

  **Veröffentlicht 12.10.2026:** `v10.18.0-dev`, Merge `a844ebc5`, PR #274,
  Release-CI `38227984815` erfolgreich. Nicht mehr Draft; vier vollständige
  Archiv-/SPDX-Paare: Windows x64/x86 und Linux x64/arm64. Metadaten sind mit
  `Assert-PublishedReleaseAssets` geprüft und als
  `.dev/file-git-production/files-release-published.json` gesichert. macOS x64/
  arm64 fehlen: Apple-Notarisierung HTTP403 wegen fehlender/abgelaufener
  Entwicklervereinbarung; Native-macOS-Dateisystemtests bestanden. Keine
  Installation des Supervisors. `finish-task.ps1` hat den exklusiven sauberen
  Files-Branch beendet; Git arbeitet nun in `feat/git-workspace-production`.
- Git-Minor: offen. PR / Version / Commit / CI / Assets / E2E-Nachweise ergänzen.
- Finale 43-Punkte-Abnahme: offen; Code, gerenderte UI und echte Dateisystem-/Git-
  Ergebnisse je Aufgabe prüfen. Fehlende Nachweise bleiben offen.
- Cleanup: offene Devprozesse, Browser, Testsessions und Branches prüfen;
  sichere unmittelbare Bereinigungen erledigen, echte Folgepunkte gezielt erfassen.
