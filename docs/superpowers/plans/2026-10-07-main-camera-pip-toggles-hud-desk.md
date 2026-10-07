# Hauptkamera, Kamera-Schalter, Tischkamera im HUD — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** (D) Kameras eines „Bildschirm + Kamera“-Abschnitts per Schalter; (C) eine wählbare Hauptkamera, die die Rolle von Kamera 1 übernimmt; (E) die Tischkamera als HUD-Vorgabe, die neue Projekte übernehmen.

**Architecture:** D ist ein neuer Store-Schreiber plus Inspector-Liste. C ist eine reine Dokument-Transformation am Eingang des Szenenaufbaus (`withMainCamera(document)` tauscht Kamera 0 und die Hauptkamera in Assets, Kamera-Einstellungen, Layout-Abschnitten und Tischkamera), dazu eine Auswahl im Kamera-Layout-Bereich; Compositor unverändert. E führt die HUD-Wahl als Index durch Aufnahme-Anfrage und Sitzungsdatei bis `projectStore.addAsset`.

**Tech Stack:** TypeScript (strict), React 19, Electron IPC, Vitest (node + jsdom), Biome, i18next (15 Locales), Playwright `_electron`.

**Spec:** `docs/superpowers/specs/2026-10-07-main-camera-pip-toggles-hud-desk-design.md`

## Global Constraints

- Arbeitsverzeichnis `C:\osc-cams`, Branch `feat/multi-camera-layouts`; nichts pushen.
- Keine Änderung an Rust/Shadern/Compositor; keine Schema-Version (neue Felder optional in `legacyEditor` bzw. Sitzungsdatei/Prefs).
- Projekte ohne `mainCamera` / ohne neue Felder: Szene und Dokument unverändert.
- Kamera-Indizes in `cameraSettings`, Layout-Abschnitten und `deskCamera` meinen das Gerät, nie die Rolle.
- Verfügbarkeit einer Kamera: dieselbe Regel wie die Tischkamera (`projectCameraAvailable` in `cameraList.ts`).
- Ein Schreibvorgang = ein Undo-Schritt; Schreiber aus dem Inspector/Layout-Bereich laufen über die Schreib-Warteschlange der Shell (`enqueueTimelineWrite`, wie `setCameraSettingsQueued`).
- Code-Kommentare Englisch; Biome; kein `any`; jeder UI-Text in allen 15 Locales (Desk-/Kamera-Vokabular der jeweiligen Sprache wiederverwenden); `npm run i18n:check` grün.
- Keine Claude-Signatur und kein `Co-Authored-By` in Commits.
- Prüfen pro Task: fokussierte Tests, beide `tsc`; volle Suite (`npm run test`) einmal je Teil im letzten Code-Task des Teils.

## Review Focus

- **Hauptkamera = Tischkamera**: D-Abschnitt wird Full-Camera-Zeile, genau ein Label — Test in Task C2.
- **Hauptkamera nicht verfügbar** (Datei weg / Index zu groß): Szene wie ohne Hauptkamera, Editor zeigt Hinweis — Tests C1, C2, C3.
- **Layout-Abschnitt mit Kamera 0 und der Hauptkamera zugleich** (z. B. „Bildschirm + Kamera“ mit Kamera 1 und 2, Hauptkamera 2): beide Indizes werden getauscht, nicht doppelt — Test C2.
- **Schalter „Bildschirm + Kamera“ bei verschobenem Fenster**: Position bleibt bei seiner Kamera, wenn eine andere ein-/ausgeschaltet wird — Test D1.
- **HUD: gewählte Tischkamera wird nicht mehr aufgenommen** (abgehakt / abgesteckt): als „Keine“ behandelt, Sitzungsdatei ohne `deskCamera` — Test E1.

---

## Teil D — „Bildschirm + Kamera“ mit Schaltern

### Task D1: Store-Schreiber `setLayoutSectionCameras`

**Files:** Modify `src/lib/ai-edition/store/useTimeline.ts` (neben `setLayoutSlotCamera`, ~l.1632); Test `src/lib/ai-edition/store/useTimeline.test.ts` (nach Muster der `setLayoutSlotCamera`-Tests); ggf. `documentWriteAudit`-Tabelle ergänzen.

**Interfaces — Produces:** `setLayoutSectionCameras(handle: { kind: "cameraLayout"; id: string }, cameras: number[]): Promise<"set" | "too-few" | "too-many" | "unchanged">` auf dem Rückgabeobjekt von `useTimeline`.

**Verhalten:** Neue `slots` = `cameras` dedupliziert, aufsteigend sortiert, je Kamera der vorhandene Slot (mit seinem `rect`) wiederverwendet, sonst `{ camera }`. Weniger als `TEMPLATE_SLOTS[template].min` → `"too-few"`, mehr als `max` → `"too-many"`, nichts geschrieben. Gleiche Liste → `"unchanged"`, nichts geschrieben. Sonst eine Speicherung mit Verlauf (`patchPillById` + `withCameraLanes`, alle Zeilen der Pille), `"set"`.

- [ ] **Step 1: Failing tests:** (1) screen-pip mit `[0]` → `setLayoutSectionCameras(h, [2, 0])` → slots `[{camera:0},{camera:2}]`; (2) Slot von Kamera 2 mit `rect` bleibt erhalten, wenn Kamera 1 dazukommt (`[0,1,2]` → rect an Kamera 2 unverändert); (3) `[]` → `"too-few"`, Dokument unverändert; (4) vier Kameras → `"too-many"`; (5) gleiche Liste → `"unchanged"`, kein Undo-Eintrag; (6) ein Aufruf = ein Undo-Schritt.
- [ ] **Step 2:** FAIL prüfen. **Step 3:** implementieren. **Step 4:** Tests + tsc. **Step 5:** Commit `feat(camera): set a layout section's cameras as a set`.

### Task D2: Inspector-Schalter für „Bildschirm + Kamera“

**Files:** Modify `src/components/ai-edition/v4/LayoutSectionPane.tsx` (Kamera-Plätze ~l.141-177) und Test daneben; `src/components/ai-edition/NewEditorShell.tsx` (Schreiber über die Warteschlange durchreichen, wie `setCameraSettingsQueued`); Locales `settings.json` (15).

**Verhalten:** Nur bei `template === "screen-pip"`: statt der Auswahllisten eine Liste „Kameras“ mit einem Schalter (`role="switch"`/vorhandene `Toggle`-Komponente, Name = Kameraname wie im Abschnitt „Kameras“) pro Projektkamera; an = Kamera hat ein Fenster. Gesperrt: der einzige eingeschaltete (Hinweis `layoutSection.minOneCamera` „Mindestens eine Kamera“), alle ausgeschalteten bei drei eingeschalteten (Hinweis `layoutSection.maxThreeWindows` „Höchstens drei Fenster“), ausgeschaltete nicht verfügbare Kameras. Umschalten ruft den Schreiber aus D1 mit der neuen Menge. Andere Vorlagen unverändert.

- [ ] **Step 1: Failing tests (jsdom):** Schalter je Kamera mit Kameranamen; Einschalten ruft Schreiber mit `[…bisher, neu]`; einziger an → gesperrt + Hinweis; drei an → übrige gesperrt + Hinweis; nicht verfügbare aus → gesperrt; Vorlage `side-by-side` zeigt weiter Auswahllisten.
- [ ] **Step 2:** FAIL. **Step 3:** implementieren (+ Texte 15 Locales). **Step 4:** fokussierte Tests, tsc ×2, `npm run lint`, `npm run i18n:check`, **`npm run test`**. **Step 5:** Commit `feat(camera): switch cameras on and off in a screen + camera section`.

### Task D3: App-Lauf D (Controller, Playwright)

- [ ] `npm run build-vite`; neues Skript `scripts/editor-pip-switches-smoke.mjs` nach Muster von `scripts/editor-desk-smoke.mjs` (Kopie von `proj_5989a8b4-6b0f-46e8-b7bf-b22c77703c57`, Projektordner per Hash prüfen): „Bildschirm + Kamera“-Abschnitt anlegen → Inspector → Kamera 2 einschalten (Datei: zwei Slots, Vorschau-Screenshot mit zwei Fenstern) → Kamera 1 ausschalten (ein Slot, Kamera 2) → letzten Schalter gesperrt → Undo/Redo → speichern, neu starten, gleich. Screenshots ansehen. Results-Log-Zeile, Commit `test: scripted screen + camera switch pass`.

---

## Teil C — Hauptkamera

### Task C1: Kern — `resolveMainCamera` und `withMainCamera`

**Files:** Create `src/lib/mainCamera.ts`, `src/lib/mainCamera.test.ts`.

**Interfaces — Produces:**
- `resolveMainCamera(input: { mainCamera: unknown; cameraCount: number; available: (index: number) => boolean }): number` — gewählte Kamera wenn ganzzahlig, `0 <= i < cameraCount` und verfügbar; sonst `0`.
- `withMainCamera(document: AxcutDocument): AxcutDocument` — liest `legacyEditor.mainCamera`, löst mit `projectCameraCount`/`projectCameraAvailable` auf; bei `m === 0` **dasselbe Objekt** zurück; sonst ein neues Dokument, in dem Kamera 0 und *m* vertauscht sind:
  - jedes Asset: `cameraTrack` ↔ `additionalCameraTracks[m-1]` (nur Assets, die beide haben; sonst unverändert);
  - `legacyEditor.cameraSettings`: Eintrag 0 ↔ Eintrag *m*, **aber** Drehung/Spiegeln/Zuschnitt der Hauptkamera kommen aus den Layout-Reglern (die Legacy-Felder bleiben, wie sie sind, und gelten nun für Index 0): im neuen Eintrag 0 bleibt nur `perspective` aus dem alten Eintrag *m*; der neue Eintrag *m* ist der alte Eintrag 0 (Einstellungen der echten Kamera 1) vollständig;
  - `cameraLayoutRegions[].slots[].camera` und `deskCamera`: 0 ↔ *m* (jeder Wert genau einmal abgebildet);
  - `mainCamera` entfernt (die Szene sieht nur noch Kamera 0 als Rolle).

- [ ] **Step 1: Failing tests:** `resolveMainCamera` (gewählt+verfügbar → i; außer Bereich → 0; nicht verfügbar → 0; fehlt/kein Integer → 0). `withMainCamera`: ohne Feld → `toBe(document)`; *m* = 2 → `cameraTrack`/`additionalCameraTracks[1]` getauscht; `cameraSettings` getauscht nach obiger Regel (Perspektive von 2 landet bei 0, Drehung von 2 nicht); Slots `[0,2]` → `[2,0]`; `deskCamera: 2` → `0`, `deskCamera: 0` → `2`, `deskCamera: 1` → `1`; Hauptkamera nicht verfügbar → `toBe(document)`.
- [ ] **Step 2–5:** FAIL, implementieren, grün + tsc, Commit `feat(camera): the main camera as a document transform`.

### Task C2: Szene benutzt `withMainCamera`

**Files:** Modify `src/native/sceneDescription.ts` (Eingang von `buildSceneDescription`; Stellen, die das Dokument für Kameras/Layout/Tischkamera lesen) und Test.

**Verhalten:** `buildSceneDescription` arbeitet auf `withMainCamera(document)`. Prüfen, dass jede Stelle, die Kameras liest (Clip-`webcamPath`/`additionalCameras` ~l.1202-1219, `webcamSourceSizeOf` ~l.1472, `cameras[]` ~l.1594, Layout-Regionen ~l.1557, Tischkamera ~l.1329), das transformierte Dokument benutzt. Clip-/Asset-Ids bleiben gleich, also bleiben Verankerungen gültig.

- [ ] **Step 1: Failing tests:** Zwei-Kamera-Fixture, `mainCamera: 1` → Clip `webcamPath` = Pfad von Kamera 2, `additionalCameras[0]` = Pfad von Kamera 1; Preset-Quellmaße aus Kamera 2; Layout-Abschnitt mit Slot 1 → in der Szene Slot 0; `deskCamera: 1` + D-Abschnitt → Full-Camera-Zeile, genau ein Label; `deskCamera: 0` + D-Abschnitt → `camera-full`-Layout mit Kamera 1 (Index 1 in der Szene); Hauptkamera nicht verfügbar → Szene `toEqual` der Szene ohne `mainCamera`; ohne Feld → wörtliche Erwartungswerte (vorhandener Leitplanken-Test bleibt grün).
- [ ] **Step 2–5:** FAIL, implementieren, grün + tsc, Commit `feat(camera): the scene draws the main camera in camera 1's place`.

### Task C3: Editor — Auswahl „Hauptkamera“, Kameras-Abschnitt, Store

**Files:** Modify `src/lib/ai-edition/store/useTimeline.ts` (`mainCamera` aufgelöst, `mainCameraChosen`, `setMainCamera(index | null)`), `src/components/ai-edition/RightPanes.tsx` (`LayoutPane`, neben „Preset“), `src/components/ai-edition/CamerasSection.tsx` (Regler-Notiz und Einstellungs-Zeilen an der Hauptkamera statt fest an Index 0), `src/components/ai-edition/NewEditorShell.tsx` (Warteschlange), Locales `settings.json` (15); Tests daneben.

**Verhalten:**
- Store: `mainCamera: number` (aufgelöst, mit `resolveMainCamera`, gleiche Verfügbarkeit wie Szene), `mainCameraChosen: number | null` (gespeichert, roh), `setMainCamera(i)` schreibt/entfernt `legacyEditor.mainCamera` (`null` oder `0` → Feld entfernt), ein Undo-Schritt, nichts bei unveränderter Wahl.
- Kamera-Layout-Bereich: Auswahl „Hauptkamera“ (`settings.layout.mainCamera`), sichtbar ab zwei Projektkameras, Einträge mit Kameranamen (`projectCameraLabel`), nicht verfügbare deaktiviert; gewählt aber nicht verfügbar → Hinweis `settings.layout.mainCameraUnavailable` („Nicht verfügbar — verwendet wird {{camera}}“).
- Abschnitt „Kameras“: die Zeile der **Hauptkamera** zeigt die Notiz „Ihre Regler stehen oben“ (bisheriger Text `cameras.camera1Hint` sinngemäß angepasst auf „Hauptkamera“) und keine Drehung/Spiegeln/Zuschnitt-Zeilen; alle anderen Kameras — auch Kamera 1, wenn nicht Hauptkamera — zeigen sie und schreiben in `cameraSettings[i]`.

- [ ] **Step 1: Failing tests:** Store (setzen/entfernen/Undo, roh vs aufgelöst bei verlorener Wahl); LayoutPane (Auswahl erst ab zwei Kameras, Aufruf mit Index, Hinweis bei verlorener Wahl); CamerasSection (Hauptkamera 2 → Kamera 1 hat Drehung/Spiegeln/Zuschnitt, Kamera 2 die Notiz).
- [ ] **Step 2–5:** FAIL, implementieren (+ 15 Locales), fokussierte Tests, tsc ×2, lint, i18n, **`npm run test`**, Commit `feat(camera): choose the main camera in the layout pane`.

### Task C4: App-Lauf C (Controller, Playwright)

- [ ] Skript `scripts/editor-main-camera-smoke.mjs` (Muster wie D3): Hauptkamera auf Kamera 2 → Datei `mainCamera: 1` → Vorschau außerhalb von Abschnitten zeigt Kamera 2 als PiP (Screenshot gegen vorher deutlich verschieden) → C-Abschnitt zeigt Kamera 2 im Vollbild → Kameras-Abschnitt: Kamera 1 hat Drehung/Spiegeln → Undo/Redo → speichern, neu starten → CLI-Export, Bild im Preset- und im C-Bereich gegen Vorschau. Screenshots ansehen. Results-Log-Zeile, Commit.

---

## Teil E — Tischkamera im HUD

### Task E1: Prefs, Aufnahme-Anfrage und Sitzungsdatei

**Files:** Modify `electron/app-settings.ts` (Key `recording.camDeskDevice`, Muster `camAdditionalDevices` ~l.82-131, 227-235), Preload/Typen der Prefs, `src/components/launch/LaunchWindow.tsx` (Zustand + `persistRecordingPrefs`, ~l.862-960), `src/hooks/useScreenRecorder.ts` (~l.1301-1343: `deskCamera`-Index in die Anfrage), `electron/ipc/handlers.ts` (Sitzungsdatei ~l.1409-1425; `findRecordingCamera` ~l.1909-1970 liefert `deskCamera` mit), `src/lib/recordingSession.ts` (normalisieren); Tests daneben.

**Interfaces — Produces:**
- Pref `camDeskDevice: { id: string | null; name: string } | null`.
- Pure Funktion (neu, z. B. in `src/lib/additionalWebcams.ts`): `deskCameraIndex(desk: {id,name} | null, camera1: {id,name} | null, recorded: Array<{id,name}>): number | undefined` — 0 wenn Kamera 1, *k* wenn die *k*-te zusätzliche aufgenommene, sonst `undefined` (gleiche Gleichheitsregel wie `isSameCamera`: id, sonst Name).
- Sitzungsdatei/`findRecordingCamera`-Ergebnis: optionales `deskCamera: number`.

- [ ] **Step 1: Failing tests:** `deskCameraIndex` (Kamera 1 → 0; zweite zusätzliche → 2; nicht aufgenommen → undefined; null → undefined); Prefs lesen/schreiben (Muster der `camAdditionalDevices`-Tests); `recordingSession` normalisiert `deskCamera` (gültig/ungültig); `findRecordingCamera` gibt `deskCamera` weiter.
- [ ] **Step 2–5:** FAIL, implementieren, grün + tsc ×2, Commit `feat(recording): remember the desk camera of a recording`.

### Task E2: HUD-Auswahl und Übernahme ins Projekt

**Files:** Modify `src/components/launch/HudDeviceSettings.tsx` (unter `AdditionalCamerasList`), ggf. `src/components/ai-edition/v4/RecStage.tsx` (zweiter Editor derselben Prefs — gleiche Auswahl, falls dort die zusätzlichen Kameras gewählt werden), `src/lib/ai-edition/store/projectStore.ts` (`addAsset` ~l.418-436), Locales `launch`/HUD-Namespace (15); Tests daneben.

**Verhalten:**
- HUD: Abschnitt „Tischkamera“ mit Einträgen „Keine“ + Kamera 1 + angehakte zusätzliche (Namen), Häkchen am gewählten; gleiche Sperre wie die zusätzlichen Kameras (`disabled` + Hinweis), nur sichtbar ab zwei Kameras. Ist die gespeicherte Wahl nicht unter den angebotenen, ist „Keine“ markiert.
- `addAsset`: `legacyEditor.deskCamera = camera.deskCamera`, nur wenn das Dokument noch kein `deskCamera` hat und `deskCamera` 0 oder ≤ Anzahl verknüpfter zusätzlicher Kameras ist; Teil derselben Speicherung (`history: false` wie dort üblich).

- [ ] **Step 1: Failing tests:** HUD-Liste (Einträge, Klick setzt Pref, Sperre, „Keine“ bei nicht angebotener Wahl); `addAsset` setzt `deskCamera` bei leerem Projekt, nicht bei vorhandenem, nicht bei Index außerhalb.
- [ ] **Step 2–5:** FAIL, implementieren (+ 15 Locales), fokussierte Tests, tsc ×2, lint, i18n, **`npm run test`**, Commit `feat(recording): pick the desk camera in the HUD`.

### Task E3: App-Lauf E (Controller)

- [ ] Playwright am HUD-Fenster: Geräte-Einstellungen öffnen, Tischkamera wählen, `recording-settings.json` enthält `camDeskDevice`; zurück auf „Keine“. (Echte Aufnahme mit Kameras: an den Nutzer bzw. computer-use; im Log als nicht abgedeckt.) Results-Log-Zeile, Commit.
