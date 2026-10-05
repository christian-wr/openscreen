# Multi-Camera Editor (Sub-project 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In Studio, the user places layout sections on the timeline, picks a template and which camera goes into each place, moves/resizes camera windows in the preview, sets rotation/mirror/crop per camera, and calibrates a perspective correction with four corner handles (optionally pre-placed by detected ArUco markers from a printable sheet).

**Architecture:** Full Camera regions (camera 1, incl. the desk view) stay exactly where and how they are stored today (`legacyEditor.cameraFullscreenRegions`, all existing writers untouched); every *other* layout (templates `screen-pip`, `camera-full-pip`, `side-by-side`, and `camera-full` with a camera other than 1) lives in `legacyEditor.cameraLayoutRegions`, clip-anchored exactly like Full Camera regions. The two lists are disjoint by construction and share one timeline lane with a cross-list non-overlap rule. Per-camera settings live in `legacyEditor.cameraSettings`. The compositor side (sub-project 2) already renders all of it.

**Tech Stack:** React 19 / TypeScript (v4 editor), Zustand project store with `saveDocument(…, {history:true})` undo, Vitest (+ jsdom, Testing Library), Playwright (`_electron`), `js-aruco2` 2.0.0 (MIT, pure JS) for marker detection.

**Spec:** `docs/superpowers/specs/2026-10-05-multi-camera-layouts-design.md` — sections 3 and 6, data model in section 1. **Deviation (recorded in Task 1, spec updated there):** section 1's "load converts every Full Camera region into a layout region; save writes both lists" is replaced by the disjoint two-list storage above, because six existing writers of `cameraFullscreenRegions` (`useTimeline` add/update/remove, copy/paste in `NewEditorShell`, clip re-anchoring in `document/timeline.ts`, and the main-process agent tools in `electron/ai-edition/agent-tools.ts`) would otherwise go silently dead in preview and export. Spec section 6's first bullet changes accordingly.

**Facts file (read before any task):** `.superpowers/editor-facts.md` — file:line map of today's Full Camera path through store, undo, persistence, timeline, inspector, preview drag, dialogs, shortcuts, i18n and tests. Line numbers are approximate (`~`).

**Worktree / branch:** `C:\osc-cams`, branch `feat/multi-camera-layouts`, plan base = the commit that adds this plan. `crates/thirdparty` is a junction to `C:\osc-multicam`. `node_modules` is a junction too — Task 9 replaces it with a real install (see there) before adding the dependency.

## Global Constraints

- Camera index convention: **0 = camera 1** (`asset.cameraTrack`), **k ≥ 1 = `asset.additionalCameraTracks[k-1]`**. Labels: camera 1 → "Kamera 1" (no label exists); camera k → its track `label`, else "Kamera k+1". Max 4 cameras.
- **Storage rule (deviation above):** a layout section that is `camera-full` with camera 0 is a `CameraFullscreenRegion` in `cameraFullscreenRegions`; everything else is a `CameraLayoutRegion` in `cameraLayoutRegions`. Never both. Both lists are clip-anchored (`clipId`, `assetId`, `sourceStartSec`, `sourceEndSec` + derived `startMs/endMs`) via `anchorRegionsWithDerivedMs`.
- **One shared lane, no overlap across the two lists**: add refuses (existing "cannot place" notice pattern), move/resize clamps against neighbours of *both* lists (`clampSpanAgainstNeighbours` semantics).
- **Camera 1 settings stay in the existing fields** (`webcamMirrored`, desk-view regions, `webcamCropRegion`); `cameraSettings[0]` only ever carries `perspective`. Extras use `cameraSettings[k]` (`rotation`, `mirror`, `crop`, `perspective`).
- Desk-view switches (rotation/mirror/label per section) only on Full Camera regions (camera 1). The normalizer already strips them elsewhere.
- Templates with PiP places (`screen-pip`, `camera-full-pip`) are disabled with a hint under the block layout presets `dual-frame` / `vertical-stack`; templates needing ≥2 cameras are disabled with a hint when the clip's asset has only one camera.
- A circle/square place keeps a square rect; dragging/resizing such a place keeps the aspect.
- Every editor change is **one undo step** via `saveDocument(doc, { history: true })` (live drags: `setDocument(…, {history:false})` + one commit with `historyBase`). **Every new writer gets a row in `src/lib/ai-edition/store/documentWriteAudit.test.ts`.** (The spec's mention of `useEditorHistory` is obsolete — v4 does not use it.)
- Default/unused values are not stored (a reset field is deleted), so untouched projects stay byte-identical.
- i18n: new strings in **all 15 locales** (`src/i18n/locales/<locale>/*.json`) with real translations; `npm run i18n:check` passes; no hard-coded English in new UI (the existing hard-coded `"Full Camera"` pill label is replaced by a translated label in Task 4).
- Tests per AGENTS.md: focused `npx vitest --run <files>` while working; jsdom only where a DOM is needed; both `tsc` (`npx tsc --noEmit`, `npx tsc -p tsconfig.test.json --noEmit`); `npm run lint` 0 errors (warnings stay 26).
- Comments in English; Biome style; no new `any`; hooks at top level. Commit messages Conventional-Commits style, **no `Co-Authored-By` / Claude trailer**, do not push.

## Review Focus

1. **A Full Camera section edited by any existing path** (C key, inspector desk switches, copy/paste, clip trim/move, AI agent tool) keeps working in preview/export after layout sections exist in the same project. Pinned in Task 1 (`legacy full camera regions still reach the scene next to layout regions`).
2. **A clip is trimmed or moved under a layout section** → the section follows the clip like a Full Camera section (no stale times). Pinned in Task 1 (`mapAllRegionCollections re-anchors layout regions`).
3. **Adding a layout section where any section (either list) already is** → refused with the existing notice, nothing silently dropped. Pinned in Task 2 (`adding over a full camera region is refused`).
4. **A camera chosen in a section is later missing** (track hidden/relinked away) → the place is empty, the inspector shows the camera as unavailable, the project opens. Pinned in Task 5 (`a slot whose camera is gone shows as unavailable`).
5. **Calibration with markers not all found** → message, handles unchanged; **degenerate quad** (crossed/collinear handles) → "Übernehmen" disabled with a hint. Pinned in Task 8 (`apply is disabled for a crossed quad`) and Task 9 (`fewer than four markers leaves the corners unchanged`).

---

### Task 1: Storage, anchoring and the scene (disjoint lists)

**Files:**
- Modify: `src/lib/cameraLayouts.ts` (`normalizeCameraLayoutRegions` ~:96) — keep anchor fields; never accept `camera-full` + camera 0 (drop such rows — they belong to Full Camera).
- Modify: `src/lib/ai-edition/document/timeline.ts` — `RegionKind` gains `"cameraLayout"` (~:39); `mapAllRegionCollections` (~:355) and `anchoredRegionsOf` (~:722) include `cameraLayoutRegions` (prefix `"camlayout"`); `removeRegion` (~:1080) case; `EDIT_REGIONS` (~:1153) entry.
- Modify: `src/lib/ai-edition/store/regionClipboard.ts` (~:13) — union gains `{ kind: "cameraLayout"; region }`.
- Modify: `src/native/sceneDescription.ts` (~:1150-1190) — always use `cameraFullscreenRegions`; project `cameraLayoutRegions` through the **anchored** branch of `projectRegionsToSource` like Full Camera; remove the rule "ignore the legacy list when `cameraLayoutRegions` is an array" (it was only right for the replaced storage); keep converting a hand-written `camera-full`+camera 0 layout row only if no Full Camera region covers the same span (de-dup by span).
- Modify: `docs/superpowers/specs/2026-10-05-multi-camera-layouts-design.md` — section 1 "Bestehende Projekte" and section 6 first bullet rewritten to the disjoint two-list rule (German, like the spec).
- Test: `src/lib/cameraLayouts.test.ts`, `src/lib/ai-edition/document/timeline.test.ts`, `src/native/sceneDescription.test.ts`.

**Interfaces:**
- Produces:
  ```ts
  // cameraLayouts.ts
  export type AnchoredCameraLayoutRegion = CameraLayoutRegion & { clipId?: string; assetId?: string; sourceStartSec?: number; sourceEndSec?: number };
  export function normalizeCameraLayoutRegions(raw: unknown): AnchoredCameraLayoutRegion[]; // keeps finite anchor fields
  export function isFullCameraLayout(region: Pick<CameraLayoutRegion, "template" | "slots">): boolean; // camera-full with camera 0
  // document/timeline.ts
  export type RegionKind = "zoom" | "trim" | "annotation" | "speed" | "cameraFullscreen" | "cameraLayout" | "audio";
  ```
  Overlap in the normalizer: keep dropping a later overlapping row **only within the layout list**; cross-list overlaps are prevented by the editor (Task 2), not repaired here.

- [ ] **Step 1: Failing tests.**
  - `cameraLayouts.test.ts`: `keeps the clip anchor fields`; `drops a camera-full row for camera 1 (it belongs to full camera)`.
  - `timeline.test.ts`: `mapAllRegionCollections re-anchors layout regions` (a layout row anchored to clip A; move clip A → row's `startMs/endMs` follow, as the existing camfull test at ~:1574 does); `removeRegion removes a layout pill`; `clearEditRegions clears layout regions`.
  - `sceneDescription.test.ts`: `legacy full camera regions still reach the scene next to layout regions` (doc with one Full Camera region 1–3 s and one `screen-pip` layout region 4–6 s → `cameraFullscreenRegions` has the first, `cameraLayoutRegions` the second); `a layout region follows its clip` (anchored row + a clip whose timeline start moved → projected seconds follow the anchor); replace the existing test that asserted "legacy list ignored when cameraLayoutRegions present" with `a hand-written camera-1 camera-full layout row is not doubled` (same span in both → one Full Camera region, one desk label).
- [ ] **Step 2:** run those files → FAIL.
- [ ] **Step 3:** implement; update the spec text.
- [ ] **Step 4:** PASS; both `tsc`; lint.
- [ ] **Step 5:** commit `feat(editor): store layout sections next to full camera regions`.

---

### Task 2: Layout section mutators in `useTimeline`

**Files:**
- Modify: `src/lib/ai-edition/store/useTimeline.ts` (pattern: `addCameraFullscreen` ~:547, `updateCameraFullscreenSpan` ~:1032, `updateCameraFullscreenOrientation` ~:1084, `removeRegion(s)` ~:1134/1150, live/commit pattern `updateZoomFocusLive`/`commitZoomFocus` ~:779/811).
- Modify: `src/lib/ai-edition/store/documentWriteAudit.test.ts` — one row per new writer.
- Test: `src/lib/ai-edition/store/useTimeline.test.ts` (jsdom, `renderHook` + `I18nProvider`, bridge mocked — see facts §10).

**Interfaces:**
- Consumes: Task 1 types, `isFullCameraLayout`, `TEMPLATE_SLOTS`.
- Produces (on the `useTimeline()` return):
  ```ts
  cameraLayoutRegions: AnchoredCameraLayoutRegion[];
  addCameraLayout(template: CameraLayoutTemplate, cameras: number[], durationSec?: number): Promise<"added" | "occupied" | "no-camera">;
  updateCameraLayoutSpan(id: string, startMs: number, endMs: number): Promise<void>;          // clamps against BOTH lists
  setLayoutTemplate(handle: { kind: "cameraFullscreen" | "cameraLayout"; id: string }, template: CameraLayoutTemplate, cameras: number[]): Promise<{ kind: "cameraFullscreen" | "cameraLayout"; id: string }>;
  setLayoutSlotCamera(id: string, slotIndex: number, camera: number): Promise<void>;          // unique per section: swaps if already used
  updateLayoutSlotRectLive(id: string, slotIndex: number, rect: NormalizedRect): void;         // setDocument history:false
  commitLayoutSlotRect(): Promise<void>;                                                       // one undo step
  resetLayoutSlotRects(id: string): Promise<void>;
  ```
Rules:
- `addCameraLayout` places at the playhead like `addCameraFullscreen` (same default duration, same `hasAnyClipWithCamera` gate → `"no-camera"`); if the span overlaps any row of either list → `"occupied"` and no write (the caller shows the existing "cannot place" notice). `camera-full` with `[0]` delegates to `addCameraFullscreen`.
- `setLayoutTemplate` converts across lists in **one** `saveDocument`: Full Camera → layout (drop the FC pill's rows, add layout rows on the same anchors/span, desk fields dropped), layout → Full Camera when the new template is `camera-full` with camera 0 (desk fields default), otherwise patch template+slots (slots: keep cameras in order, fill missing from the given `cameras`, cut to `TEMPLATE_SLOTS.max`). Returns the new handle so the selection can follow.
- Slot rect changes only touch `slots[i].rect`; reset deletes every `rect`.
- Pill semantics: like Full Camera, a section crossing a clip cut is stored as one row per clip and edited as one pill (`patchPillById` / `replacePillSpan` with the `"camlayout"` id prefix).

- [ ] **Step 1: Failing tests** in `useTimeline.test.ts` (new `describe("useTimeline camera layouts")`): `adds a screen-pip section at the playhead`; `adding over a full camera region is refused` (→ `"occupied"`, document unchanged); `camera-full with camera 1 is added as a full camera region`; `moving a layout section clamps at a full camera neighbour`; `switching a full camera section to camera-full-pip moves it to the layout list in one undo step` (undo restores the Full Camera region); `switching back to camera-full with camera 1 restores a full camera region`; `choosing a camera already in the section swaps the two places`; `a slot rect drag is one undo step`; `reset removes every slot rect`. Add the audit rows (Step 3) — the audit test fails first.
- [ ] **Step 2:** run → FAIL. **Step 3:** implement. **Step 4:** PASS, `tsc` ×2, lint. **Step 5:** commit `feat(editor): add, move and convert layout sections`.

---

### Task 3: Camera list and per-camera settings

**Files:**
- Create: `src/lib/ai-edition/timeline/cameraList.ts` + `cameraList.test.ts` (node).
- Modify: `src/lib/ai-edition/store/useTimeline.ts` (or a new small `useCameraSettings.ts` hook next to `useEditorSettings.ts` — choose the one that keeps the writer in one place) — `setCameraSettings`.
- Modify: `documentWriteAudit.test.ts`.

**Interfaces:**
- Produces:
  ```ts
  export interface ProjectCamera { index: number; label: string; path: string; available: boolean; width?: number; height?: number }
  export function projectCameras(asset: AxcutAsset | undefined, t: (key: string, vars?: Record<string, unknown>) => string): ProjectCamera[];
  // available = visible track with a non-empty sourcePath; label per Global Constraints (`t("cameras.cameraN", { n })` fallback)
  export function camerasForClipAt(document: AxcutDocument, timelineSec: number): ProjectCamera[]; // asset of the clip under the playhead
  // hook
  setCameraSettings(index: number, patch: Partial<CameraSettings> | null): Promise<void>; // null = reset; index 0 accepts only `perspective`
  cameraSettings: (CameraSettings | null)[];
  ```
Rules: writes `legacyEditor.cameraSettings` (array, length ≤ 4, `null` holes, trailing nulls trimmed, empty → key deleted); defaults deleted; for index 0 any non-`perspective` key is ignored (spec section 6).

- [ ] **Step 1: Failing tests:** `labels camera 1 and falls back for empty labels`; `a hidden track is unavailable`; `cameras of the clip under the playhead`; hook: `setting camera 2 mirror stores only that`; `resetting the last camera removes the key`; `camera 1 accepts only a perspective`.
- [ ] **Step 2–5:** FAIL → implement → PASS (+ tsc, lint) → commit `feat(editor): list cameras and store their settings`.

---

### Task 4: Timeline "Layout" lane

**Files:**
- Modify: `src/components/ai-edition/v4/V4Timeline.tsx` (pills ~:757, drag apply ~:986, `laneOf` ~:1416, `pillIcon` ~:1426, lanes ~:2140-2180, toolbar ~:2020-2034, `LanePill.kind` ~:595).
- Modify: `src/components/ai-edition/NewEditorShell.tsx` (copy ~:1200-1207 / paste ~:1140 — make the kind switch explicit for `cameraLayout`; shortcut handler ~:1387 unchanged for C).
- Modify: `src/lib/shortcuts.ts` only if a new shortcut is added (none planned).
- Modify: locale files (`timeline.json`) — lane title "Layout", pill labels per template ("Bildschirm + 2 Kameras", "Tisch voll + Gesicht", …: label = template name + camera labels), add-menu items.
- Test: `src/components/ai-edition/v4/V4Timeline.geometry.test.tsx` style (fake `tl`), new `V4Timeline.layout.test.tsx`.

Rules:
- The Full Camera lane becomes the "Layout" lane: it renders Full Camera pills (as today, label translated, rotate icon kept) **and** layout pills (icon per template: `screen-pip` → PictureInPicture-style icon, `camera-full` → Maximize2, `camera-full-pip` → layers icon, `side-by-side` → Columns2; use icons already available from `lucide-react` in the repo).
- Pill label: translated template name + " · " + camera labels of its places (from `projectCameras`).
- Drag/resize of a layout pill → `tl.updateCameraLayoutSpan`; click → `tl.selectRegion("cameraLayout", id)`.
- Toolbar: the existing "Add Full Camera" button stays; next to it an "Add layout" menu button listing the four templates (each item disabled with a tooltip when its rule from Global Constraints applies). Choosing an item calls `tl.addCameraLayout(template, defaultCameras)` where `defaultCameras` = the first N available cameras of the clip under the playhead (N = template min; for `camera-full-pip` desk-first: `[1, 0]` if camera 2 exists). `"occupied"` → the existing "cannot place" notice.
- Copy/paste supports `cameraLayout` (no fallthrough into camera full).

- [ ] **Step 1: Failing tests** (`V4Timeline.layout.test.tsx`, jsdom, fake `tl`): `renders layout pills in the full camera lane`; `a layout pill drag calls updateCameraLayoutSpan`; `the add-layout menu disables multi-camera templates for a one-camera project`; `the pill label names its cameras`. Shell copy/paste: unit-test the kind switch if it is extracted into a pure helper (do that).
- [ ] **Step 2–5:** FAIL → implement (+ all 15 locales) → PASS, `tsc` ×2, lint, `npm run i18n:check` → commit `feat(editor): layout lane on the timeline`.

---

### Task 5: Inspector for layout sections

**Files:**
- Modify: `src/components/ai-edition/v4/FloatingInspector.tsx` (`SelectionPane` ~:745; Full Camera branch ~:1277-1350).
- Create: `src/components/ai-edition/v4/LayoutSectionPane.tsx` (+ test) — keep the new pane out of the 1400-line file.
- Modify: locale files (`settings.json` → `cameraLayout.*`).

Rules:
- Selection `cameraLayout` → `LayoutSectionPane`: header (template icon + name), template `ChoiceRow` (disabled entries with hint per Global Constraints), one row per place: label ("Platz 1 · groß" / "Platz 2 · klein" by template) + a select of `projectCameras(...)` (unavailable cameras listed but disabled, the current one shown with "nicht verfügbar"), "Fenster zurücksetzen" (`resetLayoutSlotRects`, disabled when no rect is set), delete.
- Selection `cameraFullscreen` → today's pane **plus** the same template `ChoiceRow` at the top (current = `camera-full`); changing it calls `setLayoutTemplate` and moves the selection to the returned handle.
- Choosing a camera already used in the section swaps (handled by the store).

- [ ] **Step 1: Failing tests** (`LayoutSectionPane.test.tsx`, jsdom, i18n mocked as in `FloatingInspector.test.tsx`): `shows one camera select per place`; `choosing a template calls setLayoutTemplate`; `a slot whose camera is gone shows as unavailable`; `side-by-side is disabled with one camera`; `pip templates are disabled under dual-frame`; and in `FloatingInspector.test.tsx`: `the full camera pane offers the template choice`.
- [ ] **Step 2–5:** FAIL → implement (+ locales) → PASS, tsc ×2, lint, i18n:check → commit `feat(editor): inspector for layout sections`.

---

### Task 6: Move and resize camera windows in the preview

**Files:**
- Modify: `src/components/ai-edition/PreviewCanvas.tsx` (layout memo ~:261-311, Full Camera hitbox ~:317-339, drag ~:385-431, slot element ~:482-496).
- Modify: `src/components/ai-edition/NewEditorShell.tsx` (~:1620-1630, pass props like the zoom-focus pair).
- Create: `src/lib/ai-edition/timeline/layoutSlotDrag.ts` + test (pure geometry: move/resize a rect inside the frame, keep square for circle/square, min size, clamp).

Rules:
- When a `cameraLayout` section is selected and the playhead is inside it (not playing): draw one hitbox per **PiP** place from `resolveCameraLayout(region, ctx)` (same ctx as the scene: frame size, camera aspects incl. perspective aspect, pip shape/radius, `defaultPipRect`); dragging moves, a corner handle resizes (aspect locked for every PiP: width/height ratio of the camera box; square for circle/square); live → `updateLayoutSlotRectLive`, release → `commitLayoutSlotRect`. Frame-filling places have no handles.
- Outside a selected layout section the existing camera-1 anchor drag is unchanged.

- [ ] **Step 1: Failing tests:** `layoutSlotDrag.test.ts` — `moves inside the frame`, `resize keeps the box aspect`, `a circle stays square`, `clamps to a minimum size`; `PreviewCanvas` jsdom test (if the existing test setup allows; else via the pure helper only — say so): `a selected layout section shows a handle per pip place`.
- [ ] **Step 2–5:** FAIL → implement → PASS (+ tsc, lint) → commit `feat(editor): move and resize camera windows of a layout section`.

---

### Task 7: "Kameras" section in the layout pane

**Files:**
- Create: `src/components/ai-edition/CamerasSection.tsx` + test; render it inside `LayoutPane` (`src/components/ai-edition/RightPanes.tsx` ~:2782) below the existing camera controls.
- Create: `src/lib/ai-edition/timeline/grabFrame.ts` + test (pattern `probeVideoDimensions`, `src/lib/ai-edition/timeline/duration.ts:89`): `grabFrame(src: string, timeSec: number, maxSide?: number): Promise<ImageData>` and `grabFrameDataUrl(...)`.
- Modify: locale files (`settings.json` → `cameras.*`).

Rules:
- One row per project camera (`projectCameras` of the clip under the playhead): thumbnail (`grabFrameDataUrl` at the camera time of the playhead, 96 px), label, availability.
- Camera 1 row: only "Perspektive korrigieren…" (+ hint that rotation/mirror/crop for camera 1 are the existing controls above).
- Camera k ≥ 1 rows: rotation 0°/180° `ChoiceRow`, mirror `Toggle`, "Zuschnitt…" and "Perspektive korrigieren…" buttons (open the Task 8 dialog in the matching mode), "Zurücksetzen" when settings exist.
- Camera time = `max(0, sourceTimeSec - offsetSec)` from `locateVirtualPosition` (facts §5).

- [ ] **Step 1: Failing tests:** `CamerasSection.test.tsx` — `lists every camera of the clip`, `camera 1 offers only the perspective`, `rotating camera 2 calls setCameraSettings`; `grabFrame.test.ts` — with a mocked `HTMLVideoElement`/canvas (jsdom has no media): `seeks to the time and draws the frame`, `rejects on error with a clear message`.
- [ ] **Step 2–5:** FAIL → implement (+ locales) → PASS, tsc ×2, lint, i18n:check → commit `feat(editor): camera list with per-camera settings`.

---

### Task 8: Calibration dialog (perspective + crop)

**Files:**
- Create: `src/components/ai-edition/CameraCalibrationModal.tsx` + test; `src/lib/ai-edition/timeline/calibrationGeometry.ts` + test (pure: handle hit-testing, loupe source rect, quad validity via `homographyFromUnitSquare`, crop rect clamp, rectified-preview sampling).
- Modify: `CamerasSection.tsx` to open it; locale files (`dialogs.json` → `cameraCalibration.*`).

**Interfaces:**
- Consumes: `grabFrame` (Task 7), `homographyFromUnitSquare` / `perspectiveMatrix` (`src/lib/cameraPerspective.ts`), `setCameraSettings` (Task 3).
- Produces: `<CameraCalibrationModal open camera mode="perspective"|"crop" initial onApply onClose />`; `onApply(settingsPatch)` → one `setCameraSettings` call.

Rules (built on `ModalShell`, `src/components/ai-edition/Modals.tsx:35`, so editor shortcuts and undo are blocked while open):
- Still image of the camera at the playhead (`grabFrame`, full resolution), shown fit-to-dialog.
- **Perspective mode:** four handles (TL, TR, BR, BL; initial = existing corners or an inset rectangle), drag with pointer, arrow keys nudge the focused handle (Shift = 10×), a **loupe** (4× zoom of the area under the active handle) in a corner; target format choice (A4 hoch 210/297, A4 quer 297/210, 16:9, 4:3, 1:1, frei = numeric ratio input), margin slider 0–20 %; a **live rectified preview** (320 px canvas sampled through the homography, nearest-neighbour is enough); (the "Marker erkennen" / "Markerblatt drucken" buttons are added by Task 9); "Zurücksetzen" (removes the perspective), "Übernehmen" (disabled + hint for a degenerate quad), "Abbrechen".
- **Crop mode** (cameras k ≥ 1): a rectangle with corner/edge handles in normalized coords; "Übernehmen" stores `crop`.
- Apply = one undo step; cancel changes nothing.

- [ ] **Step 1: Failing tests:** `calibrationGeometry.test.ts` — `hit-tests the nearest handle within the radius`, `the loupe rect stays inside the image`, `a crossed quad is invalid`, `the rectified preview maps the quad corners to the canvas corners`; `CameraCalibrationModal.test.tsx` (jsdom, `grabFrame` mocked to a small ImageData): `apply is disabled for a crossed quad`, `apply stores corners, aspect and margin in one call`, `arrow keys move the focused handle`, `crop mode stores a crop`, `cancel stores nothing`.
- [ ] **Step 2–5:** FAIL → implement (+ locales) → PASS, tsc ×2, lint, i18n:check → commit `feat(editor): calibrate a camera's perspective and crop`.

---

### Task 9: ArUco markers — detection and printable sheet

**Files:**
- Replace the `node_modules` junction in `C:\osc-cams` by a real install first: `Remove-Item C:\osc-cams\node_modules` (removes only the junction — verify with `(Get-Item C:\osc-cams\node_modules).LinkType` = `Junction` before), then `npx -y npm@10.9.4 ci --ignore-scripts` and `node node_modules/electron/install.js`; then `npm install js-aruco2@2.0.0 --save-exact` (adds to `package.json` + `package-lock.json`).
- Create: `src/lib/arucoMarkers.ts` + `src/lib/arucoMarkers.test.ts`; `src/types/js-aruco2.d.ts` (minimal local declarations).
- Create: `src/lib/markerSheet.ts` + test — A4 SVG with markers ID 0–3 (4×4 dictionary), 40 mm each, cut lines, a one-line instruction, generated from the same dictionary the detector uses.
- Modify: `CameraCalibrationModal.tsx` — wire "Marker erkennen" / "Markerblatt drucken"; locale strings.

**Interfaces:**
- Produces:
  ```ts
  export type MarkerCorners = [CameraPoint, CameraPoint, CameraPoint, CameraPoint]; // normalized 0..1
  /** Finds markers 0–3 (ARUCO 4x4) and returns the four inner corners as TL (id 0), TR (1), BR (2), BL (3); null unless all four are found. */
  export function detectCornerMarkers(image: ImageData): MarkerCorners | null;
  export function markerSheetSvg(): string; // A4 portrait, mm units
  export function printMarkerSheet(): void; // hidden iframe + window.print (OS dialog offers "Save as PDF")
  ```
  "Inner corner" = the marker corner closest to the centroid of the four markers.

Rules: import js-aruco2 so it works under Vite (renderer) and Vitest (node) — verify both early (CJS with top-level `this`); if the CJS interop fails, vendor `src/aruco.js`, `src/cv.js` and the 4×4 dictionary under `src/vendor/js-aruco2/` with the MIT license header and an ESM wrapper (say which route was taken). Printing via hidden iframe; no new IPC.

- [ ] **Step 1: Failing tests:** `arucoMarkers.test.ts` — render the four markers (from the dictionary bits) into an RGBA `ImageData`-like buffer at known positions with a slight perspective (plain JS rasterizer in the test), then `detects four markers and orders the inner corners` (±1.5 px), `fewer than four markers leaves the corners unchanged` (→ null), `a rotated sheet still maps id 0 to top-left`; `markerSheet.test.ts` — `the sheet contains markers 0–3 at 40 mm` (parse the SVG). Modal: `detect fills the handles`, `detect without four markers shows the message and keeps the handles`.
- [ ] **Step 2–5:** FAIL → implement (+ locales) → PASS, tsc ×2, lint, i18n:check, **full `npm run test` once** (dependency change) → commit `feat(editor): detect corner markers and print a marker sheet`.

---

### Task 10: End to end in the app, checklist

**Files:**
- Create: `scripts/editor-multicam-smoke.mjs` (Playwright `_electron`, dev tool; header documents usage).
- Modify: `technical-documentation/testing/manual-e2e-checklist.md` — "Several cameras in the editor" item + results row.

- [ ] **Step 1:** Build (`npm run build-vite`), addon from this tree (`npm run build:native:compositor`, copy to `electron/native/bin/win32-arm64/` next to the ARM64 ffmpeg DLLs), launch with `_electron.launch({ args: [<repo root>] })` (the repo root, **not** `dist-electron/main.js` — otherwise userData becomes `Roaming\Electron`), `OPENSCREEN_COMPOSITOR_VIEW_NODE` set and that dir first on PATH. Use a **copy** of the user's two-camera project in a temp user-data dir *only if* its media resolves there; otherwise use the real user data with the projects folder backed up first and restored byte-identical afterwards (verify by hash) — record which.
- [ ] **Step 2:** In the editor (via Playwright): add a `camera-full-pip` section through the layout menu, choose cameras in the inspector, convert a Full Camera section (key C) to `screen-pip` and back, undo/redo, drag a PiP place in the preview, open the camera calibration dialog and apply a perspective, save, reopen the project. Assert document state after each step (read via `window` store hooks or the saved file) and capture preview screenshots inside the sections (the preview now renders layout sections live — this is the first in-app run of that path).
- [ ] **Step 3:** Checklist item (real cameras: desk camera full + face PiP, screen + 2 PiP, side by side, perspective with the printed marker sheet and an A4 sheet, export matches preview) and a results row (Partial: real-camera run by the user outstanding). Commit `test(editor): drive the multi-camera editor end to end`.
