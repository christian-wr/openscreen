# Kalibrierdialog: Entzerrung, dann freier Ausschnitt — Implementation Plan (Teil A)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** „Marker erkennen“ bestimmt nur noch die Tischebene; der Nutzer zieht danach einen Ausschnitt (4:3, 16:9, 9:16, 1:1, frei) auf das entzerrte Bild, und gespeichert werden die Bildecken eines auf dem Tisch wirklich rechtwinkligen Rechtecks.

**Architecture:** Die Marker-Quadrate liefern eine metrische Entzerrung (zirkuläre Punkte, schon in `planeMeasure.ts`). Daraus wird ein *Basisrechteck* auf der Ebene gebaut — selbst eine gewöhnliche `CameraPerspective` (vier Bildecken + echtes Seitenverhältnis). Alles Weitere ist Geometrie in Bruchteilen einer vergrößerten *Ansicht* dieses Rechtecks (`planeCrop.ts`): der Ausschnitt ist eine `CropRegion` in der Ansicht und wird beim Übernehmen zurück in vier Bildecken gerechnet. Datenmodell, Compositor und Export bleiben unverändert.

**Tech Stack:** TypeScript (strict), React 19, Vitest (node + jsdom), Biome, i18next-Locales (15 Sprachen).

**Spec:** `docs/superpowers/specs/2026-10-06-desk-lane-and-free-crop-design.md` (Teil A)

## Global Constraints

- Arbeitsverzeichnis `C:\osc-cams`, Branch `feat/multi-camera-layouts`; nichts pushen.
- `CameraPerspective { corners, aspect, margin? }` bleibt unverändert; alte Projekte laden wie bisher.
- Keine Änderung an Rust/Shadern/Compositor.
- Code-Kommentare auf Englisch; Biome (Tabs, doppelte Anführungszeichen, 100 Spalten); kein `any`.
- Jeder neue UI-Text in allen 15 Locale-Dateien `src/i18n/locales/*/dialogs.json`; `npm run i18n:check` grün.
- Keine Claude-Signatur und kein `Co-Authored-By` in Commit-Nachrichten.
- Prüfen pro Task: die betroffenen Testdateien mit `npx vitest --run <pfad>`; vor dem letzten Commit einmal `npm run test`, `npx tsc --noEmit`, `npx tsc -p tsconfig.test.json --noEmit`, `npm run lint`.

## Review Focus

- **Frei verteilte Marker, die kein Rechteck bilden** (der echte Fall des Nutzers): das gespeicherte Viereck muss auf der Ebene rechtwinklig sein — Test in Task 1 (Winkel 90° ± 0,5°).
- **Ansicht über den Horizont hinaus** (steile Kamera, große Vergrößerung): `planeView` darf keine Ecke hinter der Kamera erzeugen — Test in Task 3.
- **Gespeicherte Perspektive erneut öffnen und unverändert übernehmen**: Ecken und Seitenverhältnis bleiben gleich (Rundreise) — Test in Task 4.
- **Alte Perspektive mit Rand oder gekreuztem Viereck**: öffnet im Vier-Griffe-Modus wie bisher — bestehende Tests in Task 4 bleiben grün.
- **Ausschnitt größer als das Kamerabild / Seitenverhältnis außerhalb 0,1…10**: Hinweis bzw. „Übernehmen“ gesperrt — Tests in Task 4.

---

### Task 1: Basisrechteck auf der Ebene (`markerPlaneRect`)

**Files:**
- Modify: `src/lib/planeMeasure.ts`
- Create: `src/lib/planeMeasure.test.ts`

**Interfaces:**
- Produces:
  - `export interface PlaneRect { corners: Corners; aspect: number; widthMm: number }`
  - `export function markerPlaneRect(squares: Corners[], sideMm: number, inner: Corners): PlaneRect | null` — alle Punkte in *einem* Bildkoordinatensystem (Pixel); `corners` im selben System, Reihenfolge TL, TR, BR, BL; das Rechteck ist die achsenparallele Hülle der vier inneren Ecken, ausgerichtet an inner[0] → inner[1].
  - `export function invert3(m: number[]): number[] | null` (bisher privat)
  - `measureOnPlane` und `PlaneSize` bleiben vorerst (Task 4 entfernt sie).

- [ ] **Step 1: Failing test schreiben** — `src/lib/planeMeasure.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { CameraPerspective } from "@/components/video-editor/types";
import { markerPlaneRect } from "./planeMeasure";

type Corners = CameraPerspective["corners"];
interface Pt {
	x: number;
	y: number;
}

// A camera looking at the desk at a slant: world millimetres -> image pixels.
const H = [1.1, 0.25, 420, 0.04, 0.8, 180, 0.0003, 0.0008, 1];

function project(m: number[], p: Pt): Pt {
	const w = m[6] * p.x + m[7] * p.y + m[8];
	return { x: (m[0] * p.x + m[1] * p.y + m[2]) / w, y: (m[3] * p.x + m[4] * p.y + m[5]) / w };
}

function inverse(m: number[]): number[] {
	const [a, b, c, d, e, f, g, h, i] = m;
	const A = e * i - f * h;
	const B = f * g - d * i;
	const C = d * h - e * g;
	const det = a * A + b * B + c * C;
	return [
		A / det,
		(c * h - b * i) / det,
		(b * f - c * e) / det,
		B / det,
		(a * i - c * g) / det,
		(c * d - a * f) / det,
		C / det,
		(b * g - a * h) / det,
		(a * e - b * d) / det,
	];
}

/** A 40 mm square centred on `c`, turned by `deg`, corners clockwise from its top-left. */
function square(c: Pt, deg: number): Pt[] {
	const r = (deg * Math.PI) / 180;
	return [
		{ x: -20, y: -20 },
		{ x: 20, y: -20 },
		{ x: 20, y: 20 },
		{ x: -20, y: 20 },
	].map((p) => ({
		x: c.x + p.x * Math.cos(r) - p.y * Math.sin(r),
		y: c.y + p.x * Math.sin(r) + p.y * Math.cos(r),
	}));
}

/** The square's corner nearest to `toward`. */
function nearest(sq: Pt[], toward: Pt): Pt {
	return sq.reduce((best, p) =>
		Math.hypot(p.x - toward.x, p.y - toward.y) < Math.hypot(best.x - toward.x, best.y - toward.y)
			? p
			: best,
	);
}

function angleAt(a: Pt, b: Pt, c: Pt): number {
	const u = { x: a.x - b.x, y: a.y - b.y };
	const v = { x: c.x - b.x, y: c.y - b.y };
	return (
		(Math.acos((u.x * v.x + u.y * v.y) / (Math.hypot(u.x, u.y) * Math.hypot(v.x, v.y))) * 180) /
		Math.PI
	);
}

// Markers laid freely: no rectangle, each turned its own way (the user's real desk).
const CENTERS: Pt[] = [
	{ x: 0, y: 0 },
	{ x: 620, y: -40 },
	{ x: 560, y: 430 },
	{ x: -90, y: 300 },
];
const TURNS = [5, -12, 30, 80];
const WORLD_SQUARES = CENTERS.map((c, i) => square(c, TURNS[i]));
const MIDDLE = {
	x: CENTERS.reduce((s, c) => s + c.x, 0) / 4,
	y: CENTERS.reduce((s, c) => s + c.y, 0) / 4,
};
const WORLD_INNER = WORLD_SQUARES.map((sq) => nearest(sq, MIDDLE));

const toImage = (pts: Pt[]) => pts.map((p) => project(H, p)) as Corners;

describe("markerPlaneRect", () => {
	const rect = markerPlaneRect(
		WORLD_SQUARES.map(toImage),
		40,
		toImage(WORLD_INNER) as Corners,
	);
	const world = rect ? rect.corners.map((p) => project(inverse(H), p)) : [];

	it("is a true rectangle on the desk although the markers are not", () => {
		expect(rect).not.toBeNull();
		for (let k = 0; k < 4; k++) {
			expect(angleAt(world[(k + 3) % 4], world[k], world[(k + 1) % 4])).toBeCloseTo(90, 0);
		}
	});

	it("reports the real width and proportions", () => {
		const width = Math.hypot(world[1].x - world[0].x, world[1].y - world[0].y);
		const height = Math.hypot(world[3].x - world[0].x, world[3].y - world[0].y);
		expect(Math.abs((rect?.widthMm ?? 0) - width) / width).toBeLessThan(0.005);
		expect(Math.abs((rect?.aspect ?? 0) - width / height) / (width / height)).toBeLessThan(0.005);
	});

	it("runs along marker 0 -> marker 1 and keeps marker 0 at the top-left", () => {
		const along = Math.atan2(world[1].y - world[0].y, world[1].x - world[0].x);
		const markers = Math.atan2(
			WORLD_INNER[1].y - WORLD_INNER[0].y,
			WORLD_INNER[1].x - WORLD_INNER[0].x,
		);
		expect(Math.abs(along - markers)).toBeLessThan(0.01);
		// The rectangle is the hull of the inner corners: marker 0's corner lies on its top edge
		// side, so the top-left is nearer to it than to any other inner corner.
		const d = WORLD_INNER.map((p) => Math.hypot(p.x - world[0].x, p.y - world[0].y));
		expect(d.indexOf(Math.min(...d))).toBe(0);
	});

	it("gives nothing without squares", () => {
		expect(markerPlaneRect([], 40, toImage(WORLD_INNER) as Corners)).toBeNull();
	});
});
```

- [ ] **Step 2: Test laufen lassen, muss fehlschlagen**

Run: `npx vitest --run src/lib/planeMeasure.test.ts`
Expected: FAIL — `markerPlaneRect` ist kein Export.

- [ ] **Step 3: Implementieren** — in `src/lib/planeMeasure.ts`:

1. `function invert3` → `export function invert3` (Signatur unverändert).
2. Den Teil von `measureOnPlane`, der aus den Quadraten die Abbildung Bild → Ebene baut, als eigene Funktion herausziehen und `measureOnPlane` darauf umstellen (Verhalten unverändert):

```ts
/** Image -> metric plane (similarity-correct), from the squares; `anchor` must be off the horizon. */
function rectifyingHomography(squares: Corners[], anchor: Pt): number[] | null {
	const points = squares.map(circularPoint).filter((v): v is CVec => v !== null);
	if (points.length === 0) return null;
	// The pair is only defined up to a complex factor and conjugation (a square traced the other
	// way round sees the conjugate), so each is turned onto the first before summing.
	const ref = points[0];
	const sum: CVec = { re: [0, 0, 0], im: [0, 0, 0] };
	for (const v of points) {
		const direct = alignTo(v, ref);
		const mirrored = alignTo(conj(v), ref);
		const { aligned } = direct.residual <= mirrored.residual ? direct : mirrored;
		for (let k = 0; k < 3; k++) {
			sum.re[k] += aligned.re[k];
			sum.im[k] += aligned.im[k];
		}
	}
	// M = [re | im | anchor] maps the metric plane onto the image with (1, ±i, 0) landing on the
	// circular points, for any anchor off the vanishing line.
	return invert3([
		sum.re[0],
		sum.im[0],
		anchor.x,
		sum.re[1],
		sum.im[1],
		anchor.y,
		sum.re[2],
		sum.im[2],
		1,
	]);
}

/** Millimetres per plane unit: the squares' mean side against their printed side. */
function mmPerUnitOf(toPlane: number[], squares: Corners[], sideMm: number): number | null {
	let sideSum = 0;
	let sideCount = 0;
	for (const square of squares) {
		const r = square.map((p) => apply(toPlane, p));
		if (r.some((p) => p === null)) continue;
		const q = r as Pt[];
		for (let k = 0; k < 4; k++) sideSum += length(q[k], q[(k + 1) % 4]);
		sideCount += 4;
	}
	return sideCount > 0 && sideSum > 0 ? sideMm / (sideSum / sideCount) : null;
}
```

   `measureOnPlane` ruft danach `rectifyingHomography(squares, { x: cx, y: cy })` und `mmPerUnitOf(...)` auf.

3. Neu dazu:

```ts
/** A true rectangle on the plane, as the image sees it. */
export interface PlaneRect {
	/** Its image corners TL, TR, BR, BL, in the caller's image coordinates. */
	corners: Corners;
	/** Real width ÷ height. */
	aspect: number;
	/** Real width in millimetres. */
	widthMm: number;
}

/**
 * The rectangle on the plane that just holds the four inner corners, its top edge parallel to
 * inner[0] -> inner[1]: a frame that is rectangular on the desk however the markers lie. Null
 * when the squares do not pin the plane down.
 */
export function markerPlaneRect(
	squares: Corners[],
	sideMm: number,
	inner: Corners,
): PlaneRect | null {
	const anchor = {
		x: inner.reduce((s, p) => s + p.x, 0) / 4,
		y: inner.reduce((s, p) => s + p.y, 0) / 4,
	};
	const toPlane = rectifyingHomography(squares, anchor);
	const fromPlane = toPlane ? invert3(toPlane) : null;
	if (!toPlane || !fromPlane) return null;
	const mmPerUnit = mmPerUnitOf(toPlane, squares, sideMm);
	const onPlane = inner.map((p) => apply(toPlane, p));
	if (mmPerUnit === null || onPlane.some((p) => p === null)) return null;
	const p = onPlane as Pt[];

	// Local frame: x along marker 0 -> marker 1. The rectification may mirror the plane; marker 3
	// (bottom-left) must end up below marker 0, so y is flipped when it is not.
	const theta = Math.atan2(p[1].y - p[0].y, p[1].x - p[0].x);
	const cos = Math.cos(theta);
	const sin = Math.sin(theta);
	const rotated = p.map((q) => ({ x: q.x * cos + q.y * sin, y: -q.x * sin + q.y * cos }));
	const flip = rotated[3].y < rotated[0].y ? -1 : 1;
	const local = rotated.map((q) => ({ x: q.x, y: q.y * flip }));
	const minX = Math.min(...local.map((q) => q.x));
	const maxX = Math.max(...local.map((q) => q.x));
	const minY = Math.min(...local.map((q) => q.y));
	const maxY = Math.max(...local.map((q) => q.y));
	const w = maxX - minX;
	const h = maxY - minY;
	if (!(w > 0 && h > 0)) return null;

	const toImage = (q: Pt) => {
		const y = q.y * flip;
		return apply(fromPlane, { x: q.x * cos - y * sin, y: q.x * sin + y * cos });
	};
	const corners = [
		{ x: minX, y: minY },
		{ x: maxX, y: minY },
		{ x: maxX, y: maxY },
		{ x: minX, y: maxY },
	].map(toImage);
	if (corners.some((q) => q === null)) return null;
	const [c0, c1, c2, c3] = corners as Pt[];
	return { corners: [c0, c1, c2, c3], aspect: w / h, widthMm: w * mmPerUnit };
}
```

- [ ] **Step 4: Tests laufen lassen, müssen bestehen**

Run: `npx vitest --run src/lib/planeMeasure.test.ts src/lib/arucoMarkers.test.ts`
Expected: PASS (die bestehenden `arucoMarkers`-Tests zeigen, dass `measureOnPlane` unverändert misst).

- [ ] **Step 5: Commit**

```bash
git add src/lib/planeMeasure.ts src/lib/planeMeasure.test.ts
git commit -m "feat(camera): a true rectangle on the desk from freely laid markers"
```

---

### Task 2: Marker-Erkennung liefert das Basisrechteck

**Files:**
- Modify: `src/lib/arucoMarkers.ts`
- Modify: `src/lib/arucoMarkers.test.ts`

**Interfaces:**
- Consumes: `markerPlaneRect`, `PlaneRect` aus Task 1.
- Produces: `MarkedArea` bekommt `plane: PlaneRect | null` mit **normierten** Ecken (0..1 des Bildes); `size` bleibt bis Task 4.

- [ ] **Step 1: Failing tests** — an den `describe("detectMarkedArea", …)`-Block in `src/lib/arucoMarkers.test.ts` anhängen:

```ts
	it("frames the marked area as a rectangle on the sheet, in image fractions", () => {
		const { image, toImage } = photograph(W, H, TILTED, [0, 1, 2, 3]);
		const plane = detectMarkedArea(image)?.plane;
		expect(plane).toBeTruthy();
		// The test sheet's inner corners already form a rectangle, so the frame is that rectangle.
		plane?.corners.forEach((c, i) => {
			expectNear(c, toImage(INNER_ON_SHEET[i]), 4);
		});
		expectWithin(plane?.aspect ?? 0, AREA_W / AREA_H, 0.04);
		expectWithin(plane?.widthMm ?? 0, AREA_W * MM_PER_UNIT, 0.04);
	});
```

- [ ] **Step 2: Fehlschlag prüfen**

Run: `npx vitest --run src/lib/arucoMarkers.test.ts`
Expected: FAIL — `plane` ist `undefined`.

- [ ] **Step 3: Implementieren** — in `src/lib/arucoMarkers.ts`:

```ts
import { markerPlaneRect, measureOnPlane, type PlaneRect, type PlaneSize } from "./planeMeasure";

/** The four inner corners, the marked area's real size, and a frame that is rectangular on the desk. */
export interface MarkedArea {
	corners: MarkerCorners;
	size: PlaneSize | null;
	/** Corners normalized 0..1 of the image; null when the markers cannot fix the plane. */
	plane: PlaneRect | null;
}
```

   und am Ende von `detectMarkedArea` (nach `size`):

```ts
	const squares = all.map((m) => toCorners(m.corners));
	const rect = markerPlaneRect(squares, MARKER_SIZE_MM, toCorners(inner));
	const normalize = (p: CameraPoint) => ({ x: p.x / image.width, y: p.y / image.height });
	return {
		corners: toCorners(inner.map(normalize)),
		size,
		plane: rect ? { ...rect, corners: toCorners(rect.corners.map(normalize)) } : null,
	};
```

   (`size` nutzt weiterhin `squares`; die bisherige `all.map(...)`-Zeile im `measureOnPlane`-Aufruf durch `squares` ersetzen.)

- [ ] **Step 4: Tests bestehen**

Run: `npx vitest --run src/lib/arucoMarkers.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/arucoMarkers.ts src/lib/arucoMarkers.test.ts
git commit -m "feat(camera): marker detection frames the desk as a true rectangle"
```

---

### Task 3: Geometrie des Ausschnitts auf der Ebene (`planeCrop.ts`)

**Files:**
- Create: `src/lib/ai-edition/timeline/planeCrop.ts`
- Create: `src/lib/ai-edition/timeline/planeCrop.test.ts`

**Interfaces:**
- Consumes: `homographyFromUnitSquare` (`@/lib/cameraPerspective`), `mapThrough`, `MIN_CROP` (`./calibrationGeometry`), `invert3` (`@/lib/planeMeasure`).
- Produces (alle Bruchteile 0..1 der Ansicht, `viewAspect` = echtes Breite/Höhe der Ansicht):
  - `export const PLANE_VIEW_GROW = 1.6;`
  - `export function planeView(base: CameraPerspective, grow?: number): CameraPerspective | null`
  - `export function cropToPerspective(view: CameraPerspective, crop: CropRegion): CameraPerspective | null`
  - `export function perspectiveToCrop(view: CameraPerspective, p: CameraPerspective): CropRegion | null`
  - `export function cropAspectOf(viewAspect: number, crop: CropRegion): number`
  - `export function fitCrop(viewAspect: number, cropAspect: number | null, box: CropRegion): CropRegion`
  - `export type CropCorner = "nw" | "ne" | "sw" | "se";`
  - `export function resizeCropLocked(start: CropRegion, corner: CropCorner, dx: number, dy: number, viewAspect: number, cropAspect: number): CropRegion`
  - `export function cropLeavesImage(p: CameraPerspective): boolean`

- [ ] **Step 1: Failing tests** — `src/lib/ai-edition/timeline/planeCrop.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { CameraPerspective, CropRegion } from "@/components/video-editor/types";
import { homographyFromUnitSquare } from "@/lib/cameraPerspective";
import {
	cropAspectOf,
	cropLeavesImage,
	cropToPerspective,
	fitCrop,
	PLANE_VIEW_GROW,
	perspectiveToCrop,
	planeView,
	resizeCropLocked,
} from "./planeCrop";

// Seen straight on: a 0.6 x 0.6 square of the image that is 2:1 in reality.
const FLAT: CameraPerspective = {
	corners: [
		{ x: 0.2, y: 0.2 },
		{ x: 0.8, y: 0.2 },
		{ x: 0.8, y: 0.8 },
		{ x: 0.2, y: 0.8 },
	],
	aspect: 2,
};

// A desk seen steeply: the far edge much narrower than the near one.
const STEEP: CameraPerspective = {
	corners: [
		{ x: 0.44, y: 0.3 },
		{ x: 0.56, y: 0.3 },
		{ x: 0.95, y: 0.95 },
		{ x: 0.05, y: 0.95 },
	],
	aspect: 1.5,
};

function close(a: CropRegion | null, b: CropRegion, digits = 6) {
	expect(a).not.toBeNull();
	expect(a?.x).toBeCloseTo(b.x, digits);
	expect(a?.y).toBeCloseTo(b.y, digits);
	expect(a?.width).toBeCloseTo(b.width, digits);
	expect(a?.height).toBeCloseTo(b.height, digits);
}

describe("planeView", () => {
	it("grows the base rectangle about its centre and keeps its real proportions", () => {
		const view = planeView(FLAT);
		expect(view?.aspect).toBe(2);
		expect(view?.corners[0].x).toBeCloseTo(0.2 - 0.3 * 0.6, 9);
		expect(view?.corners[2].y).toBeCloseTo(0.8 + 0.3 * 0.6, 9);
	});

	it("puts the base in the middle of the view", () => {
		const view = planeView(FLAT);
		const side = 1 / PLANE_VIEW_GROW;
		close(view && perspectiveToCrop(view, FLAT), {
			x: (1 - side) / 2,
			y: (1 - side) / 2,
			width: side,
			height: side,
		});
	});

	it("never reaches past the horizon of a steep view", () => {
		const view = planeView(STEEP, 4);
		const h = homographyFromUnitSquare(STEEP.corners);
		expect(view).not.toBeNull();
		expect(h).not.toBeNull();
		// Every view corner, taken back onto the base, sits in front of the camera.
		const box = view && perspectiveToCrop(view, STEEP);
		expect(box).not.toBeNull();
		if (!h || !box) return;
		const lo = -box.x / box.width;
		const hi = (1 - box.x) / box.width;
		for (const [u, v] of [
			[lo, lo],
			[hi, lo],
			[hi, hi],
			[lo, hi],
		]) {
			expect(h[6] * u + h[7] * v + h[8]).toBeGreaterThan(0);
		}
	});
});

describe("crop <-> perspective", () => {
	it("round-trips a crop", () => {
		const view = planeView(STEEP);
		const crop = { x: 0.2, y: 0.25, width: 0.5, height: 0.3 };
		const p = view && cropToPerspective(view, crop);
		close(view && p && perspectiveToCrop(view, p), crop);
	});

	it("gives the crop its real proportions", () => {
		const view = planeView(FLAT);
		const p = view && cropToPerspective(view, { x: 0.1, y: 0.1, width: 0.5, height: 0.25 });
		expect(p?.aspect).toBeCloseTo(4, 9);
		expect(cropAspectOf(2, { x: 0, y: 0, width: 0.5, height: 0.25 })).toBeCloseTo(4, 9);
	});

	it("notices a crop that leaves the camera image", () => {
		const view = planeView(FLAT);
		expect(cropLeavesImage(view && cropToPerspective(view, { x: 0, y: 0, width: 1, height: 1 }))).toBe(
			false,
		);
		const wide = planeView(FLAT, 2);
		expect(cropLeavesImage(wide && cropToPerspective(wide, { x: 0, y: 0, width: 1, height: 1 }))).toBe(
			true,
		);
	});
});

describe("fitCrop", () => {
	it("fits the largest crop of a real aspect into a box, centred", () => {
		// View 2:1; a 16:9 crop is k = 2 / (16/9) = 1.125 times as tall as wide in fractions.
		close(fitCrop(2, 16 / 9, { x: 0, y: 0, width: 1, height: 1 }), {
			x: (1 - 1 / 1.125) / 2,
			y: 0,
			width: 1 / 1.125,
			height: 1,
		});
	});

	it("keeps the box for a free format", () => {
		const box = { x: 0.1, y: 0.2, width: 0.3, height: 0.4 };
		expect(fitCrop(2, null, box)).toEqual(box);
	});
});

describe("resizeCropLocked", () => {
	const start = { x: 0.2, y: 0.2, width: 0.4, height: 0.4 * 1.125 };

	it("keeps the aspect and the opposite corner", () => {
		const r = resizeCropLocked(start, "se", 0.1, 0, 2, 16 / 9);
		expect(r.x).toBeCloseTo(0.2, 9);
		expect(r.y).toBeCloseTo(0.2, 9);
		expect(r.width).toBeCloseTo(0.5, 9);
		expect(cropAspectOf(2, r)).toBeCloseTo(16 / 9, 9);
	});

	it("follows the axis the pointer moved further along", () => {
		const r = resizeCropLocked(start, "nw", 0, -0.2, 2, 16 / 9);
		expect(r.x + r.width).toBeCloseTo(0.6, 9);
		expect(r.y + r.height).toBeCloseTo(0.2 + 0.45, 9);
		expect(r.height).toBeCloseTo(0.45 + 0.2, 9);
	});

	it("stops at the view's edge", () => {
		const r = resizeCropLocked(start, "se", 5, 5, 2, 16 / 9);
		expect(r.x + r.width).toBeLessThanOrEqual(1 + 1e-9);
		expect(r.y + r.height).toBeLessThanOrEqual(1 + 1e-9);
		expect(cropAspectOf(2, r)).toBeCloseTo(16 / 9, 9);
	});
});
```

- [ ] **Step 2: Fehlschlag prüfen**

Run: `npx vitest --run src/lib/ai-edition/timeline/planeCrop.test.ts`
Expected: FAIL — Modul `./planeCrop` fehlt.

- [ ] **Step 3: Implementieren** — `src/lib/ai-edition/timeline/planeCrop.ts`:

```ts
// The crop on the rectified desk. A "base" is a CameraPerspective whose corners are a true
// rectangle on the plane (from the markers, or a stored correction). The dialog shows a "view":
// the base grown about its centre, still a true rectangle. The user's crop is a CropRegion in
// fractions of that view; turning it back into four image corners gives a perspective that is
// rectangular on the desk whatever the crop's format.

import type { CameraPerspective, CropRegion } from "@/components/video-editor/types";
import { homographyFromUnitSquare } from "@/lib/cameraPerspective";
import { invert3 } from "@/lib/planeMeasure";
import { MIN_CROP, mapThrough } from "./calibrationGeometry";

/** How much larger than the base the view is, on each side's length. */
export const PLANE_VIEW_GROW = 1.6;
/** A view corner closer to the horizon than this (homogeneous w) is pulled back. */
const MIN_W = 0.05;
const GROW_STEPS = 6;

type Corners = CameraPerspective["corners"];

function cornersOf(h: number[], x0: number, y0: number, x1: number, y1: number): Corners | null {
	const pts = [
		mapThrough(h, x0, y0),
		mapThrough(h, x1, y0),
		mapThrough(h, x1, y1),
		mapThrough(h, x0, y1),
	];
	if (pts.some((p) => p === null)) return null;
	const [a, b, c, d] = pts as NonNullable<(typeof pts)[number]>[];
	return [a, b, c, d];
}

/**
 * The base grown `grow` times about its centre — less when that would reach past the horizon,
 * never less than the base itself. Null when the base is not a usable quad.
 */
export function planeView(
	base: CameraPerspective,
	grow = PLANE_VIEW_GROW,
): CameraPerspective | null {
	const h = homographyFromUnitSquare(base.corners);
	if (!h) return null;
	for (let k = GROW_STEPS; k >= 0; k--) {
		const g = 1 + ((grow - 1) * k) / GROW_STEPS;
		const lo = (1 - g) / 2;
		const hi = (1 + g) / 2;
		const ws = [
			[lo, lo],
			[hi, lo],
			[hi, hi],
			[lo, hi],
		].map(([u, v]) => h[6] * u + h[7] * v + h[8]);
		if (ws.some((w) => w <= MIN_W)) continue;
		const corners = cornersOf(h, lo, lo, hi, hi);
		if (corners) return { corners, aspect: base.aspect };
	}
	return null;
}

/** The view's crop as a perspective: four image corners and the crop's real proportions. */
export function cropToPerspective(
	view: CameraPerspective,
	crop: CropRegion,
): CameraPerspective | null {
	const h = homographyFromUnitSquare(view.corners);
	if (!h) return null;
	const corners = cornersOf(h, crop.x, crop.y, crop.x + crop.width, crop.y + crop.height);
	return corners ? { corners, aspect: cropAspectOf(view.aspect, crop) } : null;
}

/** Where a perspective's corners sit in the view, as the rectangle that holds them. */
export function perspectiveToCrop(
	view: CameraPerspective,
	p: CameraPerspective,
): CropRegion | null {
	const h = homographyFromUnitSquare(view.corners);
	const inv = h ? invert3(h) : null;
	if (!inv) return null;
	const uv = p.corners.map((c) => mapThrough(inv, c.x, c.y));
	if (uv.some((q) => q === null)) return null;
	const q = uv as NonNullable<(typeof uv)[number]>[];
	const x0 = Math.min(...q.map((c) => c.x));
	const x1 = Math.max(...q.map((c) => c.x));
	const y0 = Math.min(...q.map((c) => c.y));
	const y1 = Math.max(...q.map((c) => c.y));
	return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/** Real width ÷ height of a crop in a view of real aspect `viewAspect`. */
export function cropAspectOf(viewAspect: number, crop: CropRegion): number {
	return (viewAspect * crop.width) / crop.height;
}

/** The largest crop of real aspect `cropAspect` inside `box`, centred; the box itself when free. */
export function fitCrop(viewAspect: number, cropAspect: number | null, box: CropRegion): CropRegion {
	if (cropAspect === null) return { ...box };
	// In view fractions the crop is k times as tall as it is wide.
	const k = viewAspect / cropAspect;
	const width = Math.min(box.width, box.height / k);
	const height = width * k;
	return {
		x: box.x + (box.width - width) / 2,
		y: box.y + (box.height - height) / 2,
		width,
		height,
	};
}

export type CropCorner = "nw" | "ne" | "sw" | "se";

/**
 * `start` resized from `corner` by (dx, dy), its real aspect held and the opposite corner fixed:
 * the size follows whichever axis the pointer moved further along, inside the view.
 */
export function resizeCropLocked(
	start: CropRegion,
	corner: CropCorner,
	dx: number,
	dy: number,
	viewAspect: number,
	cropAspect: number,
): CropRegion {
	const k = viewAspect / cropAspect;
	const east = corner.endsWith("e");
	const south = corner.startsWith("s");
	const anchorX = east ? start.x : start.x + start.width;
	const anchorY = south ? start.y : start.y + start.height;
	const fromX = start.width + (east ? dx : -dx);
	const fromY = (start.height + (south ? dy : -dy)) / k;
	const maxWidth = Math.min(east ? 1 - anchorX : anchorX, (south ? 1 - anchorY : anchorY) / k);
	const minWidth = Math.max(MIN_CROP, MIN_CROP / k);
	const width = Math.min(maxWidth, Math.max(minWidth, Math.max(fromX, fromY)));
	const height = width * k;
	return {
		x: east ? anchorX : anchorX - width,
		y: south ? anchorY : anchorY - height,
		width,
		height,
	};
}

/** True when a corner of `p` lies outside the camera image (the picture turns black there). */
export function cropLeavesImage(p: CameraPerspective | null): boolean {
	if (!p) return false;
	const eps = 0.002;
	return p.corners.some((c) => c.x < -eps || c.y < -eps || c.x > 1 + eps || c.y > 1 + eps);
}
```

- [ ] **Step 4: Tests bestehen**

Run: `npx vitest --run src/lib/ai-edition/timeline/planeCrop.test.ts`
Expected: PASS. Falls „never reaches past the horizon“ mit `STEEP` schon bei `grow = 4` kein Zurückziehen braucht, `grow` im Test erhöhen, bis `perspectiveToCrop(view, STEEP).width > 1 / 4` gilt (dann wurde zurückgezogen), und diese Bedingung zusätzlich prüfen.

- [ ] **Step 5: Commit**

```bash
git add src/lib/ai-edition/timeline/planeCrop.ts src/lib/ai-edition/timeline/planeCrop.test.ts
git commit -m "feat(camera): crop geometry on the rectified desk"
```

---

### Task 4: Dialog — Ausschnitt auf dem entzerrten Bild

**Files:**
- Modify: `src/components/ai-edition/CameraCalibrationModal.tsx`
- Modify: `src/components/ai-edition/CameraCalibrationModal.test.tsx`
- Modify: `src/lib/arucoMarkers.ts`, `src/lib/arucoMarkers.test.ts`, `src/lib/planeMeasure.ts` (Aufräumen: `size`/`measureOnPlane`/`PlaneSize` entfernen)
- Modify: `src/i18n/locales/*/dialogs.json` (15 Dateien)

**Interfaces:**
- Consumes: `MarkedArea.plane` (Task 2), alles aus `planeCrop.ts` (Task 3).
- Produces: unverändert `onApply({ perspective })`.

**Verhalten (aus der Spec):**
- *Ebenen-Modus* gilt, wenn `mode === "perspective"`, eine Ebene bekannt ist und der Nutzer nicht auf „Vier Ecken von Hand“ steht. Eine Ebene ist bekannt nach erfolgreicher Erkennung mit `plane`, oder beim Öffnen, wenn eine gespeicherte Perspektive **ohne** `margin` vorliegt und `planeView(stored)` nicht `null` ist (ein gekreuztes Viereck öffnet also wie bisher mit vier Griffen).
- Im Ebenen-Modus zeigt der große Rahmen das entzerrte Bild der Ansicht (`renderRectified(image, view, …)`) im Seitenverhältnis `view.aspect`, darüber das Ausschnitt-Rechteck (Eckgriffe; Kantengriffe nur bei „frei“). Formate: 4:3, 16:9 (Vorgabe), 9:16, 1:1, frei. Kein Rand-Regler.
- Formatwechsel passt den Ausschnitt neu in das Basisrechteck ein (`fitCrop(view.aspect, aspect, perspectiveToCrop(view, plane))`); „frei“ lässt ihn stehen.
- Nach Erkennung mit bekannter Breite: Zeile „Ausschnitt: ca. B × H cm“.
- Liegt eine Ausschnitt-Ecke außerhalb des Kamerabilds: Hinweis `cropOutside`.
- Übernehmen speichert `cropToPerspective(view, planeCrop)` (ohne `margin`); gesperrt, wenn das Seitenverhältnis außerhalb `MIN_ASPECT…MAX_ASPECT` liegt.
- Erkennung ohne `plane`: Ecken auf die Marker setzen, Vier-Griffe-Modus, Meldung `noPlane`.

- [ ] **Step 1: Failing tests** — in `CameraCalibrationModal.test.tsx`:

  a) Am Dateianfang die echten Geometrie-Funktionen importieren (nicht mocken):

```ts
import { cropToPerspective, fitCrop, perspectiveToCrop, planeView } from "@/lib/ai-edition/timeline/planeCrop";
```

  b) Die beiden Tests „detect fills the handles“ und „a measured area sets the format to its real proportions“ **ersetzen** durch:

```ts
	const FOUND = [
		{ x: 0.2, y: 0.25 },
		{ x: 0.8, y: 0.2 },
		{ x: 0.85, y: 0.9 },
		{ x: 0.1, y: 0.8 },
	];
	// A desk frame seen straight on: 0.6 x 0.6 of the image, 2:1 and 1 m wide in reality.
	const PLANE = {
		corners: [
			{ x: 0.2, y: 0.2 },
			{ x: 0.8, y: 0.2 },
			{ x: 0.8, y: 0.8 },
			{ x: 0.2, y: 0.8 },
		] as [
			{ x: number; y: number },
			{ x: number; y: number },
			{ x: number; y: number },
			{ x: number; y: number },
		],
		aspect: 2,
		widthMm: 1000,
	};
	const detect = () =>
		fireEvent.click(screen.getByRole("button", { name: "dialogs.cameraCalibration.detectMarkers" }));

	function expectedPerspective(aspect: number) {
		const base = { corners: PLANE.corners, aspect: PLANE.aspect };
		const view = planeView(base);
		const box = view && perspectiveToCrop(view, base);
		if (!view || !box) throw new Error("test plane must be usable");
		return cropToPerspective(view, fitCrop(view.aspect, aspect, box));
	}

	it("detect without a plane puts the handles on the markers", async () => {
		detectMarkedArea.mockReturnValueOnce({ corners: FOUND, plane: null });
		const { onApply } = renderModal("perspective", null);
		await stillLoaded();
		detect();
		expect(detectMarkedArea).toHaveBeenCalledWith(IMAGE);
		expect(screen.getByRole("status")).toHaveTextContent("dialogs.cameraCalibration.noPlane");
		expect(screen.getByTestId("calibration-handle-0")).toBeInTheDocument();
		fireEvent.click(apply());
		expect(onApply.mock.calls[0][0].perspective.corners).toEqual(FOUND);
	});

	it("detect shows the rectified desk with a 16:9 crop", async () => {
		detectMarkedArea.mockReturnValueOnce({ corners: FOUND, plane: PLANE });
		const { onApply } = renderModal("perspective", null);
		await stillLoaded();
		detect();
		expect(screen.getByRole("status")).toHaveTextContent("dialogs.cameraCalibration.markersFound");
		expect(screen.getByTestId("calibration-plane")).toBeInTheDocument();
		expect(screen.queryByTestId("calibration-handle-0")).toBeNull();
		fireEvent.click(apply());
		const stored = onApply.mock.calls[0][0].perspective;
		const expected = expectedPerspective(16 / 9);
		expect(stored.aspect).toBeCloseTo(16 / 9, 9);
		expect(stored.margin).toBeUndefined();
		stored.corners.forEach((c: { x: number; y: number }, i: number) => {
			expect(c.x).toBeCloseTo(expected?.corners[i].x ?? Number.NaN, 9);
			expect(c.y).toBeCloseTo(expected?.corners[i].y ?? Number.NaN, 9);
		});
	});

	it("a format refits the crop on the desk", async () => {
		detectMarkedArea.mockReturnValueOnce({ corners: FOUND, plane: PLANE });
		const { onApply } = renderModal("perspective", null);
		await stillLoaded();
		detect();
		fireEvent.click(screen.getByRole("button", { name: "9:16" }));
		fireEvent.click(apply());
		expect(onApply.mock.calls[0][0].perspective.aspect).toBeCloseTo(9 / 16, 9);
	});

	it("shows the crop's real size after detection", async () => {
		detectMarkedArea.mockReturnValueOnce({ corners: FOUND, plane: PLANE });
		renderModal("perspective", null);
		await stillLoaded();
		detect();
		expect(screen.getByText("dialogs.cameraCalibration.cropSize")).toBeInTheDocument();
	});

	it("hand mode brings back the four handles", async () => {
		detectMarkedArea.mockReturnValueOnce({ corners: FOUND, plane: PLANE });
		renderModal("perspective", null);
		await stillLoaded();
		detect();
		fireEvent.click(screen.getByRole("button", { name: "dialogs.cameraCalibration.handMode" }));
		expect(screen.getByTestId("calibration-handle-0")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "dialogs.cameraCalibration.planeMode" }));
		expect(screen.getByTestId("calibration-plane")).toBeInTheDocument();
	});

	it("a stored correction reopens on the desk and applies unchanged", async () => {
		const stored = { corners: PLANE.corners, aspect: 2 };
		const { onApply } = renderModal("perspective", { perspective: stored });
		await stillLoaded();
		expect(screen.getByTestId("calibration-plane")).toBeInTheDocument();
		fireEvent.click(apply());
		const out = onApply.mock.calls[0][0].perspective;
		expect(out.aspect).toBeCloseTo(2, 9);
		out.corners.forEach((c: { x: number; y: number }, i: number) => {
			expect(c.x).toBeCloseTo(stored.corners[i].x, 9);
			expect(c.y).toBeCloseTo(stored.corners[i].y, 9);
		});
	});

	it("a stored correction with a margin still opens with the four handles", async () => {
		renderModal("perspective", { perspective: { corners: PLANE.corners, aspect: 2, margin: 0.1 } });
		await stillLoaded();
		expect(screen.getByTestId("calibration-handle-0")).toBeInTheDocument();
	});
```

  c) In den übrigen Tests jedes `detectMarkedArea.mockReturnValueOnce(null)` unverändert lassen. Der Test „reset removes the stored perspective“ bleibt gültig (Zurücksetzen gibt es in beiden Modi).

- [ ] **Step 2: Fehlschlag prüfen**

Run: `npx vitest --run src/components/ai-edition/CameraCalibrationModal.test.tsx`
Expected: FAIL in den neuen Tests (kein `calibration-plane`, kein `noPlane`).

- [ ] **Step 3: Implementieren**

  **3a — Importe und Konstanten** (`CameraCalibrationModal.tsx`):

```ts
import {
	type CropCorner,
	cropAspectOf,
	cropLeavesImage,
	cropToPerspective,
	fitCrop,
	perspectiveToCrop,
	planeView,
	resizeCropLocked,
} from "@/lib/ai-edition/timeline/planeCrop";
```

   `import type { PlaneSize } from "@/lib/planeMeasure";` entfernen. Neben `FORMATS`:

```ts
type PlaneFormatId = "standard" | "wide" | "tall" | "square" | "free";

/** Formats of a crop on the rectified desk. */
const PLANE_FORMATS: ReadonlyArray<{ id: PlaneFormatId; aspect: number | null }> = [
	{ id: "standard", aspect: 4 / 3 },
	{ id: "wide", aspect: 16 / 9 },
	{ id: "tall", aspect: 9 / 16 },
	{ id: "square", aspect: 1 },
	{ id: "free", aspect: null },
];

/** Long side of the rectified desk drawn in the big frame. */
const PLANE_VIEW_LONG_SIDE_PX = 960;

function planeFormatOf(aspect: number): PlaneFormatId {
	const match = PLANE_FORMATS.find((f) => f.aspect !== null && Math.abs(f.aspect - aspect) < 1e-3);
	return match?.id ?? "free";
}

/** A stored correction that can reopen as a crop on the desk: no margin, a usable quad. */
function storedPlane(stored: CameraPerspective | undefined): CameraPerspective | null {
	if (!stored || stored.margin) return null;
	const base = { corners: copyCorners(stored.corners), aspect: stored.aspect };
	return planeView(base) ? base : null;
}
```

   `MarkerResult` ersetzen durch:

```ts
/** What "Detect markers" last reported. */
type MarkerResult = { kind: "found" } | { kind: "noPlane" } | { kind: "notFound" };
```

  **3b — Zustand** (nach den bestehenden `useState`-Zeilen):

```ts
	// The desk plane: a true rectangle on it (from the markers or the stored correction), the crop
	// the user places on its rectified view, and the plane's real width when the markers told it.
	const [plane, setPlane] = useState<CameraPerspective | null>(() => storedPlane(stored));
	const [manual, setManual] = useState(() => storedPlane(stored) === null);
	const [planeWidthMm, setPlaneWidthMm] = useState<number | null>(null);
	const [planeFormat, setPlaneFormat] = useState<PlaneFormatId>(() =>
		storedPlane(stored) ? planeFormatOf(stored?.aspect ?? 1) : "wide",
	);
	const view = useMemo(() => (plane ? planeView(plane) : null), [plane]);
	/** Where the plane's base rectangle sits in the view: the default crop's box. */
	const baseBox = useMemo(
		() => (view && plane ? perspectiveToCrop(view, plane) : null),
		[view, plane],
	);
	const [planeCrop, setPlaneCrop] = useState<CropRegion>(() => {
		const base = storedPlane(stored);
		const v = base ? planeView(base) : null;
		return (v && base && perspectiveToCrop(v, base)) ?? FULL_CROP;
	});
	const planeRef = useRef<HTMLCanvasElement | null>(null);
```

  **3c — Abgeleitete Werte** (nach `const perspective = useMemo(...)` die bisherige Variable in `handPerspective` umbenennen und so ergänzen):

```ts
	const planeMode = mode === "perspective" && !manual && view !== null;
	const planeAspect = PLANE_FORMATS.find((f) => f.id === planeFormat)?.aspect ?? null;
	const planePerspective = useMemo(
		() => (planeMode && view ? cropToPerspective(view, planeCrop) : null),
		[planeMode, view, planeCrop],
	);
	const planeAspectOk =
		planePerspective !== null &&
		planePerspective.aspect >= MIN_ASPECT &&
		planePerspective.aspect <= MAX_ASPECT;
	const perspective = planeMode ? (planeAspectOk ? planePerspective : null) : handPerspective;
	const preview = previewSize(perspective?.aspect ?? aspect ?? 1, PREVIEW_LONG_SIDE_PX);
```

   (Die bisherige Zeile `const preview = previewSize(aspect ?? 1, …)` entfällt.)

  **3d — Entzerrtes Bild zeichnen** (neuer Effekt neben dem Vorschau-Effekt):

```ts
	// The rectified desk under the crop, redrawn when the plane changes.
	useEffect(() => {
		const canvas = planeRef.current;
		const ctx = canvas?.getContext("2d");
		if (!planeMode || !canvas || !ctx || !image || !view) return;
		const size = previewSize(view.aspect, PLANE_VIEW_LONG_SIDE_PX);
		canvas.width = size.width;
		canvas.height = size.height;
		const pixels = renderRectified(image, view, size.width, size.height);
		if (pixels) ctx.putImageData(new ImageData(pixels, size.width, size.height), 0, 0);
	}, [planeMode, image, view]);
```

  **3e — Ausschnitt-Handler auf das aktive Rechteck umstellen.** `startCropMove`, `startCropResize` und `onCropKeyDown` arbeiten heute auf `crop`/`setCrop`. Davor einfügen und diese drei Funktionen darauf umstellen:

```ts
	// The rectangle the crop handles move: the camera crop, or the crop on the rectified desk.
	const activeCrop = planeMode ? planeCrop : crop;
	const setActiveCrop = planeMode ? setPlaneCrop : setCrop;
	/** Real aspect the crop must keep while resized; null = free. */
	const lockedAspect = planeMode ? planeAspect : null;

	const resizeActive = (start: CropRegion, edges: CropEdges, dx: number, dy: number) => {
		const corner = cornerOf(edges);
		return lockedAspect !== null && corner && view
			? resizeCropLocked(start, corner, dx, dy, view.aspect, lockedAspect)
			: resizeCrop(start, edges, dx, dy);
	};
```

   mit der Hilfsfunktion auf Modulebene:

```ts
/** The corner a pair of moved edges names; null for a single edge. */
function cornerOf(edges: CropEdges): CropCorner | null {
	const ns = edges.top ? "n" : edges.bottom ? "s" : null;
	const we = edges.left ? "w" : edges.right ? "e" : null;
	return ns && we ? (`${ns}${we}` as CropCorner) : null;
}
```

   In den drei Handlern `crop` → `activeCrop`, `setCrop(` → `setActiveCrop(` und `resizeCrop(start, edges, …)` bzw. `resizeCrop(crop, { right: …, bottom: … }, …)` → `resizeActive(…)` mit denselben Argumenten. In `onCropKeyDown` bei Umschalt die Kanten `{ right: true, bottom: true }` übergeben, wenn `lockedAspect !== null` (Eckzug „se“), sonst wie bisher `{ right: dx !== 0, bottom: dy !== 0 }`.

  **3f — Erkennung** (`detectMarkers` ersetzen):

```ts
	// The markers fix the desk plane; the crop on it starts as the format's largest rectangle in
	// the markers' frame. Without a plane they still place the four corners.
	const detectMarkers = () => {
		if (!image) return;
		const area = detectMarkedArea(image);
		if (!area) {
			setMarkerResult({ kind: "notFound" });
			return;
		}
		setCorners(copyCorners(area.corners));
		const base = area.plane ? { corners: copyCorners(area.plane.corners), aspect: area.plane.aspect } : null;
		const nextView = base ? planeView(base) : null;
		const box = nextView && base ? perspectiveToCrop(nextView, base) : null;
		if (!base || !nextView || !box) {
			setManual(true);
			setMarkerResult({ kind: "noPlane" });
			return;
		}
		setPlane(base);
		setPlaneWidthMm(area.plane?.widthMm ?? null);
		setPlaneCrop(fitCrop(nextView.aspect, planeAspect, box));
		setManual(false);
		setMarkerResult({ kind: "found" });
	};

	const selectPlaneFormat = (id: PlaneFormatId) => {
		setPlaneFormat(id);
		const target = PLANE_FORMATS.find((f) => f.id === id)?.aspect ?? null;
		if (target !== null && view && baseBox) setPlaneCrop(fitCrop(view.aspect, target, baseBox));
	};

	// Real size of the crop, when the markers measured the plane.
	const cropSizeCm =
		planeMode && view && baseBox && planeWidthMm !== null
			? (() => {
					const widthMm = (planeCrop.width / baseBox.width) * planeWidthMm;
					return {
						width: Math.round(widthMm / 10),
						height: Math.round(widthMm / cropAspectOf(view.aspect, planeCrop) / 10),
					};
				})()
			: null;
```

  **3g — JSX.**
   - Hinweistext oben: `planeMode ? t("cameraCalibration.planeHelp") : isPerspective ? t("cameraCalibration.perspectiveHelp") : t("cameraCalibration.cropHelp")`.
   - Rahmen: `style={{ ...previewBoxStyle(planeMode && view ? view.aspect : imageAspect), touchAction: "none" }}`, `onPointerDown={isPerspective && !planeMode ? onFramePointerDown : undefined}`. Den Standbild-Canvas mit `display: planeMode ? "none" : undefined` versehen (er bleibt Quelle der Lupe). Dahinter im Ebenen-Modus:

```tsx
				{planeMode ? (
					<canvas
						ref={planeRef}
						data-testid="calibration-plane"
						aria-hidden
						style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}
					/>
				) : null}
```

   - Die Bedingung des bestehenden Blocks `{isPerspective ? (<> …Polygon, Griffe, Lupe… </>) : (<div …calibration-crop…>)}` wird zu `{isPerspective && !planeMode ? ( …unverändert… ) : ( …Ausschnitt… )}`. Im Ausschnitt-`div` `crop` durch `activeCrop` ersetzen und die Kantengriffe nur rendern, wenn `lockedAspect === null`: `{lockedAspect === null ? CROP_EDGES.map(…) : null}`.
   - Knopfzeile (Erkennen/Drucken): nach „Markerblatt drucken“, nur wenn `view !== null`:

```tsx
					{view !== null ? (
						<button
							type="button"
							className={`${styles.btn} ${styles.btnSecondary}`}
							onClick={() => setManual((m) => !m)}
						>
							{manual ? t("cameraCalibration.planeMode") : t("cameraCalibration.handMode")}
						</button>
					) : null}
```

     Status-Text: `found` → `markersFound`, `noPlane` → `noPlane`, `notFound` → `markersNotFound`.
   - Formatspalte: im Ebenen-Modus statt der bisherigen `ChoiceRow<FormatId>` + Freiverhältnis + Rand:

```tsx
						{planeMode ? (
							<>
								<ChoiceRow<PlaneFormatId>
									label={t("cameraCalibration.format")}
									columns={3}
									options={[
										{ value: "standard", label: "4:3" },
										{ value: "wide", label: "16:9" },
										{ value: "tall", label: "9:16" },
										{ value: "square", label: "1:1" },
										{ value: "free", label: t("cameraCalibration.formats.free") },
									]}
									value={planeFormat}
									onChange={selectPlaneFormat}
								/>
								{cropSizeCm ? (
									<p className={styles.hint} style={{ margin: 0 }}>
										{t("cameraCalibration.cropSize", cropSizeCm)}
									</p>
								) : null}
								{cropLeavesImage(planePerspective) ? (
									<p className={styles.hint} style={{ margin: 0 }}>
										{t("cameraCalibration.cropOutside")}
									</p>
								) : null}
							</>
						) : (
							<>…bisherige Format-ChoiceRow, Freiverhältnis, ungültiges Verhältnis, Rand-Regler…</>
						)}
```

   - Der Hinweis „invalidQuad“ und `aria-describedby` am Übernehmen-Knopf nur im Hand-Modus: Bedingung `isPerspective && !planeMode && !quadValid`.

  **3h — `apply`** bleibt; es benutzt jetzt das neue `perspective` (im Ebenen-Modus ohne `margin`). `canApply` bleibt `isPerspective ? perspective !== null : true`.

  **3i — Aufräumen** (alte Messung, die durch die Ebene ersetzt ist):
   - `src/lib/arucoMarkers.ts`: Feld `size` aus `MarkedArea` und den `measureOnPlane`-Aufruf entfernen; Import auf `markerPlaneRect, type PlaneRect`.
   - `src/lib/planeMeasure.ts`: `measureOnPlane` und `PlaneSize` entfernen.
   - `src/lib/arucoMarkers.test.ts`: die drei Tests, die `area?.size` prüfen („measures the marked rectangle's real size…“, „…steep keystone…“, „…rotated sheet…“), auf `area?.plane` umstellen: Breite `plane.widthMm` statt `size.widthMm`, Höhe `plane.widthMm / plane.aspect` statt `size.heightMm`, Verhältnis `plane.aspect`; Toleranzen unverändert.

  **3j — Texte** in allen 15 `src/i18n/locales/*/dialogs.json` unter `cameraCalibration`: `markersMeasured` entfernen; neu (deutsch/englisch hier, die übrigen 13 sinngemäß übersetzen):

| Schlüssel | en | de |
|---|---|---|
| `planeHelp` | Drag the crop on the straightened desk. The corner handles resize it. | Ziehe den Ausschnitt auf dem entzerrten Tisch. Die Eckgriffe ändern die Größe. |
| `handMode` | Four corners by hand | Vier Ecken von Hand |
| `planeMode` | Crop on the straightened desk | Ausschnitt auf entzerrtem Tisch |
| `noPlane` | All four markers found, but the desk plane could not be determined; the corners were placed on them. | Alle vier Marker gefunden, aber die Tischebene ließ sich nicht bestimmen; die Ecken wurden auf sie gesetzt. |
| `cropSize` | Crop: about {{width}} × {{height}} cm | Ausschnitt: ca. {{width}} × {{height}} cm |
| `cropOutside` | The crop reaches past the camera picture; that part stays black. | Der Ausschnitt reicht über das Kamerabild hinaus; dort bleibt das Bild schwarz. |

   `perspectiveHelp` bleibt (gilt für den Hand-Modus).

- [ ] **Step 4: Tests und Prüfungen**

Run: `npx vitest --run src/components/ai-edition/CameraCalibrationModal.test.tsx src/lib/arucoMarkers.test.ts src/lib/planeMeasure.test.ts src/lib/ai-edition/timeline/planeCrop.test.ts`
Expected: PASS.

Run: `npx tsc --noEmit; npx tsc -p tsconfig.test.json --noEmit; npm run lint; npm run i18n:check`
Expected: keine Fehler.

- [ ] **Step 5: Commit**

```bash
git add -A src/components/ai-edition/CameraCalibrationModal.tsx src/components/ai-edition/CameraCalibrationModal.test.tsx src/lib/arucoMarkers.ts src/lib/arucoMarkers.test.ts src/lib/planeMeasure.ts src/i18n/locales
git commit -m "feat(camera): crop on the straightened desk after marker detection"
```

---

### Task 5: Gesamtprüfung und echter Lauf

**Files:**
- Modify: `technical-documentation/testing/manual-e2e-checklist.md` (Results-Log-Zeile)

- [ ] **Step 1: Volle Suite**

Run: `npm run test`
Expected: alle Dateien grün (Stand vor dieser Arbeit: 324 Dateien, 4437 Tests).

- [ ] **Step 2: Echter Lauf mit dem Bild des Nutzers (ohne App)** — die Probe aus der Diagnose wiederholen: Einzelbild aus `recording-1791290781616-webcam-2.mp4` (ffmpeg aus `crates/thirdparty/ffmpeg-*/bin`), `detectMarkedArea` darauf, `planeView` + `fitCrop(…, 16/9, …)` + `cropToPerspective`, Ergebnis mit `renderRectified` als PNG schreiben und ansehen: Tischkante und Tastatur gerade, rechte Winkel.

- [ ] **Step 3: Dev-Build starten** (`OPENSCREEN_COMPOSITOR_VIEW_NODE=C:\osc-cams\electron\native\bin\win32-arm64\compositor_view.node`, `npm run dev` in `C:\osc-cams`) und dem Nutzer den Test übergeben: Perspektive korrigieren → Marker erkennen → 16:9 → Übernehmen → Vorschau und Export gerade; Größe gegen Zollstock.

- [ ] **Step 4: Results-Log-Zeile** nach dem Lauf des Nutzers eintragen (Datum, `feat/multi-camera-layouts @ <hash>`, Windows 11 ARM64, Partial, was geprüft und was nicht) und committen:

```bash
git add technical-documentation/testing/manual-e2e-checklist.md
git commit -m "test: log the straightened-desk crop run"
```
