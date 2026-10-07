// Desk sections ("D"): spans in which the project's desk camera fills the frame. They are
// stored as their own clip-anchored list and become rows the compositor already draws only
// when the scene is built: a camera-full layout of the desk camera, or a Full Camera row when
// the desk camera is camera 1.

import type {
	CameraFullscreenRegion,
	CameraSettings,
	DeskRegion,
} from "@/components/video-editor/types";
import type { AnchoredCameraLayoutRegion } from "./cameraLayouts";

interface Anchor {
	clipId?: string;
	assetId?: string;
	sourceStartSec?: number;
	sourceEndSec?: number;
}

export type AnchoredDeskRegion = DeskRegion & Anchor;

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null;
}

function anchorOf(raw: Record<string, unknown>): Anchor {
	const out: Anchor = {};
	if (typeof raw.clipId === "string") out.clipId = raw.clipId;
	if (typeof raw.assetId === "string") out.assetId = raw.assetId;
	if (typeof raw.sourceStartSec === "number") out.sourceStartSec = raw.sourceStartSec;
	if (typeof raw.sourceEndSec === "number") out.sourceEndSec = raw.sourceEndSec;
	return out;
}

/** Stored desk sections, read defensively: broken rows and later overlapping rows are dropped. */
export function normalizeDeskRegions(raw: unknown): AnchoredDeskRegion[] {
	if (!Array.isArray(raw)) return [];
	const valid: AnchoredDeskRegion[] = [];
	for (const r of raw) {
		if (!isRecord(r) || typeof r.id !== "string") continue;
		const { startMs, endMs } = r;
		if (typeof startMs !== "number" || typeof endMs !== "number") continue;
		if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs >= endMs) continue;
		valid.push({
			id: r.id,
			startMs,
			endMs,
			...anchorOf(r),
			...(r.deskLabel === false ? { deskLabel: false as const } : {}),
		});
	}
	valid.sort((a, b) => a.startMs - b.startMs);
	const kept: AnchoredDeskRegion[] = [];
	for (const row of valid) {
		const last = kept[kept.length - 1];
		if (last && row.startMs < last.endMs) continue;
		kept.push(row);
	}
	return kept;
}

/**
 * The desk camera (0 = camera 1): the chosen one while the project has it and it is available;
 * else the first available camera other than the main camera with a perspective; else the first
 * available camera other than the main camera, in index order; else none. `mainCamera` is the
 * resolved main camera (camera 1 by default), the face: an automatic pick never lands on it, and
 * camera 1 is a candidate while another camera is the main one. `available` says whether a
 * camera's layer would be drawn at all (visible, with a file) — a camera that would show nothing
 * never shows a desk section.
 */
export function resolveDeskCamera(input: {
	deskCamera: unknown;
	cameraCount: number;
	cameraSettings: CameraSettings[];
	available: (index: number) => boolean;
	mainCamera?: number;
}): number | null {
	const { deskCamera, cameraCount, cameraSettings, available, mainCamera = 0 } = input;
	if (
		typeof deskCamera === "number" &&
		Number.isInteger(deskCamera) &&
		deskCamera >= 0 &&
		deskCamera < cameraCount &&
		available(deskCamera)
	) {
		return deskCamera;
	}
	for (let i = 0; i < cameraCount; i++) {
		if (i !== mainCamera && cameraSettings[i]?.perspective && available(i)) return i;
	}
	for (let i = 0; i < cameraCount; i++) {
		if (i !== mainCamera && available(i)) return i;
	}
	return null;
}

/** The scene's view of the desk sections: rows of the two lists the compositor draws. */
export function deskRowsForScene(
	rows: AnchoredDeskRegion[],
	deskCamera: number | null,
): {
	layout: AnchoredCameraLayoutRegion[];
	full: Array<CameraFullscreenRegion & Anchor>;
} {
	if (deskCamera === null) return { layout: [], full: [] };
	const span = ({ deskLabel: _label, ...row }: AnchoredDeskRegion) => row;
	if (deskCamera === 0) return { layout: [], full: rows.map(span) };
	return {
		layout: rows.map((row) => ({
			...span(row),
			template: "camera-full" as const,
			slots: [{ camera: deskCamera }],
		})),
		full: [],
	};
}
