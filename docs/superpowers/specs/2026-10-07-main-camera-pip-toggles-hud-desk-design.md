# Hauptkamera, Kamera-Schalter für „Bildschirm + Kamera“, Tischkamera im HUD — Design

Stand: 2026-10-07 · Branch: `feat/multi-camera-layouts` (Worktree `C:\osc-cams`), danach im Squash von #1026

## Ziel

Drei Erweiterungen der Mehrkamera-Bearbeitung, mit dem Nutzer abgestimmt:

- **C — Hauptkamera:** Im Editor wählen, welche Kamera die Rolle von Kamera 1 übernimmt. Sie erscheint im
  Preset (Bild-im-Bild, Dual Frame, Vertical Stack) und in Full-Camera-Abschnitten (C); die Kamera-Effekte
  gelten für sie.
- **D — „Bildschirm + Kamera“ mit Schaltern:** Im Inspector eines solchen Abschnitts pro Kamera an/aus statt
  einer Auswahlliste pro Platz.
- **E — Tischkamera im HUD:** In den Geräte-Einstellungen des HUD die Tischkamera als Vorgabe für neue
  Aufnahmen wählen; das neue Projekt übernimmt sie.

**Erfolg heißt:** Mit Gesicht auf Kamera 2 und Tisch auf Kamera 1 lässt sich im Editor Kamera 2 als
Hauptkamera wählen; Preset, C-Abschnitte, Effekte, Vorschau und Export zeigen Kamera 2, ohne dass sich
Layout-Abschnitte oder die Tischkamera verschieben. Ein „Bildschirm + Kamera“-Abschnitt bekommt Fenster per
Schalter. Eine neue Aufnahme mit im HUD gewählter Tischkamera öffnet mit dieser Tischkamera. Projekte ohne
die neuen Felder sehen unverändert aus.

## Entscheidungen (mit dem Nutzer abgestimmt)

- Die Preset-Auswahl ist eine **Hauptkamera-Rolle** (nicht „nur fürs Preset“): sie gilt für Preset,
  C-Abschnitte und Effekte.
- Umsetzung der Rolle **nur im Szenenaufbau** durch Tauschen der Kameras; keine Änderung an Compositor,
  Backends oder Shadern.
- „Bildschirm + Kamera“: Schalter pro Kamera, mindestens 1, höchstens 3, Fenster in Kamera-Reihenfolge.
- HUD-Tischkamera kommt **zusätzlich** zur Tischkamera im Editor; das Projekt übernimmt sie nur, wenn es
  noch keine hat.
- Reihenfolge: D, dann C, dann E; jeder Teil mit eigenem Lauf in der echten App (Playwright).

## Nicht in diesem Schritt

- Effekte (Unschärfe, Freistellen, eigener Hintergrund) für mehr als eine Kamera gleichzeitig.
- Zuordnung baugleicher Kameras über die Seriennummer (bekannte Schwäche aus #1025 bleibt).
- Hauptkamera im HUD.
- Compositor-Befund „außerhalb des Kamerabilds Hintergrund statt Schwarz“ (eigener Folgepunkt).

## Teil D — „Bildschirm + Kamera“ mit Schaltern

**Bedienung:** Im Inspector eines Layout-Abschnitts mit Vorlage `screen-pip` ersetzt eine Liste „Kameras“
die Auswahllisten pro Platz: pro Kamera des Projekts ein Schalter (Name wie im Abschnitt „Kameras“).
Eingeschaltet = die Kamera hat ein Fenster. Nicht verfügbare Kameras sind ausgegraut (außer sie sind
eingeschaltet — dann lassen sie sich ausschalten). Der letzte eingeschaltete Schalter ist gesperrt
(Hinweis „Mindestens eine Kamera“); bei drei eingeschalteten sind die übrigen gesperrt (Hinweis „Höchstens
drei Fenster“). Andere Vorlagen behalten ihre Auswahllisten.

**Daten:** unverändert `slots: CameraLayoutSlot[]`. Ein Schalter ändert die Liste: einschalten fügt
`{ camera }` an der Stelle ein, die die Kamera-Reihenfolge verlangt; ausschalten entfernt den Platz dieser
Kamera. Ein Platz mit eigenem `rect` behält es, solange seine Kamera an bleibt. Ein Schreibvorgang = ein
Undo-Schritt.

**Store:** neue Funktion `setLayoutSectionCameras(handle, cameras: number[])` (Reihenfolge = Kamera-Index;
übernimmt vorhandene `rect` der bleibenden Kameras; verweigert < min / > max der Vorlage).

## Teil C — Hauptkamera

**Daten:** `legacyEditor.mainCamera?: number` (Index, 0 = Kamera 1; fehlt = 0). Indizes in
Layout-Abschnitten, `cameraSettings` und `deskCamera` meinen weiterhin **die Kamera selbst** (das Gerät),
nicht die Rolle.

**Auflösen:** `resolveMainCamera({ mainCamera, cameraCount, available })` → gewählte Kamera, wenn im Projekt
vorhanden und verfügbar (gleiche Verfügbarkeitsregel wie die Tischkamera); sonst 0. Editor und Szene
benutzen dieselbe Funktion.

**Einstellungen:**
- Die Regler des Kamera-Layout-Bereichs (Preset, Form, Größe, Position, Rundung, Zuschnitt, Spiegeln,
  Effekte) gelten für die **Hauptkamera**.
- Jede andere Kamera — auch Kamera 1, wenn sie nicht Hauptkamera ist — nimmt Drehung, Spiegeln und
  Zuschnitt aus ihrem Eintrag in `cameraSettings` (Abschnitt „Kameras“).
- Die Perspektive bleibt immer bei ihrer Kamera (`cameraSettings[i].perspective`), auch als Hauptkamera.
- Der Abschnitt „Kameras“ zeigt bei der Hauptkamera den Hinweis, dass ihre Regler oben stehen (heute fest
  bei Kamera 1).

**Szene (`buildSceneDescription`):** Ist die Hauptkamera *m* ≠ 0, werden Kamera 0 und *m* vertauscht,
bevor die Szene entsteht:
- pro Clip: `webcamPath`/`webcamOffsetSec` ← Kamera *m*; in `additionalCameras` steht an *m*s Platz die
  bisherige Kamera 1;
- `cameras[]`: der Eintrag für Index 0 trägt die Perspektive von *m*; der Eintrag für Index *m* trägt
  Drehung/Spiegeln/Zuschnitt/Perspektive der echten Kamera 1 aus `cameraSettings[0]`;
- Quellmaße für das Preset (`webcamSourceSizeOf`) aus Kamera *m*;
- Layout-Abschnitte und Tischkamera-Zeilen: Kamera-Index 0 ↔ *m* umgeschrieben;
- Tischkamera = Hauptkamera → der D-Abschnitt wird zur Full-Camera-Zeile (heute: Tischkamera = Kamera 1).
Ohne `mainCamera` (oder = 0) ist die Szene unverändert.

**Bedienung:** Im Kamera-Layout-Bereich neben „Preset“ eine Auswahl „Hauptkamera“ (ab zwei Kameras
sichtbar), Einträge mit Kameranamen. Ist die gewählte Kamera nicht verfügbar: Hinweis „nicht verfügbar —
verwendet wird Kamera 1“. Ein Schreibvorgang = ein Undo-Schritt, über die Schreib-Warteschlange der Shell.

## Teil E — Tischkamera im HUD

**Bedienung:** In den Geräte-Einstellungen des HUD unter „Zusätzliche Kameras“ eine Auswahl „Tischkamera“:
„Keine“ oder eine der Kameras, die aufgenommen werden (Kamera 1 und die angehakten zusätzlichen). Gleiche
Sperrregel wie die zusätzlichen Kameras (nur mit Kamera an und nativer Windows-Aufnahme, ab zwei Kameras).
Gespeichert in den Aufnahme-Einstellungen wie `camAdditionalDevices` (Gerät per id/Name); eine gewählte
Kamera, die nicht mehr aufgenommen wird, gilt als „Keine“.

**Aufnahme:** Beim Aufnehmen wird aus der Wahl der Index in Aufnahme-Reihenfolge (0 = Kamera 1, *k* =
zusätzliche Kamera *k*, wie die Dateien `-webcam.mp4`, `-webcam-2.mp4` …) und als `deskCamera` in die
Sitzungsdatei geschrieben (neben `additionalWebcams`, optional).

**Projekt:** Beim Verknüpfen der Aufnahme mit dem Projekt (`projectStore.addAsset`) wird
`legacyEditor.deskCamera` gesetzt — nur, wenn das Projekt noch keine Festlegung hat und der Index zu einer
verknüpften Kamera gehört.

## Fehlerfälle

- Hauptkamera/Tischkamera nicht (mehr) verfügbar: automatisch auf Kamera 1 bzw. die automatische
  Tischkamera; Hinweis im Editor.
- „Bildschirm + Kamera“ mit nur einer verfügbaren Kamera: Schalter dieser Kamera gesperrt an.
- Ältere Aufnahmen ohne `deskCamera` in der Sitzungsdatei: keine Festlegung, automatische Wahl.

## Tests und Abnahme

- **D:** Store (`setLayoutSectionCameras`: einfügen in Reihenfolge, entfernen, `rect` behalten, min/max,
  Undo); Inspector (Schalter, Sperren, Hinweise).
- **C:** `resolveMainCamera`; Szene (Tausch für *m* = 1, 2; Layout- und Tischkamera-Indizes umgeschrieben;
  Tischkamera = Hauptkamera; ohne `mainCamera` identisch zu vorher mit wörtlichen Erwartungswerten); Editor
  (Auswahl, Hinweis, Abschnitt „Kameras“ zeigt die Regler-Notiz bei der Hauptkamera).
- **E:** HUD-Liste (Auswahl, Sperre, „Keine“); Aufnahme-Anfrage/Sitzungsdatei (`deskCamera`-Index);
  `addAsset` setzt `deskCamera` nur ohne vorhandene Festlegung.
- **Echte App (Playwright, Controller):** D und C auf einer Kopie des Zwei-Kamera-Projekts des Nutzers mit
  Screenshots und Export gegen Vorschau; E so weit der HUD erreichbar ist (Auswahl speichern). Eine echte
  Aufnahme mit Kameras macht der Nutzer oder computer-use. Zeilen im Results-Log.
