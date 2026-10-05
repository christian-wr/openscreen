# Multi-Camera Compositor (Sub-project 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preview and export draw up to four camera layers per frame — arranged by layout regions stored in the project, gliding between regions, each camera with its own rotation/mirror/crop and an optional perspective (homography) correction — on Windows, macOS and Linux.

**Architecture:** The app (TypeScript) resolves each stored layout region into concrete camera layers (rects in output-frame fractions) and each camera's perspective into a 3×3 matrix, and sends both in the scene. The Rust compositor plans the layers per frame (`camera_layers.rs`, a pure function: region in effect, glide/fade between neighbours), decodes the extra cameras next to camera 1, and every backend draws each layer with the existing camera shader, whose `LayerCB` gains a homography and a transparency lane. With no layout regions and no camera settings, every code path is the one that runs today.

**Tech Stack:** Rust (crates/compositor: D3D11 HLSL, Metal MSL, wgpu WGSL; ffmpeg decoders), napi-rs (`crates/compositor-view-napi`), TypeScript (scene builder, layout math), Vitest, cargo test.

**Spec:** `docs/superpowers/specs/2026-10-05-multi-camera-layouts-design.md` (sections 1, 2 and the perspective parts; the editor in section 3 is sub-project 3, a separate plan).

**Facts file (read it before any task):** `.superpowers/camera-path-facts.md` — file:line map of today's single-camera path (scene contract, `plan_frame`, each backend's webcam block, live decoders, export walk, tests). Line numbers in this plan come from it and are approximate (`~`).

**Worktree / branch:** `C:\osc-cams`, branch `feat/multi-camera-layouts` (sub-project 1 + desk view #989 merged), base for this plan `c1a8aabb`. `node_modules` and `crates/thirdparty` are junctions to `C:\osc-multicam`. Rust tests: `crates\x.bat test -p openscreen-compositor --lib` (puts the ffmpeg DLLs on PATH), or from `crates/compositor` with `crates/thirdparty/ffmpeg-n8.1.2-win64-lgpl-shared/bin` on PATH. Expected on this host: 8 `pipeline_windows::tests` fail with or without these changes (no D3D11VA H.264 decode / no AV1 encoder) — any other failure is yours.

## Global Constraints

- Camera index convention everywhere: **0 = camera 1** (`asset.cameraTrack`, `SceneClip.webcam_path`), **k ≥ 1 = `asset.additionalCameraTracks[k-1]`** (`SceneClip.additional_cameras[k-1]`). At most 4 cameras.
- **Unchanged-when-unused:** a scene without `cameraLayoutRegions` and without `cameras` renders exactly as today (same `FrameGeometry` for camera 1, same pixels). Every new scene field is `#[serde(default)]`; existing JSON fixtures must parse unchanged.
- A layout region of template `camera-full` whose only camera is 0 is **always emitted as a `cameraFullscreenRegion`** (keeps the desk view: rotation, cover blur, label). Only other templates/cameras become `cameraLayoutRegions`.
- Transition envelope: reuse the Full Camera envelope — lead-in `min(TRANSITION_WINDOW_S, len/2)`, lead-out `min(FULLSCREEN_LEAD_OUT_WINDOW_S, len/2)`, easing `ease_out_screen_studio` (`regions.rs` ~:274, ~:331). (Spec: "dieselbe Fensterlänge und Kurve wie das Wachsen der Full Camera"; its ease-out covers ~90 % of the move in ≈0.4 s, the spec's "~0,4 s".)
- Background effects (segmentation, cutout, blur, custom bg) stay on **camera 0 only**; extra cameras draw with effect code 0.
- Camera 0 settings in this sub-project: only `perspective` (homography) applies to camera 0 — also when there are no layout regions (today's camera-0 block then sets the Task 5 lanes from `Scene::camera(0)`). Camera 0's rotation/mirror stay the project mirror + desk-view regions as today; extras use their own `rotation`/`mirror`.
- With a perspective set, the camera's `rotation`/`mirror` are ignored (the corner order already defines the upright, unmirrored result) and `crop` is ignored.
- `LayerCB` layout is shared by Rust, HLSL, WGSL and MSL; append new lanes **last**, keep 16-byte alignment, update the size/offset test. A transparency lane uses `0 = opaque` so a zero-initialised field changes nothing.
- macOS (Metal) is compiled only by CI here: keep MSL edits mechanical and mirror HLSL; say in the report that Metal was not run.
- Comments in English (match the surrounding file even where it is French). Biome style for TS; no new `any`. Commit messages Conventional-Commits style, **no `Co-Authored-By` / Claude trailer**, do not push.
- Native addon: after Rust changes that the app should load, `npm run build:native:compositor`, then copy `electron/native/compositor-view/build/compositor_view.node` to `electron/native/bin/win32-arm64/` and run the app with `OPENSCREEN_COMPOSITOR_VIEW_NODE` pointing at it (this branch has no ARM PR; the script copies to win32-x64 only).

## Review Focus

1. **A layout region names a camera whose file is missing or fails to open** → that layer is skipped, the rest (screen, other cameras) is drawn; preview and export keep running. Pinned in Task 7 (`a missing extra camera skips its layer`) and Task 8 (`export skips an extra camera that will not open`).
2. **An extra camera shorter than the clip** (stopped early) → after its last frame the layer disappears; the clip is *not* truncated (only camera 0 clamps the clip end, as today). Pinned in Task 8 (`a short extra camera does not shorten the clip`).
3. **No layout regions** → bit-identical to today. Pinned in Task 4 (`without layout regions the plan has no camera layers`) and Task 6 (`identity lanes leave the camera pixels unchanged`).
4. **Two adjacent regions** → the cameras glide directly from region A's layout to region B's, not via the default PiP in between. Pinned in Task 4 (`adjacent regions glide directly`).
5. **Degenerate perspective corners** (collinear, crossed) → no matrix is sent; the camera draws uncorrected. Pinned in Task 1 (`rejects collinear and crossed quads`) and Task 3 (`a degenerate perspective sends no homography`).

---

### Task 1: Camera layout model, normalizers and perspective math (TS)

**Files:**
- Modify: `src/components/video-editor/types.ts` (next to `CameraFullscreenRegion` ~:326) — types below.
- Create: `src/lib/cameraLayouts.ts` + `src/lib/cameraLayouts.test.ts` — normalizers.
- Create: `src/lib/cameraPerspective.ts` + `src/lib/cameraPerspective.test.ts` — homography.

**Interfaces:**
- Produces:
  ```ts
  // types.ts
  export type CameraLayoutTemplate = "screen-pip" | "camera-full" | "camera-full-pip" | "side-by-side";
  export interface NormalizedRect { x: number; y: number; width: number; height: number } // 0..1 of the output frame
  export interface CameraLayoutSlot { camera: number; rect?: NormalizedRect }
  export interface CameraLayoutRegion {
  	id: string; startMs: number; endMs: number;
  	template: CameraLayoutTemplate; slots: CameraLayoutSlot[];
  	rotation?: CameraRotation; mirror?: CameraMirrorMode; deskLabel?: false; // camera-full only (desk view)
  }
  export interface CameraPoint { x: number; y: number } // 0..1 of the camera image
  export interface CameraPerspective { corners: [CameraPoint, CameraPoint, CameraPoint, CameraPoint]; aspect: number; margin?: number }
  export interface CameraSettings { rotation?: CameraRotation; mirror?: boolean; crop?: CropRegion; perspective?: CameraPerspective }
  // cameraLayouts.ts
  export const MAX_CAMERAS = 4;
  export const TEMPLATE_SLOTS: Record<CameraLayoutTemplate, { min: number; max: number }>;
  export function normalizeCameraLayoutRegions(raw: unknown): CameraLayoutRegion[];
  export function normalizeCameraSettings(raw: unknown): (CameraSettings | null)[]; // index = camera
  // cameraPerspective.ts
  export function homographyFromUnitSquare(c: CameraPerspective["corners"]): number[] | null; // row-major 3x3, maps (u,v,1) target→source
  export function perspectiveMatrix(p: CameraPerspective): number[] | null; // margin folded in
  ```
  (`CropRegion` is the existing webcam crop type used by `settings.webcamCropRegion` — reuse it; check its name in `types.ts`.)

Normalizer rules: drop non-objects; `template` must be one of the four; `slots` filtered to integer `camera` in `0..MAX_CAMERAS-1`, duplicates removed (first wins), length clamped to `TEMPLATE_SLOTS[template].max`, region dropped if fewer than `min`; `rect` kept only if all four numbers finite, width/height > 0, inside `[-0.5, 1.5]`; `startMs < endMs` (else dropped); regions sorted by `startMs`, overlaps resolved by dropping the later one; desk fields only on `camera-full` (normalize with the existing `normalizeCameraRotation` / `normalizeCameraMirror`). `TEMPLATE_SLOTS = { "screen-pip": {min:1,max:3}, "camera-full": {min:1,max:1}, "camera-full-pip": {min:2,max:3}, "side-by-side": {min:2,max:2} }`. `normalizeCameraSettings`: array of length ≤ 4, each entry an object or `null`; `rotation` via `normalizeCameraRotation`; `mirror` boolean only; `perspective` kept only if 4 finite corners in `[-0.5,1.5]`, `aspect` finite in `[0.1, 10]`, `margin` clamped to `[0, 0.2]`.

- [ ] **Step 1: Failing tests** — `cameraPerspective.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { homographyFromUnitSquare, perspectiveMatrix } from "./cameraPerspective";

const apply = (h: number[], u: number, v: number) => {
	const w = h[6] * u + h[7] * v + h[8];
	return [(h[0] * u + h[1] * v + h[2]) / w, (h[3] * u + h[4] * v + h[5]) / w];
};
const quad = [
	{ x: 0.2, y: 0.3 }, { x: 0.85, y: 0.25 }, { x: 0.95, y: 0.9 }, { x: 0.1, y: 0.8 },
] as const;

describe("homographyFromUnitSquare", () => {
	it("maps the unit square's corners onto the four points", () => {
		const h = homographyFromUnitSquare([...quad] as never);
		expect(h).not.toBeNull();
		const corners = [[0, 0], [1, 0], [1, 1], [0, 1]];
		corners.forEach(([u, v], i) => {
			const [x, y] = apply(h as number[], u, v);
			expect(x).toBeCloseTo(quad[i].x, 9);
			expect(y).toBeCloseTo(quad[i].y, 9);
		});
	});
	it("is the identity for the full image", () => {
		const h = homographyFromUnitSquare([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }]);
		expect(h?.map((n) => Number(n.toFixed(12)))).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);
	});
	it("rejects collinear and crossed quads", () => {
		expect(homographyFromUnitSquare([{ x: 0, y: 0 }, { x: 0.5, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }])).toBeNull();
		// bow-tie: top-right and bottom-right swapped
		expect(homographyFromUnitSquare([{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 1, y: 0 }, { x: 0, y: 1 }])).toBeNull();
	});
});

describe("perspectiveMatrix", () => {
	it("folds the margin in: the target edge lands outside the quad", () => {
		const h = perspectiveMatrix({ corners: [...quad] as never, aspect: 297 / 210, margin: 0.1 });
		const inner = perspectiveMatrix({ corners: [...quad] as never, aspect: 297 / 210 });
		expect(h).not.toBeNull();
		// the target point that maps to the quad's top-left corner moves inward by the margin
		const [x, y] = apply(h as number[], 0.1 / 1.2, 0.1 / 1.2);
		expect(x).toBeCloseTo(quad[0].x, 9);
		expect(y).toBeCloseTo(quad[0].y, 9);
		expect(apply(inner as number[], 0, 0)[0]).toBeCloseTo(quad[0].x, 9);
	});
});
```

`cameraLayouts.test.ts` (normalizers): a valid region round-trips; unknown template dropped; duplicate camera in slots removed; `camera-full-pip` with one slot dropped; overlapping regions → later dropped; `rect` with NaN removed; desk fields stripped from `screen-pip`; settings: `[null, { rotation: 180, perspective: {...valid} }, "junk", {…}, {…}]` → length 4, junk → `null`, a perspective with `aspect: 0` removed. Write each as its own `it` with explicit input/expected objects.

- [ ] **Step 2:** `npx vitest --run src/lib/cameraPerspective.test.ts src/lib/cameraLayouts.test.ts` → FAIL (modules missing).

- [ ] **Step 3: Implement.** `homographyFromUnitSquare` — Heckbert's square→quad closed form (corners in order (0,0),(1,0),(1,1),(0,1)):

```ts
export function homographyFromUnitSquare(c: CameraPerspective["corners"]): number[] | null {
	if (!isConvexClockwiseOrCounter(c)) return null;
	const [p0, p1, p2, p3] = c;
	const dx1 = p1.x - p2.x, dx2 = p3.x - p2.x, dx3 = p0.x - p1.x + p2.x - p3.x;
	const dy1 = p1.y - p2.y, dy2 = p3.y - p2.y, dy3 = p0.y - p1.y + p2.y - p3.y;
	let g = 0, h = 0;
	if (Math.abs(dx3) > 1e-12 || Math.abs(dy3) > 1e-12) {
		const den = dx1 * dy2 - dx2 * dy1;
		if (Math.abs(den) < 1e-12) return null;
		g = (dx3 * dy2 - dx2 * dy3) / den;
		h = (dx1 * dy3 - dx3 * dy1) / den;
	}
	const a = p1.x - p0.x + g * p1.x, b = p3.x - p0.x + h * p3.x;
	const d = p1.y - p0.y + g * p1.y, e = p3.y - p0.y + h * p3.y;
	return [a, b, p0.x, d, e, p0.y, g, h, 1];
}
```

`isConvexClockwiseOrCounter`: the four cross products of consecutive edges are all non-zero (|z| > 1e-9) and share one sign. `perspectiveMatrix`: `H · S` where `S` maps the output's local `[0,1]²` to `[-m, 1+m]²` (`S = [[1+2m,0,-m],[0,1+2m,-m],[0,0,1]]`), row-major multiply; `null` if `H` is null. (`aspect` is not part of the matrix — it sets the layer's box ratio in Task 2.)

- [ ] **Step 4:** both test files PASS; `npx tsc --noEmit`; `npm run lint`.
- [ ] **Step 5:** commit `feat(camera): layout regions, camera settings and the perspective matrix`.

---

### Task 2: Resolve layout templates into camera layers (TS)

**Files:**
- Create: `src/lib/cameraLayoutTemplates.ts` + `src/lib/cameraLayoutTemplates.test.ts`.

**Interfaces:**
- Consumes: Task 1 types.
- Produces:
  ```ts
  export interface ResolvedCameraLayer {
  	camera: number;
  	rect: NormalizedRect;   // output-frame fractions
  	radiusFrac: number;     // corner radius as a fraction of min(rect w, h) in pixels
  	shape: "rectangle" | "rounded" | "circle" | "square"; // same vocabulary as SceneLayout.webcamShape
  	fillsFrame: boolean;    // covers the screen (no shadow)
  }
  export interface CameraLayoutContext {
  	frame: { width: number; height: number };        // output pixels
  	cameraAspect: (camera: number) => number;         // width/height of that camera's box (perspective aspect if set)
  	pipShape: ResolvedCameraLayer["shape"];           // project's webcam shape
  	pipRadiusFrac: number;                            // project's webcam radius fraction
  }
  export const PIP_WIDTH_FRAC = 0.22;
  export const PIP_MARGIN_FRAC = 0.025;
  export const PIP_GAP_FRAC = 0.02;
  export function resolveCameraLayout(region: CameraLayoutRegion, ctx: CameraLayoutContext): ResolvedCameraLayer[];
  ```

Template rules (slot order = `region.slots` order; a slot's own `rect` overrides the template rect but keeps the template's `fillsFrame`/shape):
- `camera-full`: slot 0 → `{x:0,y:0,width:1,height:1}`, radius 0, shape `"rectangle"`, `fillsFrame: true`.
- `side-by-side`: slot 0 → left half `{0,0,0.5,1}`, slot 1 → right half `{0.5,0,0.5,1}`, radius 0, `"rectangle"`, `fillsFrame: true`.
- `screen-pip`: every slot is a PiP.
- `camera-full-pip`: slot 0 as `camera-full`, slots 1.. are PiPs.
- PiP j (0-based among the PiPs): width `w = PIP_WIDTH_FRAC` of the frame width; height fraction `h = w * frame.width / cameraAspect(camera) / frame.height`; right edge at `1 - PIP_MARGIN_FRAC - j * (w + PIP_GAP_FRAC)`; bottom at `1 - PIP_MARGIN_FRAC * frame.width / frame.height`; `x = right - w`, `y = bottom - h`; shape `ctx.pipShape`, radius `ctx.pipRadiusFrac`, `fillsFrame: false`. For `circle`/`square` the box is square (`h = w * frame.width / frame.height`).
- Layers are returned in draw order: `fillsFrame` layers first (slot order), then PiPs (slot order).

- [ ] **Step 1: Failing tests** (frame 1920×1080, aspect 16/9 for all cameras unless stated):

```ts
import { describe, expect, it } from "vitest";
import { PIP_MARGIN_FRAC, PIP_WIDTH_FRAC, resolveCameraLayout } from "./cameraLayoutTemplates";

const ctx = { frame: { width: 1920, height: 1080 }, cameraAspect: () => 16 / 9, pipShape: "rounded" as const, pipRadiusFrac: 0.12 };
const region = (template: never, cameras: number[], rects: Record<number, unknown> = {}) =>
	({ id: "r", startMs: 0, endMs: 5000, template, slots: cameras.map((camera, i) => ({ camera, ...(rects[i] ? { rect: rects[i] } : {}) })) }) as never;

describe("resolveCameraLayout", () => {
	it("camera-full fills the frame", () => {
		expect(resolveCameraLayout(region("camera-full" as never, [2]), ctx)).toEqual([
			{ camera: 2, rect: { x: 0, y: 0, width: 1, height: 1 }, radiusFrac: 0, shape: "rectangle", fillsFrame: true },
		]);
	});
	it("side-by-side splits the frame in halves", () => {
		const layers = resolveCameraLayout(region("side-by-side" as never, [0, 1]), ctx);
		expect(layers.map((l) => l.rect)).toEqual([
			{ x: 0, y: 0, width: 0.5, height: 1 }, { x: 0.5, y: 0, width: 0.5, height: 1 },
		]);
	});
	it("screen-pip stacks pips from the bottom-right corner leftwards", () => {
		const [a, b] = resolveCameraLayout(region("screen-pip" as never, [0, 1]), ctx);
		expect(a.rect.x + a.rect.width).toBeCloseTo(1 - PIP_MARGIN_FRAC, 9);
		expect(a.rect.width).toBeCloseTo(PIP_WIDTH_FRAC, 9);
		expect(a.rect.height).toBeCloseTo(PIP_WIDTH_FRAC, 9); // 16:9 camera in a 16:9 frame
		expect(b.rect.x + b.rect.width).toBeLessThan(a.rect.x);
		expect([a.fillsFrame, b.fillsFrame]).toEqual([false, false]);
	});
	it("camera-full-pip draws the full camera first, then the pip", () => {
		const layers = resolveCameraLayout(region("camera-full-pip" as never, [1, 0]), ctx);
		expect(layers.map((l) => [l.camera, l.fillsFrame])).toEqual([[1, true], [0, false]]);
	});
	it("a user rect overrides the template position", () => {
		const rect = { x: 0.1, y: 0.1, width: 0.3, height: 0.3 };
		const [layer] = resolveCameraLayout(region("screen-pip" as never, [1], { 0: rect }), ctx);
		expect(layer.rect).toEqual(rect);
	});
	it("a portrait camera gets a taller pip box", () => {
		const [layer] = resolveCameraLayout(region("screen-pip" as never, [1]), { ...ctx, cameraAspect: () => 9 / 16 });
		expect(layer.rect.height).toBeGreaterThan(layer.rect.width);
	});
});
```

- [ ] **Step 2:** run → FAIL. **Step 3:** implement per the rules. **Step 4:** PASS, tsc, lint. **Step 5:** commit `feat(camera): resolve layout templates into camera layers`.

---

### Task 3: Scene contract for extra cameras, camera settings and layout regions (TS + Rust parse)

**Files:**
- Modify: `src/native/contracts.ts` (`CompositorClipInput` ~:196) — `additionalCameras?: CompositorClipCamera[]`.
- Modify: `src/native/sceneDescription.ts` — types (~:132-146, ~:473) and builder (`buildSceneDescription` ~:840-1545).
- Modify: `src/lib/ai-edition/timeline/camera.ts` (~:45) — add `assetAdditionalCameraSources`.
- Modify: `crates/compositor/src/scene.rs` — structs + `Scene::for_clip_window` (~:780) + parse tests (~:957).
- Test: `src/native/sceneDescription.test.ts`, `src/lib/ai-edition/timeline/camera.test.ts` (create if absent), `scene.rs` tests.

**Interfaces:**
- Consumes: Task 1 normalizers + `perspectiveMatrix`, Task 2 `resolveCameraLayout`.
- Produces (TS, mirrored in Rust with `#[serde(rename_all = "camelCase")]`, every new field `#[serde(default)]`):
  ```ts
  export interface CompositorClipCamera { path: string; offsetSec: number } // contracts.ts
  // CompositorClipInput.additionalCameras?: CompositorClipCamera[]  — index k-1 = camera k
  export interface SceneCamera { index: number; rotation?: 180; mirror?: boolean; crop?: SceneCrop; homography?: number[] /* 9, row-major, target uv → camera uv */; aspect?: number }
  export interface SceneCameraLayer { camera: number; rect: SceneRect; radiusFrac: number; shape: string; fillsFrame: boolean }
  export interface SceneCameraLayoutRegion { startSec: number; endSec: number; clipIndex?: number; underTrim?: boolean; layers: SceneCameraLayer[] }
  // SceneDescription.cameras?: SceneCamera[]; SceneDescription.cameraLayoutRegions?: SceneCameraLayoutRegion[]
  export function assetAdditionalCameraSources(asset: AxcutAsset): CompositorClipCamera[]; // camera.ts
  ```
  Rust: `SceneClipCamera { path: String, offset_sec: f64 }`; `SceneClip.additional_cameras: Vec<SceneClipCamera>`; `SceneCamera { index: usize, rotation: u16, mirror: Option<bool>, crop: Option<SceneCrop>, homography: Option<[f32; 9]>, aspect: Option<f32> }`; `SceneCameraLayer { camera: usize, rect: SceneRect, radius_frac: f32, shape: String, fills_frame: bool }`; `SceneCameraLayoutRegion { clip_index: Option<usize>, start_sec: f64, end_sec: f64, layers: Vec<SceneCameraLayer> }`; `Scene.cameras: Vec<SceneCamera>`, `Scene.camera_layout_regions: Vec<SceneCameraLayoutRegion>`; `Scene::camera(&self, index) -> Option<&SceneCamera>`.

Builder rules:
- `assetAdditionalCameraSources(asset)`: for each `additionalCameraTracks` entry, `{ path: visible && sourcePath ? sourcePath : "", offsetSec: (startMs + offsetMs) / 1000 }` (same formula as `assetCameraSource`); `[]` when absent.
- Clips (~:1004-1027): set `additionalCameras` only when non-empty.
- Read `legacyEditor.cameraLayoutRegions` through `normalizeCameraLayoutRegions` and `legacyEditor.cameraSettings` through `normalizeCameraSettings` (raw legacyEditor access as done for `cameraFullscreenRegions` ~:1101).
- Regions whose template is `camera-full` and whose single slot is camera 0 → appended to the Full Camera list **before** `projectRegionsToSource` (with `rotation/mirror/deskLabel`), so the desk view and its label apply unchanged.
- All other regions → `projectRegionsToSource` exactly like Full Camera regions (same clip windowing, `underTrim`), then each projected piece gets `layers = resolveCameraLayout(region, ctx)` with `ctx.frame` = output size, `ctx.cameraAspect(i)` = the camera's perspective `aspect` if set, else its track `width/height` (camera 0: the probed `webcamSourceSize` / `cameraTrack`; others: `additionalCameraTracks[i-1].width/height`, fallback 16/9), `pipShape`/`pipRadiusFrac` from the resolved camera-1 layout (`settings.webcamMaskShape`, `webcamRadiusFrac`). Layers whose camera does not exist on the asset (no track) are dropped; a region left with no layers is dropped.
- `cameras`: one entry per non-null normalized settings entry: `rotation: 180` only if 180, `mirror` only if set, `crop` only if set and no perspective, `homography` = `perspectiveMatrix(p)` when it is non-null (null → omit, Review Focus 5), `aspect` = `p.aspect` when perspective set.
- Omit `cameras` / `cameraLayoutRegions` entirely when empty (unchanged scene for old projects).
- Rust `Scene::for_clip_window`: retain `camera_layout_regions` for the clip with the same rule as `camera_fullscreen_regions` (by `clip_index`, fallback overlap).

- [ ] **Step 1: Failing tests.**
  - `sceneDescription.test.ts`: (a) `a project without camera layouts produces the same scene as before` — build a scene for an existing fixture document and assert `cameras` and `cameraLayoutRegions` are `undefined` and every clip has no `additionalCameras` key; (b) `extra camera tracks become clip cameras` — asset with `additionalCameraTracks: [{ sourcePath: "/w-2.mp4", startMs: 0, offsetMs: 120, visible: true, label: "Desk" }]` → `clips[0].additionalCameras` equals `[{ path: "/w-2.mp4", offsetSec: 0.12 }]`; (c) `a camera-full region for camera 1 stays a Full Camera region` — `legacyEditor.cameraLayoutRegions: [{ id:"a", startMs:1000, endMs:4000, template:"camera-full", slots:[{camera:0}], rotation:180 }]` → it appears in `cameraFullscreenRegions` with `rotation: 180` and `cameraLayoutRegions` is undefined; (d) `a camera-full-pip region becomes resolved layers` — template `camera-full-pip`, slots `[{camera:1},{camera:0}]` → one `cameraLayoutRegions` entry with `startSec 1, endSec 4` and layers `[camera 1 fillsFrame, camera 0 pip]`; (e) `a degenerate perspective sends no homography` — settings `[null, { perspective: { corners: collinear, aspect: 1.5 } }]` → `cameras` is `[{ index: 1 }]` or undefined, but never has `homography`; (f) `a layer for a camera the asset does not have is dropped`.
  - Build the fixtures with the helpers already used in `sceneDescription.test.ts` (find the document factory there; add `additionalCameraTracks` / `legacyEditor` fields to it).
  - `scene.rs`: `parses_extra_cameras_settings_and_layout_regions` (a JSON with all new fields → values), `old_scene_json_parses_without_the_new_fields` (reuse an existing fixture string → empty vectors), `for_clip_window_keeps_only_this_clips_layout_regions`.
- [ ] **Step 2:** run the TS tests and `cargo test -p openscreen-compositor --lib scene::` → FAIL.
- [ ] **Step 3:** implement (TS builder + Rust structs).
- [ ] **Step 4:** PASS; both `tsc`; lint; full `cargo test --lib` shows only the 8 known failures.
- [ ] **Step 5:** commit `feat(compositor): carry extra cameras, camera settings and layout regions in the scene`.

---

### Task 4: Plan camera layers per frame (Rust, pure)

**Files:**
- Create: `crates/compositor/src/camera_layers.rs` (register in `lib.rs`).
- Modify: `crates/compositor/src/frame_geometry.rs` — `FrameGeometry` gains `camera_layers: Vec<CameraLayerPlan>`; `plan_frame` (~:2953-3556) fills it.

**Interfaces:**
- Consumes: Task 3 `SceneCameraLayoutRegion`, `SceneCamera`; `regions.rs` `TRANSITION_WINDOW_S`, `FULLSCREEN_LEAD_OUT_WINDOW_S`, `ease_out_screen_studio`, `ScreenClock` (how `camera_fullscreen_region_phase` turns `t` into region time — copy that).
- Produces:
  ```rust
  #[derive(Debug, Clone, Copy, PartialEq)]
  pub struct CameraLayerPlan {
      pub camera: usize,
      pub dst: [f32; 4],      // x, y, w, h in output fractions
      pub radius_frac: f32,   // of min(dst w, h) in pixels
      pub shape: u32,         // webcam_shape_code vocabulary
      pub opacity: f32,       // 0..1
      pub fills_frame: bool,
  }
  /// `default_cam0`: camera 0's layer as today's plan places it (None = camera 0 not drawn).
  pub fn camera_layers_at(regions: &[SceneCameraLayoutRegion], t: f32, clock: &ScreenClock,
                          default_cam0: Option<CameraLayerPlan>) -> Vec<CameraLayerPlan>;
  ```
  `FrameGeometry.camera_layers` is **empty when `scene.camera_layout_regions` is empty** (backends then run today's camera-0 path untouched). Otherwise it holds every layer to draw, in draw order, including camera 0's (whose `dst`/opacity backends must then take from the plan instead of `w_dst`).

Algorithm:
1. Find the region `r` with `start ≤ t ≤ end` (region time per the clock). None → return `default_cam0` as a one-element vec (or empty).
2. `len = end - start`; `win_in = min(TRANSITION_WINDOW_S, len/2)`; `win_out = min(FULLSCREEN_LEAD_OUT_WINDOW_S, len/2)`.
3. `prev` = layers of a region whose `end` is within 1 ms of `r.start` (adjacent), else the default set. `next` = adjacent region starting within 1 ms of `r.end`, else default.
4. If `t - start < win_in`: `blend(prev, r, ease((t-start)/win_in))`. Else if `end - t < win_out` **and there is no adjacent next region**: `blend(r, default, 1 - ease((end-t)/win_out))`. Else `r`'s layers at full opacity. (With an adjacent next region the hand-over happens in that region's lead-in — Review Focus 4.)
5. `blend(a, b, k)`: for each camera in `a ∪ b`: in both → lerp `dst`, `radius_frac`; `shape`/`fills_frame` from `b` when `k ≥ 0.5` else `a`; opacity 1. Only in `a` → `a`'s geometry, opacity `1-k`. Only in `b` → `b`'s geometry, opacity `k`. Layers with opacity ≤ 1e-3 are dropped.
6. Draw order: `fills_frame` layers first, then the rest; within each group, the order of the target set (`b`, else `a`).
`shape` from the scene string via `webcam_shape_code`; `radius_frac` from `SceneCameraLayer.radius_frac`.

`plan_frame` integration: when regions are non-empty, `default_cam0 = Some(CameraLayerPlan { camera: 0, dst: w_dst, radius_frac: w_radius / min(w_px.x, w_px.y), shape: lp.webcam_shape, opacity: 1.0, fills_frame: cam_progress >= 1.0 })` if `lp.has_webcam`, else `None`; then `camera_layers = camera_layers_at(&scene.camera_layout_regions, t, &clock, default_cam0)` with the same `t`/clock the Full Camera code uses.

- [ ] **Step 1: Failing tests** in `camera_layers.rs` `mod tests` (helper `fn region(start, end, layers: &[(usize, [f32;4], bool)]) -> SceneCameraLayoutRegion` and a default camera-0 PiP at `[0.75,0.7,0.22,0.22]`):
  - `outside_every_region_only_the_default_camera_is_drawn`
  - `inside_a_region_after_the_lead_in_its_layers_are_drawn_fully` (cam 1 full + cam 0 PiP, t mid-region → exact dsts, opacity 1, cam 1 first)
  - `entering_a_region_glides_camera_0_and_fades_in_a_new_camera` (t = start + win_in/2 → cam 0 dst strictly between default and target; cam 1 opacity strictly between 0 and 1)
  - `leaving_a_region_returns_to_the_default`
  - `adjacent_regions_glide_directly` (A: cam 1 full, B: cam 2 full, B.start == A.end; at A.end − 0.01 cam 1 opacity 1 and **no default PiP geometry appears**; at B.start + win_in/2 cam 1 fading out, cam 2 fading in; at no sampled t in [A.end−0.2, B.start+0.2] does camera 0's default PiP dst appear unless it is in A or B)
  - `a_short_region_halves_its_windows`
  - `fills_frame_layers_are_drawn_first`
  - In `frame_geometry.rs` tests: `without_layout_regions_the_plan_has_no_camera_layers` (golden_scene → `camera_layers.is_empty()` and every existing webcam field unchanged vs a snapshot taken by the same test before the call path — compare against `plan_frame` on the scene JSON without the new keys) and `with_a_layout_region_camera_0_comes_from_the_plan` (patch `golden_scene` JSON with a `cameraLayoutRegions` entry → a layer for camera 0 at the region's rect mid-region).
- [ ] **Step 2:** `cargo test -p openscreen-compositor --lib camera_layers` → FAIL.
- [ ] **Step 3:** implement. **Step 4:** PASS + full lib run (only the 8 known failures). **Step 5:** commit `feat(compositor): plan camera layers with a glide between layout regions`.

---

### Task 5: `LayerCB` homography and transparency lanes + shaders (all backends)

**Files:**
- Modify: `crates/compositor/src/frame_geometry.rs` — `LayerCB` (~:45-68), size/offset test (~:7345).
- Modify: `crates/compositor/src/shaders.hlsl`, `crates/compositor/src/vk_shaders/layer.wgsl`, `crates/compositor/src/shaders.metal` — the layer constant buffer and the camera (video, mode 0) fragment path.
- Test: `frame_geometry.rs` (size/offset, naga test ~:8918 still green), Linux pixel test module (`compositor_linux.rs` `mod tests` ~:4053, helpers `compose_pip_scene`, `camera_pixels`) — **runs on Linux CI**; on Windows add the equivalent check only if a D3D11 pixel test harness already exists (search `compositor_windows.rs` tests), else say so.

**Interfaces:**
- Produces: `LayerCB` gains, appended last:
  ```rust
  pub persp: [[f32; 4]; 3], // rows of H (target uv → camera uv): [h0,h1,h2,0],[h3,h4,h5,0],[h6,h7,h8,0]
  pub layer_fx: [f32; 4],   // x = transparency (0 = opaque), y = 1 when persp applies, z,w = 0
  ```
  New size **256 bytes** (192 + 48 + 16). Every existing `LayerCB { .. }` literal must compile with the new fields zeroed (add them where literals are exhaustive, or rely on an existing `Default`/`..` pattern — check how literals are written and follow it).

Shader rule (camera / video mode only; all other modes ignore `persp`):
- `local` = the fragment's position inside the layer's `dst` quad, 0..1 (the shader already derives the texture uv from `dst`→`src`; compute `local` the same way it computes the quad-relative coordinate).
- If `layer_fx.y > 0.5`: `q = (dot(persp[0].xyz, (local,1)), dot(persp[1].xyz, (local,1)), dot(persp[2].xyz, (local,1)))`; `cam = q.xy / q.z`; if `q.z <= 0` or `cam` outside `[0,1]²` → output transparent; texture uv = `cam * fx.xy` (`fx.xy` = valid fraction of the decoder texture, as today). The segmentation mask (camera 0) samples the same uv.
- Final colour alpha (premultiplied as the shader already does) is multiplied by `1 - layer_fx.x` for **every** mode.
- With `layer_fx = 0` the shader output is bit-identical to today.

- [ ] **Step 1: Failing tests:** size/offset test updated to 256 and `offset_of!(LayerCB, persp) == 192`, `offset_of!(LayerCB, layer_fx) == 240`; Linux pixel tests: `identity_lanes_leave_the_camera_pixels_unchanged` (compose the PiP scene twice — once as today, once with `layer_fx = 0` explicitly — equal RGBA), `transparency_half_halves_the_camera_over_the_screen` (camera white over black screen, `layer_fx.x = 0.5` → camera pixels ≈ 128 ± 2), `a_homography_maps_the_camera_quad_to_the_layer` (camera texture with a red left half / blue right half, H = horizontal flip `[-1,0,1, 0,1,0, 0,0,1]` → left half of the layer blue). Wire the test-only values by building the `LayerCB` in the test through the same function the webcam block uses, or by a small test hook — follow the existing test style.
- [ ] **Step 2:** run → FAIL (size assertion, missing fields).
- [ ] **Step 3:** implement Rust struct + the three shaders. Keep HLSL/WGSL/MSL field order identical to Rust.
- [ ] **Step 4:** `cargo test --lib` (size/offset, naga validation of `layer.wgsl` with `LAYER_MODELS` false/true) PASS; HLSL compiles on this host (the crate's build compiles shaders — confirm in the report how); Linux pixel tests are compiled here (`cargo test --lib --no-run` on Windows builds only the Windows backend — say which pixel tests ran where).
- [ ] **Step 5:** commit `feat(compositor): homography and transparency lanes for camera layers`.

---

### Task 6: Draw the planned camera layers (all backends)

**Files:**
- Modify: `crates/compositor/src/compositor_windows.rs` (webcam block ~:2424-2534, `compose_frame` ~:1983, `nv12_srvs` ~:874), `compositor_linux.rs` (~:2420-2530, webcam-pass ~:3382), `compositor_macos.rs` (~:2660-2761).
- Test: Linux pixel tests (`compositor_linux.rs` tests), `frame_geometry.rs` if helpers move there.

**Interfaces:**
- Consumes: Task 4 `FrameGeometry.camera_layers`, Task 5 lanes, Task 3 `Scene::camera(i)`.
- Produces (each backend's `Compositor`):
  ```rust
  /// Frames for cameras 1..=3 (index 0 = camera 1 of the extras, i.e. scene camera index 1).
  /// Null or missing → that camera is not drawn this frame. Valid until the next call.
  pub unsafe fn set_extra_camera_frames(&self, frames: &[*const AVFrame]);
  ```
  Shared helper (put it in `frame_geometry.rs` so all three backends call the same code):
  ```rust
  pub(crate) fn camera_layer_cb(plan: &CameraLayerPlan, camera: Option<&SceneCamera>, visible_px: [f32; 2],
                                tex_px: [f32; 2], render: [f32; 2], base: &LayerCB) -> LayerCB;
  ```
  It returns `base` (camera 0's today-built CB, or a zeroed video CB for extras) with `dst = plan.dst`, `quad_px`, `radius_px = plan.radius_frac * min(quad_px)`, `src` from `webcam_source_rect(visible, tex, crop, box_ar)` with the camera's crop (none when a homography is set or `fills_frame` desk full-frame applies) and flips from the camera's rotation/mirror (`flip_u = mirror ^ turned`, `flip_v = turned`; extras: mirror default **false**), `persp`/`layer_fx.y` from `homography`, `layer_fx.x = 1 - plan.opacity`, motion-blur `dst_prev = dst` (no trail for extras).

Rules:
- `camera_layers.is_empty()` → today's code path, byte-for-byte unchanged — except that when `Scene::camera(0)` carries a `homography`, the camera-0 CB gets `persp` + `layer_fx.y = 1` (and no crop). Test: `camera_0_perspective_applies_without_layout_regions` (Linux pixel test, red/blue halves + flip matrix).
- Otherwise draw `camera_layers` in order, in the place where the webcam is drawn today (after cursor, before annotations). Camera 0's layer uses today's frame/texture, shadow and effects (segmentation, cutout, blur, custom bg); its `dst`/radius/opacity come from its plan layer; if camera 0 has no layer it is not drawn. Extra cameras: no effects (effect code 0), shadow only when `!fills_frame` and shadows are enabled (same constants as camera 0), texture from `set_extra_camera_frames` — **tolerant** (`.ok()`; null → skip, Review Focus 1), even on Windows.
- Windows `nv12_srvs` caches by decoder texture address; extra frames go through the same cache (clear it where it is cleared today).
- Linux: one uniform buffer + bind group per layer (as today per draw); inside the existing "webcam-pass".
- macOS: same structure inside the webcam encoder; compile-only.

- [ ] **Step 1: Failing Linux pixel tests:** `two_cameras_draw_in_their_planned_rects` (screen black, camera 0 white, camera 1 green; scene with a `camera-full-pip` region: camera 1 full, camera 0 PiP → center pixel green, PiP rect white), `a_missing_extra_camera_skips_its_layer` (no frame set for camera 1 → center pixel = screen), `a_fading_extra_camera_is_half_transparent` (plan opacity 0.5 via a mid lead-in time). Plus a Windows unit test of `camera_layer_cb` (pure): homography sets `layer_fx.y = 1` and ignores crop; mirror flips `src` u-bounds; opacity 0.25 → `layer_fx.x = 0.75`.
- [ ] **Step 2:** run → FAIL. **Step 3:** implement the three backends (Windows and Linux fully, macOS mirrored). **Step 4:** `cargo test --lib` (only the 8 known failures); `cargo build` for the Windows backend; report that the Linux tests ran only if a Linux toolchain was available (otherwise CI) and that Metal is compile-checked only in CI. **Step 5:** commit `feat(compositor): draw every planned camera layer`.

---

### Task 7: Live preview decodes the extra cameras (Rust live + napi + TS)

**Files:**
- Modify: `crates/compositor/src/live.rs` (`PrefetchedClip` ~:65, `open_and_seek_clip` ~:151, `PooledClip` ~:184, `Player` ~:296, `step` ~:540-607, `present_frame` ~:643, recompose ~:634, render thread clip switch ~:1274/1400, `set_live_params` ~:1670).
- Modify: `crates/compositor-view-napi/src/lib.rs` (`set_active_clip` ~:372, `create_view` ~:142 if it takes clip paths).
- Modify: `src/components/ai-edition/NativeCompositorOverlay.tsx` (~:275, ~:351) and the napi typings it uses (find the `setActiveClip` declaration in `src/native/` / `electron/` preload).
- Test: `live.rs` tests (~:2325).

**Interfaces:**
- Consumes: Task 3 `SceneClip.additional_cameras`, `Scene.camera_layout_regions`; Task 6 `set_extra_camera_frames`.
- Produces: `Player.extra: Vec<Option<ExtraCamera>>` with `struct ExtraCamera { dec: Decoder, offset_sec: f64 }` (index k-1 = camera k); napi `set_active_clip(id, screen_path, webcam_path, webcam_offset_sec, clip_index, source_time_sec, additional_cameras: Option<Vec<ClipCameraInput>>)` where `ClipCameraInput { path: String, offset_sec: f64 }` (camelCase in JS); TS passes `assetAdditionalCameraSources(asset)`.

Rules:
- A clip opens an extra camera's decoder only if the clip's windowed `camera_layout_regions` reference that camera (`scene.for_clip_window(..)`), and only for a non-empty path; a failed open → `None` with one warning line (Review Focus 1). Pool key extends to the extra paths/offsets (so a pooled pair is reused only for the same set).
- Each step/seek: advance/seek each open extra like `wdec` (`webcam_seek_time(t, offset)`, `frame_step` by pts) **only when** a layout region referencing that camera is within `[region.start - PREFETCH_LEAD_SEC, region.end]` of `t`; otherwise leave it idle. Then `comp.set_extra_camera_frames(&frames)` (null for idle/None/ended) right before every `compose_frame` call (step, present_frame, recompose).
- A finished extra (EOF) yields null — the layer disappears (Review Focus 2).
- Without extras and without layout regions: no new decoder, no new call cost beyond an empty `set_extra_camera_frames(&[])`.

- [ ] **Step 1: Failing tests** (pure helpers so they run without a GPU): `extra_cameras_to_open_are_those_the_clips_regions_reference` (fn `extra_cameras_for_clip(scene, clip_index) -> Vec<usize>`), `an_extra_camera_is_decoded_only_near_its_regions` (fn `extra_camera_active(regions, camera, t) -> bool`), `a_missing_extra_camera_skips_its_layer` (fn that maps a failed open to `None` and the frame list to null — test the mapping helper), `the_pool_key_includes_the_extra_cameras`.
- [ ] **Step 2:** `cargo test --lib live::` → FAIL. **Step 3:** implement live + napi + TS. **Step 4:** PASS; `npx tsc --noEmit`; build the addon (`npm run build:native:compositor`, copy to `bin/win32-arm64`) and confirm it loads in the dev app with a normal one-camera project (no regressions; log line `[compositor-view]` without "not present"). **Step 5:** commit `feat(preview): decode the extra cameras a layout shows`.

---

### Task 8: Export decodes the extra cameras (timeline walk + producers)

**Files:**
- Modify: `crates/compositor/src/timeline_walk.rs` (`walk_composited_timeline` ~:149-363), the three `run_composited_multi` callers (`pipeline_windows.rs` ~:1293/1652/1724, `pipeline_macos.rs` ~:1133/1161/1235, `pipeline_linux.rs` ~:845/947/1032), `ClipSource` (~:1278 / ~:659 / ~:50), `gif_export.rs` caller.
- Modify: `crates/compositor-view-napi/src/lib.rs` (`ClipInput` ~:498, `export_multi` ~:697, GIF ~:887).
- Modify: `src/components/ai-edition/ExportDialog.tsx` (`buildNativeClipList` ~:112), `src/cli/CliExportRunner.tsx` (~:82) — both add `additionalCameras: assetAdditionalCameraSources(asset)` (only when non-empty).
- Test: `timeline_walk.rs` tests (~:432).

**Interfaces:**
- Consumes: Task 3, Task 6 `set_extra_camera_frames`, Task 7 `extra_cameras_for_clip` / `extra_camera_active` (reuse, don't duplicate — move them to a shared module if they live in `live.rs`).
- Produces: `ClipSource.additional_cameras: Vec<ClipCamera>` (`ClipCamera { path: String, offset_sec: f64 }`); `walk_composited_timeline(.., extra_decs: &mut HashMap<String, Decoder>, ..)` (keyed by path like `webcam_decs`).

Rules:
- Per clip, open (once per path) the extra cameras the clip's regions reference; a failed open → warning, camera skipped for the whole export (Review Focus 1).
- **Do not** clamp the clip end to an extra camera's duration (only camera 0 clamps, as today — Review Focus 2).
- Per output frame: for each active extra (`extra_camera_active`), `advance_decoder_to(dec, t, offset)`; `cur_frame()` or null after EOF; `comp.set_extra_camera_frames(..)` before `compose_frame`.
- Deterministic mode unchanged; extras have no segmentation.

- [ ] **Step 1: Failing tests** (pure where possible): `a_short_extra_camera_does_not_shorten_the_clip` (the clip-end computation helper with an extra camera shorter than camera 0 → unchanged end), `export_skips_an_extra_camera_that_will_not_open` (open-result mapping), `extra_offsets_move_into_the_screen_clock` (like `offset_moves_the_webcam_into_the_screen_clock`). TS: `ExportDialog`/`CliExportRunner` clip lists include `additionalCameras` for an asset with an extra track (extend their existing tests if present; otherwise add a small unit test of `buildNativeClipList`).
- [ ] **Step 2:** run → FAIL. **Step 3:** implement. **Step 4:** PASS; both `tsc`; lint; `cargo test --lib` (only the 8 known failures). **Step 5:** commit `feat(export): decode the extra cameras a layout shows`.

---

### Task 9: End-to-end measurement, performance and checklist

**Files:**
- Create: `scripts/multicam-fixture.mjs` (generates synthetic sources + a project file; dev tool, documented in its header).
- Modify: `technical-documentation/testing/manual-e2e-checklist.md` — a "Several cameras in the picture" item + results-log row.

- [ ] **Step 1: Fixture.** With the vendored ffmpeg (`crates/thirdparty/ffmpeg-n8.1.2-win64-lgpl-shared/bin/ffmpeg.exe`): screen 1920×1080 dark grey 8 s; camera 0 solid red 1280×720; camera 1 solid green 1280×720; camera 2 a checkerboard 1280×720 photographed "in perspective" (`ffmpeg -vf perspective=` with known corners, so the true corners are known). Write a `.openscreen` project (copy the shape of an existing saved project under `%APPDATA%\openscreen\projects\`, or build it from the schema) with `additionalCameraTracks` for cameras 1–2, `legacyEditor.cameraLayoutRegions`: `screen-pip [0,1]` 1–3 s, `camera-full-pip [1,0]` 3–5 s (adjacent), `side-by-side [0,1]` 5.5–7 s, and `legacyEditor.cameraSettings[2].perspective` = the known corners with the checkerboard's aspect, plus a `camera-full [2]` region 7–8 s.
- [ ] **Step 2: Headless export** `electron . export <project> -o out.mp4` (dev build, `OPENSCREEN_COMPOSITOR_VIEW_NODE` set). Extract frames with `ffmpeg -ss <t> -i out.mp4 -frames:v 1 -c:v ppm` at 2.0 s, 4.0 s, 6.0 s, 7.5 s and every 1/30 s across 2.9–3.6 s; parse the P6 PPMs (≤ 20-line Node parser) and assert: at 2.0 s two PiPs (red, green) at the template rects ±2 px; at 4.0 s green fills the frame with a red PiP; across the 3 s boundary green grows from its PiP rect to the full frame without passing through "no green" (Review Focus 4); at 6.0 s left half red / right half green; at 7.5 s the checkerboard's squares are axis-aligned (edge positions on a scanline equally spaced ±2 px). Put the assertions in the script; print a pass/fail table.
- [ ] **Step 3: Preview = export.** Grab the dev app's preview at 4.0 s (computer-use not available → use the compositor's frame capture if one exists, else skip and say so) and compare.
- [ ] **Step 4: Performance.** Export time for the fixture vs the same project with layout regions removed (one camera): report both; target ≤ 2× (spec). Live preview: in the dev app, play the fixture and read the compositor's frame-pacing log (find the live loop's timing log line) — report dropped/late frames with 1 vs 3 cameras. If targets are missed, report the numbers; do not tune silently.
- [ ] **Step 5: Checklist + commit.** Checklist item (English, next to the camera items): layouts with real cameras (desk full + face PiP, screen + 2 PiP, side by side), glide, perspective with an A4 sheet, export vs preview, performance with 3 cameras; results-log row marked **Partial** (real-device run with the user's cameras outstanding). Commit `test(compositor): measure several camera layers end to end`.
