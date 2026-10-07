// Finds the four corner markers of the printed marker sheet in a camera still, so the
// calibration dialog can place its handles without dragging. Detection is js-aruco2 (MIT,
// pure JS); the markers are OpenCV's DICT_4X4_50, i.e. the first 50 codes of js-aruco2's
// ARUCO_4X4_1000. The printed sheet (`markerSheet.ts`) draws from the same dictionary.

import aruco, { type ArucoDetector, type ArucoDictionary, type ArucoMarker } from "js-aruco2";
// Registers ARUCO_4X4_1000 in `AR.DICTIONARIES` (side effect).
import "js-aruco2/src/dictionaries/aruco_4x4_1000.js";
import type { CameraPoint } from "@/components/video-editor/types";
import { markerPlaneRect, type PlaneRect } from "./planeMeasure";

/** The four inner corners, normalized 0..1: TL (id 0), TR (1), BR (2), BL (3). */
export type MarkerCorners = [CameraPoint, CameraPoint, CameraPoint, CameraPoint];

/** The detector's view of an RGBA picture; `ImageData` fits. */
export interface RgbaImage {
	width: number;
	height: number;
	data: ArrayLike<number>;
}

const { AR } = aruco;

/** DICT_4X4_50: fewer codes than the 1000 set, so far fewer chance matches on a desk. */
const DICTIONARY_NAME = "OPENSCREEN_4X4_50";
const DICTIONARY_SIZE = 50;
/** Accepts a code at most one bit off (js-aruco2 tests `distance < maxHammingDistance`). */
const MAX_HAMMING_DISTANCE = 2;

/**
 * Printed marker side including its black border — the square the detector's corners outline.
 * The sheet draws at this size, and the measurement takes it as its ruler.
 */
export const MARKER_SIZE_MM = 40;

/** The four inner corners and a frame that is rectangular on the desk. */
export interface MarkedArea {
	/** The markers' inner corners, normalized 0..1 of the image, in handle order. */
	corners: MarkerCorners;
	/**
	 * The frame, its corners normalized 0..1 of the image; null when the markers cannot fix
	 * the plane.
	 */
	plane: PlaneRect | null;
}

/** The marker IDs of the sheet, in handle order: top-left, top-right, bottom-right, bottom-left. */
export const CORNER_MARKER_IDS = [0, 1, 2, 3] as const;

let dictionary: ArucoDictionary | null = null;
let detector: ArucoDetector | null = null;

function registerDictionary() {
	if (AR.DICTIONARIES[DICTIONARY_NAME]) return;
	const full = AR.DICTIONARIES.ARUCO_4X4_1000;
	AR.DICTIONARIES[DICTIONARY_NAME] = {
		nBits: full.nBits,
		tau: null,
		codeList: full.codeList.slice(0, DICTIONARY_SIZE),
	};
}

/** The marker dictionary, built once. */
export function markerDictionary(): ArucoDictionary {
	if (!dictionary) {
		registerDictionary();
		dictionary = new AR.Dictionary(DICTIONARY_NAME);
	}
	return dictionary;
}

/**
 * The data cells of marker `id` (without its black border), row-major; true = white.
 * A 4x4 marker gives four rows of four.
 */
export function markerBits(id: number): boolean[][] {
	const dict = markerDictionary();
	const code = dict.codeList[id];
	if (code === undefined) throw new RangeError(`No marker ${id} in the dictionary`);
	const side = Math.round(Math.sqrt(dict.nBits));
	const rows: boolean[][] = [];
	for (let y = 0; y < side; y++) {
		rows.push(Array.from({ length: side }, (_, x) => code[y * side + x] === "1"));
	}
	return rows;
}

function getDetector(): ArucoDetector {
	if (!detector) {
		registerDictionary();
		detector = new AR.Detector({
			dictionaryName: DICTIONARY_NAME,
			maxHammingDistance: MAX_HAMMING_DISTANCE,
		});
	}
	return detector;
}

/** Of several detections of one ID, the cleanest read, then the largest. */
function better(a: ArucoMarker, b: ArucoMarker): ArucoMarker {
	if (a.hammingDistance !== b.hammingDistance) {
		return a.hammingDistance < b.hammingDistance ? a : b;
	}
	return perimeter(a) >= perimeter(b) ? a : b;
}

function perimeter(m: ArucoMarker): number {
	let sum = 0;
	for (let i = 0; i < m.corners.length; i++) {
		const p = m.corners[i];
		const q = m.corners[(i + 1) % m.corners.length];
		sum += Math.hypot(q.x - p.x, q.y - p.y);
	}
	return sum;
}

/**
 * Finds markers 0–3 (ARUCO 4x4) and returns the four inner corners as TL (id 0), TR (1),
 * BR (2), BL (3); null unless all four are found. The inner corner of a marker is its corner
 * closest to the centroid of the four markers, so the sheet may lie at any rotation.
 */
export function detectCornerMarkers(image: RgbaImage): MarkerCorners | null {
	return detectMarkedArea(image)?.corners ?? null;
}

/**
 * `detectCornerMarkers` plus a true rectangle on the desk that holds the inner corners, with its
 * real proportions and width, measured from the four printed squares themselves (see
 * `planeMeasure.ts`). Null unless all four markers are found; `plane` is null when they cannot
 * fix the plane.
 */
export function detectMarkedArea(image: RgbaImage): MarkedArea | null {
	if (image.width <= 0 || image.height <= 0) return null;
	const found = new Map<number, ArucoMarker>();
	for (const marker of getDetector().detectImage(image.width, image.height, image.data)) {
		if (!(CORNER_MARKER_IDS as readonly number[]).includes(marker.id)) continue;
		if (marker.corners.length !== 4) continue;
		const previous = found.get(marker.id);
		found.set(marker.id, previous ? better(previous, marker) : marker);
	}
	const markers = CORNER_MARKER_IDS.map((id) => found.get(id));
	if (markers.some((m) => m === undefined)) return null;
	const all = markers as ArucoMarker[];

	const centers = all.map((m) => ({
		x: m.corners.reduce((s, c) => s + c.x, 0) / 4,
		y: m.corners.reduce((s, c) => s + c.y, 0) / 4,
	}));
	const centroid = {
		x: centers.reduce((s, c) => s + c.x, 0) / 4,
		y: centers.reduce((s, c) => s + c.y, 0) / 4,
	};
	const inner = all.map((m) => {
		let best = m.corners[0];
		for (const c of m.corners) {
			if (
				Math.hypot(c.x - centroid.x, c.y - centroid.y) <
				Math.hypot(best.x - centroid.x, best.y - centroid.y)
			) {
				best = c;
			}
		}
		return best;
	});
	const toCorners = (p: CameraPoint[]): MarkerCorners => [p[0], p[1], p[2], p[3]];
	const squares = all.map((m) => toCorners(m.corners));
	const rect = markerPlaneRect(squares, MARKER_SIZE_MM, toCorners(inner));
	const normalize = (p: CameraPoint) => ({ x: p.x / image.width, y: p.y / image.height });
	return {
		corners: toCorners(inner.map(normalize)),
		plane: rect ? { ...rect, corners: toCorners(rect.corners.map(normalize)) } : null,
	};
}
