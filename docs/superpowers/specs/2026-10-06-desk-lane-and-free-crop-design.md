# Tischkamera-Spur (D) und freier Ausschnitt nach der Entzerrung — Design

Stand: 2026-10-06 · Branch: `feat/multi-camera-layouts` (Worktree `C:\osc-cams`), danach im Squash von #1026

## Ziel

Zwei Schwächen aus dem ersten echten Lauf am Tisch des Nutzers (Brio als Tischkamera, Kamera 2):

1. **Verzerrtes Bild nach „Marker erkennen“.** Der Dialog zieht das Viereck zwischen den vier inneren
   Marker-Ecken auf ein Rechteck. Das ist nur verzerrungsfrei, wenn die Marker auf dem Tisch selbst
   ein Rechteck bilden. Beim Nutzer lagen sie frei verteilt (gemessen: Seiten 46 / 32 / 98 / 71 cm,
   Winkel 109° / 126° / 79° / 46°), das Ergebnis war entsprechend verzerrt.
2. **Keine einfache Tischansicht mit eigener Kamera.** „Full Camera“ (Taste C) kennt nur Kamera 1;
   eine andere Kamera im Vollbild geht nur über „Layout hinzufügen → Kamera voll“, was man nicht findet.

**Erfolg heißt:** Marker frei auf den Tisch legen, „Marker erkennen“, einen Ausschnitt in 16:9 (oder
4:3, 9:16, 1:1, frei) auf das entzerrte Tischbild ziehen — das Ergebnis ist rechtwinklig. Eine Kamera
einmal als Tischkamera markieren, dann legt die Taste D einen Abschnitt an, in dem die Tischkamera
weich ins Vollbild überblendet. Wer keine Entzerrung will, bekommt mit D die Tischkamera so, wie sie
aufnimmt. Alte Projekte sehen unverändert aus.

## Entscheidungen (mit dem Nutzer abgestimmt)

- **Entzerrung und Ausschnitt sind getrennt.** Die Marker liefern nur die Entzerrung der Tischebene;
  der Ausschnitt wird danach frei auf dem entzerrten Bild gewählt, Formate 4:3, 16:9, 9:16, 1:1, frei.
- **Die Entzerrung ist optional.** Eine Tischkamera ohne Perspektive ist ein gültiger Aufbau.
- **Eine Kamera wird im Projekt als Tischkamera festgelegt**; D-Abschnitte zeigen immer diese.
- **Eigene Timeline-Zeile, Taste D.** D-Abschnitte schließen sich mit C- und Layout-Abschnitten aus
  (keine Überlappung), dürfen aber direkt anschließen.
- **Übergang: Überblenden**, mit den Zeiten und der Kurve von C. Folgt D auf C, blendet das Gesicht im
  Vollbild in den Tisch im Vollbild über.
- **Bauweise:** eigene schlanke Abschnittsliste plus Projekteinstellung; der Szenenaufbau übersetzt
  D-Abschnitte in „Kamera voll“-Ebenen. Kein neuer Abschnittstyp im Compositor.
- **Reihenfolge:** erst Teil A (Dialog), dann Teil B (D-Spur).

## Nicht in diesem Schritt

- Board-Markerblatt (viele Marker auf A4) und Modus „ganzes Sichtfeld“.
- Kalibrierung vor der Aufnahme, Kamerarollen im HUD, Zuordnung über Seriennummer.
- Übergang „aus dem PiP wachsen“ (lässt sich später ohne Datenmodelländerung nachrüsten).
- Korrektur der Objektivverzeichnung.
- Änderungen am Compositor (Rust, Shader).

## Teil A — Kalibrierdialog: Entzerrung, dann freier Ausschnitt

### Datenmodell

Unverändert: `CameraPerspective { corners, aspect, margin? }` in `legacyEditor.cameraSettings[i]`.
Neu ist nur, was in `corners` steht: die Bildecken eines **auf der Ebene rechtwinkligen** Rechtecks
mit Seitenverhältnis `aspect`. Compositor, Szene und Export bleiben unverändert; alte Projekte laden
wie bisher.

Beim erneuten Öffnen wird die Ebene aus den gespeicherten Daten zurückgewonnen: die Homographie vom
Rechteck `aspect × 1` auf `corners` *ist* eine metrische Entzerrung. Es muss also nichts zusätzlich
gespeichert werden. (Für eine alte, von Hand gezogene Perspektive gilt dasselbe — sie wird als das
Rechteck gelesen, als das sie gespeichert wurde.)

### Geometrie (`src/lib/planeMeasure.ts`, ausgebaut)

- `planeFromMarkers(squares, sideMm)` → Homographie Bild → Ebene (Millimeter), aus den gemittelten
  zirkulären Punkten der Marker-Quadrate (heute intern in `measureOnPlane`), mit festgelegter
  Ausrichtung: x-Achse entlang Marker 0 → Marker 1, Ursprung in der Mitte der vier Marker.
- `planeFromPerspective(perspective)` → dieselbe Homographie aus gespeicherten `corners` + `aspect`.
- `rectToCorners(plane, rect)` → die vier Bildpunkte (normiert 0..1) eines Rechtecks auf der Ebene.
- `measureOnPlane` bleibt als Messfunktion erhalten (Größenangabe im Dialog).

### Bedienung

- **Ohne Ebene** (keine Perspektive, keine Marker): wie heute — Standbild mit vier Griffen.
- **„Marker erkennen“**: setzt die Ebene. Die große Fläche zeigt danach das **entzerrte** Tischbild,
  auf das Kamerabild begrenzt (Teile außerhalb des Kamerabilds bleiben leer; die Darstellung wird auf
  das Mehrfache der Marker-Ausdehnung begrenzt, damit ein Horizont im Bild sie nicht sprengt).
- Darauf liegt ein **Ausschnitt-Rechteck** mit Eck- und Kantengriffen (Bedienung wie der bestehende
  Zuschnitt-Modus), Format 4:3 / 16:9 / 9:16 / 1:1 / frei; Vorgabe 16:9, mittig, größtmöglich
  innerhalb der Marker. Bei festem Format bleibt das Verhältnis beim Ziehen erhalten.
- Die Größenangabe „ca. 94 × 58 cm“ bezieht sich auf den Ausschnitt.
- „Vier Ecken von Hand“: Umschalter zurück zum heutigen Modus (z. B. für eine Vorlage ohne Marker).
- **Übernehmen** speichert `corners = rectToCorners(plane, rect)`, `aspect = rect.w / rect.h`.
  **Zurücksetzen** entfernt die Perspektive.
- Der Regler „Rand“ gilt nur noch im Modus mit vier Griffen; im Ausschnitt-Modus ersetzt das
  Rechteck ihn (gespeichert wird dann kein `margin`).

### Fehlerfälle

- Nicht alle vier Marker: Meldung wie heute, Modus bleibt unverändert.
- Ebene nicht bestimmbar (entartete Marker): Meldung „Ebene konnte nicht bestimmt werden“; vier Griffe.
- Ausschnitt reicht über das Kamerabild hinaus: erlaubt, der Rand wird schwarz (wie heute bei einer
  Perspektive mit Rand); der Dialog zeigt einen Hinweis.

## Teil B — D-Spur mit Tischkamera

### Datenmodell (`legacyEditor`, optional, keine Schema-Version)

```ts
/** Index der Tischkamera (0 = Kamera 1). Fehlt = automatisch (siehe unten). */
deskCamera?: number;

/** Abschnitte, in denen die Tischkamera das Bild füllt. */
deskRegions?: DeskRegion[];

interface DeskRegion {
	id: string;
	startMs: number;
	endMs: number;
	/** Nur `false` wird gespeichert: blendet das Label „Schreibtischmodus“ aus. */
	deskLabel?: false;
}
```

**Tischkamera auflösen** (`resolveDeskCamera`, eine Stelle für Editor und Szene): die festgelegte
Kamera, sofern im Projekt vorhanden; sonst die erste Kamera mit Perspektive außer Kamera 1; sonst
Kamera 2; sonst keine. Drehung, Spiegelung, Zuschnitt und Perspektive kommen aus deren
`cameraSettings`, nicht aus dem Abschnitt.

### Timeline und Bedienung

- **Taste D** (neue Aktion `addDeskSection` in `src/lib/shortcuts.ts`, Standard `d`, frei belegbar;
  kollidiert nicht mit Strg+D) und ein Knopf in der Werkzeugleiste neben Full Camera, nur sichtbar
  mit mindestens zwei Kameras.
- **Eigene Zeile** „Tisch“ unter der Kamera-Zeile, Pillen wie bei Full Camera, ziehen und
  Länge ändern wie dort.
- **Ausschluss:** `addCameraFullscreen`, `addCameraLayout` und das neue `addDeskSection` lehnen
  Überschneidungen mit allen drei Listen ab (`"occupied"`); Ziehen und Längenändern werden an den
  Nachbarn begrenzt wie heute innerhalb der Kamera-Zeile. Berühren ist erlaubt.
- Ohne auflösbare Tischkamera: kein Abschnitt, Meldung „Keine Tischkamera — lege eine im Abschnitt
  Kameras fest“ (über `showCameraSectionOutcome`).
- Ein Schreibvorgang = ein Undo-Schritt, wie bei allen Abschnitten.

### Inspector

- **D-Abschnitt:** Name der Tischkamera mit Verweis „ändern“ (springt zum Abschnitt „Kameras“),
  Schalter „Label anzeigen“, Löschen.
- **Abschnitt „Kameras“:** pro Kamera ein Auswahlpunkt „Tischkamera“ (genau eine; erneutes Klicken
  hebt die Festlegung auf → automatisch). Kamera 1 ist wählbar; dann zeigt D Kamera 1 im Vollbild mit
  deren Drehung — der Ein-Kamera-Aufbau mit geschwenkter Kamera bleibt aber der C-Abschnitt mit
  Desk-Ansicht.

### Szene (`src/native/sceneDescription.ts`)

`buildSceneDescription` übersetzt jeden D-Abschnitt vor der Projektion:

- Tischkamera = Kamera *k* ≥ 2 → `CameraLayoutRegion { template: "camera-full", slots: [{ camera: k − 1 }] }`
  in die Liste der Layout-Abschnitte. Der Compositor gleitet bzw. blendet dort bereits wie
  gewünscht: eine Kamera, die nur in einem der beiden Zustände vorkommt, blendet über.
- Tischkamera = Kamera 1 → `CameraFullscreenRegion` mit Drehung/Spiegelung aus deren Einstellungen.
- Label: `deskLabelTextRegions` bekommt D-Abschnitte mit `deskLabel !== false` dazu (gleiche
  Animation `deskCover` für das Label; die Kipp-Abdeckung selbst entfällt, weil sich nichts dreht).
- Ohne auflösbare Tischkamera werden D-Abschnitte übersprungen (nicht gezeichnet, nicht gelöscht).

Vorschau, Export und CLI-Export laufen alle über die Szene und brauchen keine eigene Änderung. Die
DOM-Vorschau (`PreviewCanvas`) ist im Plan zu prüfen, ob sie Layout-Abschnitte schon zeigt.

### Fehlerfälle

- Festgelegte Tischkamera fehlt im Projekt (Datei verloren): automatisch auflösen; im Inspector
  „Tischkamera nicht verfügbar“.
- Alte Projekte ohne `deskRegions`/`deskCamera`: unverändert.
- Kopieren/Einfügen von D-Abschnitten verhält sich wie bei Full-Camera-Abschnitten (gleicher Weg in
  der Zwischenablage; können diese nicht kopiert werden, D auch nicht).

## Tests und Abnahme

- **Geometrie (Vitest, node):** gerenderte Testbilder mit frei verteilten Markern (kein Rechteck) →
  `planeFromMarkers` → ein Rechteck auf der Ebene → `rectToCorners` → zurückprojiziert ist es
  rechtwinklig (Winkel 90° ± 1°) und hat das gewählte Verhältnis; `planeFromPerspective` gibt für
  gespeicherte Daten dieselbe Ebene zurück (Rundreise).
- **Dialog (jsdom):** Formate, Ziehen mit festem Verhältnis, Übernehmen speichert Ecken + Verhältnis,
  Wiederöffnen stellt den Ausschnitt wieder her, Umschalten auf vier Griffe.
- **Store:** D anlegen, Ausschluss in allen Richtungen, Berühren erlaubt, Undo, Speichern/Laden,
  `resolveDeskCamera` in allen Fällen.
- **Szene:** D → `camera-full` der Tischkamera bzw. `CameraFullscreenRegion` für Kamera 1; Label;
  ohne Tischkamera übersprungen; alte Projekte erzeugen eine identische Szene.
- **Shortcuts/i18n:** D in der Liste, keine Kollision; alle 15 Sprachen (`npm run i18n:check`).
- **Echter Lauf** am Tisch des Nutzers: Marker frei verteilt → 16:9-Ausschnitt rechtwinklig;
  D-Abschnitt nach C-Abschnitt blendet über; Export gegen Vorschau; Eintrag im Results-Log von
  `technical-documentation/testing/manual-e2e-checklist.md`.
