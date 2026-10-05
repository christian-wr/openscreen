# Mehrere Kameras im Bild — Design, Teilprojekte 2 und 3

Stand: 2026-10-05 · Branch: `feat/multi-camera-layouts` (= Teilprojekt 1 `feat/multi-camera` + Schreibtisch-Ansicht `feat/desk-view`, PR #989)

## Ziel

Teilprojekt 1 nimmt unter Windows bis zu 4 Kameras auf und speichert sie im Projekt
(`asset.cameraTrack` = Kamera 1, `asset.additionalCameraTracks` = Kameras 2–4). Gezeigt wird bisher
nur Kamera 1. Diese beiden Teilprojekte bringen alle Kameras ins Bild:

- **Teilprojekt 2 — Compositor:** Vorschau und Export zeichnen mehrere Kamera-Ebenen gleichzeitig,
  auf allen drei Plattformen (D3D11, Metal, Vulkan).
- **Teilprojekt 3 — Editor:** Layout-Abschnitte auf der Timeline legen fest, welche Kamera wo zu sehen
  ist; Kamera-Einstellungen gelten pro Kamera.

**Erfolg heißt:** Mit einer Aufnahme aus Bildschirm, Tischkamera und Gesichtskamera lassen sich im
Editor Abschnitte bauen wie „Bildschirm + Gesicht klein“, „Tisch voll + Gesicht klein“, „Gesicht |
Tisch nebeneinander“ und „Bildschirm + Gesicht + Tisch klein“; der Wechsel gleitet; Vorschau und Export
zeigen dasselbe. Projekte mit nur einer Kamera und alte Projekte sehen unverändert aus.

## Entscheidungen (mit dem Nutzer abgestimmt)

- Gewünscht sind alle vier Ansichten: Tisch groß + Gesicht klein; Kamera im Bild-im-Bild pro Abschnitt
  wechseln; zwei Kameras nebeneinander; mehrere Bild-im-Bild gleichzeitig.
- Bedienung über **Layout-Abschnitte** auf der Timeline (wie heute Full Camera), je Abschnitt eine
  Vorlage und die Zuordnung Kamera → Platz; außerhalb gilt das Standard-Layout des Projekts. Kein
  freies Keyframing.
- Übergang zwischen Abschnitten: **fließend gleiten** (~0,4 s), neu erscheinende Kameras blenden ein,
  verschwindende aus.
- Ansatz: **echte Kamera-Ebenen im Compositor** (kein vorab gerendertes Mosaik, keine DOM-Ebene).
- **Hintergrund-Effekte** (Personenmaske: Unschärfe/Entfernen) bleiben vorerst auf Kamera 1; die
  übrigen Kamera-Einstellungen gelten für jede Kamera.
- **Perspektivkorrektur per Homographie** für statische Kameras (Tischkamera schräg vom Monitorrand):
  einmal kalibrieren, auf jeden Frame anwenden. Kalibrierung über 4 ziehbare Eckpunkte, optional
  vorbelegt durch erkannte ArUco-Marker (die App liefert ein druckbares Markerblatt). Ergebnis zeigt
  **nur das Rechteck** zwischen den 4 Punkten in einem gewählten Zielformat (A4 hoch/quer, 16:9, 4:3,
  quadratisch, frei), optional mit kleinem Rand.
- Reihenfolge: erst Teilprojekt 2, dann 3 — jedes mit eigenem Plan und Review. Der Shader-Teil der
  Perspektivkorrektur gehört zu Teilprojekt 2, der Kalibrier-Dialog zu Teilprojekt 3.

## Nicht in diesem Schritt

- Hintergrund-Effekte für die Kameras 2–4 (eine Personenmaske pro Kamera).
- Freie Leinwand mit Keyframes; eigene Übergangsarten pro Abschnitt.
- Aufnahme mehrerer Kameras unter macOS/Linux (Teilprojekt 1 ist Windows-only; die Anzeige hier
  funktioniert überall, wo die Dateien vorhanden sind).
- Zuordnung des tatsächlich in der HUD gewählten Geräts bei mehreren gleichen Kameras (bekannte
  Einschränkung aus Teilprojekt 1; der Editor erlaubt stattdessen, jede Kamera jedem Platz zuzuweisen).
- Mehr als 4 Kameras.

## 1. Datenmodell

### Kamera-Einstellungen (pro Kamera)

Neue optionale Liste im Projekt, Index = Kamera (0 = Kamera 1):

```ts
interface CameraSettings {
	rotation?: 0 | 180;   // fehlt = 0
	mirror?: boolean;     // fehlt = Projekt-Spiegel (`webcamMirrored`) für Kamera 1, aus für die übrigen
	crop?: SceneCrop;     // fehlt = ganzes Bild; Kamera 1 nutzt weiterhin den bestehenden Crop
	perspective?: CameraPerspective; // fehlt = keine Korrektur
}

interface CameraPerspective {
	// Die 4 Quellpunkte im Kamerabild, normiert 0..1, Reihenfolge oben-links, oben-rechts,
	// unten-rechts, unten-links (aus Sicht des fertigen, entzerrten Bildes).
	corners: [Point, Point, Point, Point];
	aspect: number;   // Zielformat Breite/Höhe, z. B. 297/210 für A4 quer
	margin?: number;  // Rand um das Rechteck, Anteil der Rechteckgröße, 0..0.2; fehlt = 0
}
```

Gespeichert werden die Punkte, nicht die Matrix: die Matrix (3×3, Ziel → Quelle) wird bei Bedarf aus
den 4 Punktpaaren berechnet (`src/lib/cameraPerspective.ts`, eine Stelle für App und Szene). Mit
gesetzter Perspektive ist der Zuschnitt (`crop`) wirkungslos und im Editor ausgegraut. Ein
degeneriertes Viereck (Punkte kollinear, überschlagen) wird abgelehnt.

```ts
```

Kamera 1 behält ihre heutigen Einstellungen an den heutigen Stellen; die Liste trägt nur
Abweichungen und die Kameras 2–4.

### Layout-Abschnitte

```ts
type CameraLayoutTemplate =
	| "screen-pip"        // Bildschirm + 1–3 kleine Kameras
	| "camera-full"       // eine Kamera füllt den Rahmen
	| "camera-full-pip"   // eine Kamera voll + 1–2 kleine Kameras
	| "side-by-side";     // zwei Kameras je halber Rahmen, ohne Bildschirm

interface CameraLayoutSlot {
	camera: number;            // 0..3, jede Kamera höchstens einmal pro Abschnitt
	rect?: NormalizedRect;     // vom Nutzer verschoben/skaliert; fehlt = Vorlage
}

interface CameraLayoutRegion {
	id: string;
	startMs: number;
	endMs: number;
	template: CameraLayoutTemplate;
	slots: CameraLayoutSlot[]; // Anzahl je Vorlage, Reihenfolge = Plätze der Vorlage
	// Schreibtisch-Ansicht aus #989, nur bei camera-full: Drehung/Spiegel dieses Abschnitts
	// überschreiben die Kamera-Einstellung; deskLabel steuert das Label der verdeckten Kippung.
	rotation?: 0 | 180;
	mirror?: "auto" | "on" | "off";
	deskLabel?: false;
}
```

Gespeichert in `legacyEditor.cameraLayoutRegions` neben den bestehenden Regionen, mit derselben
Verankerung pro Clip wie `cameraFullscreenRegions` (`migrate.ts`, Kürzel z. B. `"camlayout"`).
Abschnitte überlappen sich nicht (Regel wie bei Full Camera).

### Bestehende Projekte

- **Zwei getrennte Listen, nie beide:** Ein Abschnitt `camera-full` mit Kamera 1 ist immer eine
  Full-Camera-Region und steht in `cameraFullscreenRegions` (mit `rotation`/`mirror`/`deskLabel`);
  jeder andere Abschnitt steht in `cameraLayoutRegions`. Beide Listen sind gleich pro Clip verankert
  (`clipId`, `assetId`, `sourceStartSec`, `sourceEndSec`, abgeleitet `startMs`/`endMs`) und folgen
  Clip-Änderungen gemeinsam.
- **Beim Laden:** nichts umzuwandeln. Alte Full-Camera-Regionen bleiben, wo sie sind, und ältere
  OpenScreen-Versionen zeigen sie weiter; die neuen Vorlagen sehen ältere Versionen nicht (additiv,
  kein Schema-Versionssprung). Der Normalizer verwirft eine Zeile `camera-full` mit Kamera 1 in
  `cameraLayoutRegions`; der Szenenbau übernimmt eine solche handgeschriebene Zeile nur, wenn keine
  Full-Camera-Region dieselbe Spanne abdeckt (nie doppelt).
- **Eine gemeinsame Spur:** Abschnitte beider Listen überlappen sich nicht. Der Editor verhindert das
  (Hinzufügen lehnt ab, Verschieben/Skalieren klemmt an Nachbarn beider Listen); der Normalizer
  verwirft nur Überlappungen innerhalb von `cameraLayoutRegions`.
- Projekte ohne weitere Kameras und ohne neue Abschnitte bleiben byte-gleich, solange niemand sie
  anfasst.

## 2. Compositor (Teilprojekt 2)

### Szene

`SceneClip` bekommt optional die weiteren Kameras des Clips (Pfad und Zeitversatz wie
`webcam_path`/`webcam_offset_sec`). Die Szene bekommt:

- `cameras`: Einstellungen pro Kamera (Drehung, Spiegel, Crop, Seitenverhältnis) — Kamera 1 bleibt
  zusätzlich über die heutigen Felder beschrieben;
- `camera_layout_regions`: pro Abschnitt Start/Ende und die **aufgelösten Zielebenen** — je Ebene
  Kamera-Index, Zielrechteck (Anteile des Ausgaberahmens), Eckenradius, Form, Ebenen-Reihenfolge
  und ob die Ebene den Rahmen füllt.

Pro Kamera mit Perspektive sendet die App die fertige 3×3-Matrix (Ziel-UV → Quell-UV) und das
Zielformat mit; das Seitenverhältnis der Kamera-Ebene ist dann das Zielformat.

Ohne weitere Kameras und ohne Layout-Abschnitte sendet die App diese Felder nicht; der Compositor
verhält sich dann exakt wie heute.

### Auflösung der Vorlagen (App, TypeScript)

Eine Stelle in `src/lib/compositeLayout.ts` (neben `computeCompositeLayout`) übersetzt Vorlage +
Plätze + Nutzer-Rechtecke + Seitenverhältnisse in Zielebenen. Das Standard-Layout außerhalb der
Abschnitte ist das heutige (Bildschirm + Kamera 1 nach `webcamLayoutPreset`). `sceneDescription.ts`
projiziert die Abschnitte wie die übrigen Regionen auf die Clips der Timeline.

### Pro Frame (Rust)

- `regions.rs`: zur Zeit `t` der aktive Abschnitt und die Übergangsphase (dieselbe Fensterlänge und
  Kurve wie das Wachsen der Full Camera).
- `frame_geometry.rs`: eine Liste von Kamera-Ebenen statt des einen Webcam-Rechtecks. Im Übergang
  wird jedes Ziel zwischen altem und neuem Layout interpoliert (Rechteck, Radius); eine Kamera, die
  nur auf einer Seite vorkommt, blendet über die Deckkraft ein bzw. aus. Kamera 1 ohne Abschnitte
  ergibt genau die heutigen Werte (Regressionstest).
- Die Schreibtisch-Ansicht aus #989 (Drehung, Vollbild ohne Crop, verdeckte Kippung) wirkt auf die
  Ebene der Kamera im Abschnitt `camera-full` und nur, wenn der Abschnitt die Drehung selbst setzt.

### Dekodieren

- Pro Clip ein Decoder je Kamera, mit eigenem Zeitversatz (`live.rs`, Export-Pipelines je Plattform).
- Dekodiert wird nur, was das Layout im aktuellen Frame oder im laufenden/nächsten Übergang zeigt;
  ein Decoder öffnet beim ersten Bedarf und bleibt für den Clip offen.
- Fehlt die Datei einer Kamera: die Ebene entfällt, der Rest wird gezeichnet (wie heute die
  Ersatz-Kamera für Clips ohne Kamera).

### Zeichnen

- Jede Ebene mit dem bestehenden Kamera-Shader und eigenem `LayerCB`; kein neuer Shader.
- **Perspektive:** der Kamera-Shader bekommt eine optionale 3×3-Homographie im `LayerCB` (drei
  `float4`-Zeilen, hinten angehängt — Rust, HLSL, WGSL und MSL gleich, vom bestehenden
  Größen-/Offset-Test festgehalten). Pro Pixel: `q = H · (u, v, 1)`, Quell-UV = `q.xy / q.z`; außerhalb
  des Kamerabildes transparent. Ohne Korrektur ist `H` die Einheitsmatrix und das Ergebnis bit-gleich
  zu heute. Die Personenmaske (Kamera 1) wird über dieselbe UV abgetastet und dreht mit. Die drei Backends ersetzen den einen Aufruf durch eine Schleife in der
  Ebenen-Reihenfolge: Kameras, die den Rahmen füllen (`camera-full`, `side-by-side`), verdecken den
  Bildschirm wie heute die Full Camera; Bild-im-Bild liegt darüber, wie heute Kamera 1. Bildschirm
  plus zwei Kameras ist `screen-pip` mit zwei Plätzen.
- Hintergrund-Effekte nur auf Kamera 1 (Personenmaske wie heute).

### Leistung

Zielwerte, gemessen und im Plan als Prüfschritt: Vorschau mit Bildschirm + 2 Kameras in 1080p ohne
merkliche Ruckler auf dem Referenzrechner (Windows on ARM, Snapdragon X Elite); Export mit 3
Kameras nicht mehr als doppelt so lang wie mit einer. Werden die Ziele verfehlt, wird das gemessen
berichtet und nicht stillschweigend hingenommen.

## 3. Editor (Teilprojekt 3)

### Perspektive kalibrieren

- In der Kamera-Liste je Kamera „Perspektive korrigieren…“: Dialog mit Standbild der Kamera (Frame
  an der Abspielposition), 4 ziehbare Eckpunkte mit Lupe, Zielformat, Rand, Vorschau des
  entzerrten Ergebnisses, „Zurücksetzen“.
- „Marker erkennen“: sucht 4 ArUco-Marker (Wörterbuch 4×4) im Standbild mit einer kleinen
  JavaScript-Bibliothek (kein OpenCV) und setzt die Eckpunkte auf die inneren Ecken der Marker;
  findet sie nicht alle 4, sagt er das und lässt die Punkte unverändert.
- „Markerblatt drucken“: ein PDF/A4 mit den 4 Markern zum Ausschneiden und einer kurzen Anleitung.
- Ein Undo-Schritt pro bestätigter Kalibrierung.

### Timeline

- Die Full-Camera-Zeile wird zur Zeile „Layout“. Taste `C` legt wie bisher einen Abschnitt
  `camera-full` mit Kamera 1 an; eine Schaltfläche legt einen Abschnitt mit wählbarer Vorlage an.
- Jeder Abschnitt zeigt ein Symbol der Vorlage und die beteiligten Kameras (z. B. „Tisch + Gesicht“);
  gedrehte Abschnitte behalten das Dreh-Symbol aus #989.

### Inspector

- Vorlage wählen; je Platz eine Kamera-Auswahl („Kamera 1 · Logitech BRIO“, „Kamera 2 · HD Pro
  Webcam C920“ — Name = `label` aus dem Projekt, sonst „Kamera n“). Eine Kamera kann pro Abschnitt
  nur einmal vorkommen; beim Wechsel der Vorlage werden die Plätze in Reihenfolge übernommen.
- In der Vorschau verschobene/skalierte Kamerafenster speichern ihr Rechteck in diesem Abschnitt;
  „Zurücksetzen“ stellt die Vorlage wieder her.
- Abschnitte `camera-full` behalten die Schalter der Schreibtisch-Ansicht (#989).
- Abschnitt „Kameras“ im Projekt-Inspector: Liste aller Kameras mit Name und kleinem Vorschaubild,
  je Kamera Drehung 0°/180°, Spiegeln, Zuschnitt.
- Hat das Projekt nur eine Kamera: Auswahl bietet nur Kamera 1, Vorlagen mit mehreren Kameraplätzen
  sind ausgegraut mit Hinweis.

### Bedienregeln

- Jede Änderung ist ein Undo-Schritt (`useEditorHistory`), wie bei der Schreibtisch-Ansicht.
- Texte in allen Locales (`npm run i18n:check`).

## 4. Fehlerfälle

- Kameradatei fehlt oder lässt sich nicht öffnen: ihre Plätze bleiben leer, der Abschnitt zeigt den
  Rest, der Editor zeigt einen Hinweis mit dem Kameranamen.
- Abschnitt verweist auf eine Kamera, die das Projekt nicht hat (z. B. nach Relink): Platz leer,
  Hinweis, Projekt öffnet.
- Unbekannte Vorlage aus einer späteren Version: beim Laden verworfen, das Projekt öffnet.
- Kamera ist kürzer als der Abschnitt (z. B. vorzeitig beendet): nach ihrem Ende bleibt der Platz leer.

## 5. Tests und Abnahme

- **Perspektive:** Homographie aus 4 Punktpaaren bildet die Ecken exakt aufeinander ab; degenerierte
  Vierecke abgelehnt; Einheitsmatrix lässt den Shader-Ausgang bit-gleich; gemessener Export mit
  einem schräg aufgenommenen Schachbrett ergibt rechte Winkel und gleiche Feldgrößen; Marker-Erkennung
  an einem gerenderten Testbild. Echter Lauf: Tischkamera mit A4-Blatt und Markerblatt.
- **Rust:** Ebenenliste aus Szene und Zeit; Übergang interpoliert Rechteck/Radius und blendet
  ein-/ausfallende Kameras; ohne Abschnitte identisch zu heute; Schreibtisch-Ansicht auf der richtigen
  Ebene; naga-Validierung unverändert grün.
- **TS:** Auflösung jeder Vorlage (inkl. Nutzer-Rechtecke, Seitenverhältnisse); Laden alter
  Full-Camera-Regionen; Schreiben der Rückwärtskompatibilität; Kamera-Einstellungen; Undo;
  Inspector (jsdom).
- **Export, gemessen:** Headless-Export mit synthetischen Kameras unterschiedlicher Farbe — Position
  und Größe jeder Ebene im Steady-State und im Übergang aus den Pixeln gemessen; Vorschau-Frame und
  Export-Frame an derselben Stelle verglichen.
- **Echter Lauf (Nutzer mit 2 Brios, C920, eingebauter Kamera):** Abschnitte „Tisch voll + Gesicht
  klein“, „Bildschirm + 2 PiP“, „nebeneinander“, gleitender Wechsel, MP4-Export; Leistung der Vorschau
  mit mehreren Kameras. Ergebnis ins Results-Log von
  `technical-documentation/testing/manual-e2e-checklist.md`.

## 6. Verbindliche Vorgaben für Teilprojekt 3 (aus den Reviews von Teilprojekt 2)

- **Speichern:** Zwei getrennte Listen. Full Camera von Kamera 1 (`camera-full` mit Kamera 1) steht
  nur in `cameraFullscreenRegions`, jeder andere Abschnitt nur in `cameraLayoutRegions`; der Szenenbau
  liest immer beide. Die frühere Regel „liegt `cameraLayoutRegions` vor, wird die alte Liste
  ignoriert“ gilt nicht mehr.
- **Kamera-1-Einstellungen:** Drehung, Spiegeln und Zuschnitt von Kamera 1 stehen weiter in den
  bestehenden Projektfeldern (`webcamMirrored`, Schreibtisch-Abschnitte, `webcamCropRegion`), nicht in
  `cameraSettings[0]`; für Kamera 1 wertet der Compositor aus `cameraSettings[0]` nur die Perspektive.
- **Schreibtisch-Schalter** nur bei `camera-full` mit Kamera 1 anbieten (der Normalizer verwirft sie
  sonst).
- **Vorlagen bei Block-Layouts** (`dual-frame`, `vertical-stack`): Bild-im-Bild-Vorlagen ausgrauen oder
  den Bildschirm neu anordnen — sonst bleibt eine Hälfte leer.
- **Form:** Ein runder/quadratischer Platz braucht ein quadratisches Rechteck und Radius 0,5; beim
  Verschieben/Skalieren im Editor das Seitenverhältnis halten (das Backend liest die Form nicht).
- **Fehlende Kamera:** Fehlt eine Kamera schon im Projekt (Spur fehlt/unsichtbar), entfällt ihr Platz
  und ein Abschnitt ohne Plätze wird verworfen; lässt sich nur die Datei nicht öffnen, bleibt der
  Abschnitt und die Kamera fehlt im Bild. Der Hinweis im Editor muss das jeweilige Ergebnis nennen.
- **Nahtstelle Full Camera ↔ Layout-Abschnitt:** gleitet direkt; die Unschärfe eines gedrehten
  Abschnitts endet dort mit ihrer eigenen Blende (sichtbarer Schnitt im Vollbild) — im Editor
  gegebenenfalls einen Hinweis geben oder die Kippung an solche Nahtstellen nicht legen.
- **Zuordnung gleicher Kameras** folgt der Windows-Reihenfolge (Teilprojekt 1): jede Kamera muss jedem
  Platz frei zuweisbar sein.
