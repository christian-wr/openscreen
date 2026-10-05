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
- Reihenfolge: erst Teilprojekt 2, dann 3 — jedes mit eigenem Plan und Review.

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
}
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

- **Beim Laden:** jede `cameraFullscreenRegion` wird zu einem Layout-Abschnitt `camera-full` mit
  Kamera 1 und übernimmt `rotation`/`mirror`/`deskLabel`. Gibt es bereits `cameraLayoutRegions`,
  gelten diese, und alte Full-Camera-Regionen werden nicht doppelt übernommen.
- **Beim Speichern:** zusätzlich zu `cameraLayoutRegions` werden alle Abschnitte `camera-full` mit
  Kamera 1 auch als `cameraFullscreenRegions` geschrieben, damit ältere OpenScreen-Versionen sie weiter
  zeigen. Andere Vorlagen sehen ältere Versionen nicht (additiv, kein Schema-Versionssprung).
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

- Jede Ebene mit dem bestehenden Kamera-Shader und eigenem `LayerCB`; kein neuer Shader, keine
  Änderung am `LayerCB`-Layout. Die drei Backends ersetzen den einen Aufruf durch eine Schleife in der
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
