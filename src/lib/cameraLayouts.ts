import type {
	CameraLayoutRegion,
	CameraLayoutSlot,
	CameraLayoutTemplate,
	CameraPerspective,
	CameraSettings,
	CropRegion,
	NormalizedRect,
} from "@/components/video-editor/types";
import { normalizeCameraMirror, normalizeCameraRotation } from "./cameraOrientation";

export const MAX_CAMERAS = 4;

export const TEMPLATE_SLOTS: Record<CameraLayoutTemplate, { min: number; max: number }> = {
	"screen-pip": { min: 1, max: 3 },
	"camera-full": { min: 1, max: 1 },
	"camera-full-pip": { min: 2, max: 3 },
	"side-by-side": { min: 2, max: 2 },
};

const RECT_MIN = -0.5;
const RECT_MAX = 1.5;
const MAX_MARGIN = 0.2;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function inRange(value: unknown, min: number, max: number): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}

const TEMPLATES: ReadonlySet<string> = new Set(Object.keys(TEMPLATE_SLOTS));

function isTemplate(value: unknown): value is CameraLayoutTemplate {
	return typeof value === "string" && TEMPLATES.has(value);
}

function normalizeRect(raw: unknown): NormalizedRect | undefined {
	if (!isRecord(raw)) return undefined;
	const { x, y, width, height } = raw;
	if (
		!inRange(x, RECT_MIN, RECT_MAX) ||
		!inRange(y, RECT_MIN, RECT_MAX) ||
		!inRange(width, RECT_MIN, RECT_MAX) ||
		!inRange(height, RECT_MIN, RECT_MAX) ||
		width <= 0 ||
		height <= 0
	) {
		return undefined;
	}
	return { x, y, width, height };
}

function normalizeSlots(raw: unknown, template: CameraLayoutTemplate): CameraLayoutSlot[] {
	if (!Array.isArray(raw)) return [];
	const seen = new Set<number>();
	const slots: CameraLayoutSlot[] = [];
	for (const entry of raw) {
		if (!isRecord(entry)) continue;
		const camera = entry.camera;
		if (!Number.isInteger(camera) || (camera as number) < 0 || (camera as number) >= MAX_CAMERAS) {
			continue;
		}
		if (seen.has(camera as number)) continue;
		seen.add(camera as number);
		const rect = normalizeRect(entry.rect);
		slots.push(rect ? { camera: camera as number, rect } : { camera: camera as number });
	}
	return slots.slice(0, TEMPLATE_SLOTS[template].max);
}

/** A stored layout section: like a Full Camera region it is clip-anchored, so the anchor
 *  fields are the source of truth and `startMs`/`endMs` a derived cache. */
export type AnchoredCameraLayoutRegion = CameraLayoutRegion & {
	clipId?: string;
	assetId?: string;
	sourceStartSec?: number;
	sourceEndSec?: number;
};

/**
 * A `camera-full` section of the main camera (`mainCamera`, camera 1 by default): that is a
 * Full Camera region, never a layout row. A `camera-full` section of any other camera, camera 1
 * included while another camera is the main one, is a layout row.
 */
export function isFullCameraLayout(
	region: Pick<CameraLayoutRegion, "template" | "slots">,
	mainCamera = 0,
): boolean {
	return (
		region.template === "camera-full" &&
		region.slots.length === 1 &&
		region.slots[0]?.camera === mainCamera
	);
}

function copyAnchor(raw: Record<string, unknown>, region: AnchoredCameraLayoutRegion): void {
	if (typeof raw.clipId === "string") region.clipId = raw.clipId;
	if (typeof raw.assetId === "string") region.assetId = raw.assetId;
	if (typeof raw.sourceStartSec === "number" && Number.isFinite(raw.sourceStartSec)) {
		region.sourceStartSec = raw.sourceStartSec;
	}
	if (typeof raw.sourceEndSec === "number" && Number.isFinite(raw.sourceEndSec)) {
		region.sourceEndSec = raw.sourceEndSec;
	}
}

function normalizeRegion(raw: unknown): AnchoredCameraLayoutRegion | null {
	if (!isRecord(raw) || !isTemplate(raw.template)) return null;
	const { id, startMs, endMs } = raw;
	if (typeof id !== "string") return null;
	if (typeof startMs !== "number" || typeof endMs !== "number") return null;
	if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs >= endMs) return null;
	const template = raw.template;
	const slots = normalizeSlots(raw.slots, template);
	if (slots.length < TEMPLATE_SLOTS[template].min) return null;
	const region: AnchoredCameraLayoutRegion = { id, startMs, endMs, template, slots };
	copyAnchor(raw, region);
	// The desk-view fields belong to camera 1's Full Camera alone; another camera's
	// camera-full draws through the layout path, which ignores them.
	if (isFullCameraLayout(region)) {
		const rotation = normalizeCameraRotation(raw.rotation);
		const mirror = normalizeCameraMirror(raw.mirror);
		if (rotation !== 0) region.rotation = rotation;
		if (mirror !== "auto") region.mirror = mirror;
		if (raw.deskLabel === false) region.deskLabel = false;
	}
	return region;
}

function normalizeAll(raw: unknown): AnchoredCameraLayoutRegion[] {
	if (!Array.isArray(raw)) return [];
	return raw
		.map(normalizeRegion)
		.filter((r): r is AnchoredCameraLayoutRegion => r !== null)
		.sort((a, b) => a.startMs - b.startMs);
}

/**
 * Reads stored layout regions defensively: invalid ones are dropped, and a later row that
 * overlaps an earlier one in this list is dropped too. A `camera-full` row of the main camera
 * (`mainCamera`, camera 1 by default) is dropped as well: that section is stored in
 * `cameraFullscreenRegions`, never here. Overlaps with that other list are prevented by the
 * editor, not repaired here.
 */
export function normalizeCameraLayoutRegions(
	raw: unknown,
	mainCamera = 0,
): AnchoredCameraLayoutRegion[] {
	return withoutOverlaps(normalizeAll(raw).filter((r) => !isFullCameraLayout(r, mainCamera)));
}

/**
 * Every valid stored layout row, read like `normalizeCameraLayoutRegions` but with no role
 * filter: a `camera-full` row of the main camera is kept. The role rule decides where a writer
 * stores a section; a row stored before the main camera changed stays in this list, and the
 * scene still draws it, so the editor lane and every overlap check must still see it.
 */
export function storedCameraLayoutRows(raw: unknown): AnchoredCameraLayoutRegion[] {
	return withoutOverlaps(normalizeAll(raw));
}

/** Drops each row that overlaps an earlier kept one; `rows` is sorted by start. */
function withoutOverlaps(rows: AnchoredCameraLayoutRegion[]): AnchoredCameraLayoutRegion[] {
	const kept: AnchoredCameraLayoutRegion[] = [];
	for (const region of rows) {
		const last = kept[kept.length - 1];
		if (last && region.startMs < last.endMs) continue;
		kept.push(region);
	}
	return kept;
}

/**
 * The rows of a camera-lane list that the span `[startMs, endMs)` overlaps. Full Camera and
 * layout sections share one lane and may never overlap each other, so every writer that
 * places a section (editor and agent) asks this before writing. Touching is not overlap.
 */
export function cameraSectionsOverlapping<T extends { startMs: number; endMs: number }>(
	rows: readonly T[],
	startMs: number,
	endMs: number,
): T[] {
	return rows.filter((r) => r.startMs < endMs && r.endMs > startMs);
}

/**
 * The `camera-full` rows of camera 1 that a hand-written `cameraLayoutRegions` list may
 * still carry. The editor never writes them; the scene turns them into Full Camera regions.
 */
export function fullCameraRowsOfLayoutList(raw: unknown): AnchoredCameraLayoutRegion[] {
	return normalizeAll(raw).filter(isFullCameraLayout);
}

function normalizeCrop(raw: unknown): CropRegion | undefined {
	if (!isRecord(raw)) return undefined;
	const { x, y, width, height } = raw;
	if (
		!inRange(x, 0, 1) ||
		!inRange(y, 0, 1) ||
		!inRange(width, 0, 1) ||
		!inRange(height, 0, 1) ||
		width <= 0 ||
		height <= 0
	) {
		return undefined;
	}
	return { x, y, width, height };
}

function normalizePerspective(raw: unknown): CameraPerspective | undefined {
	if (!isRecord(raw) || !Array.isArray(raw.corners) || raw.corners.length !== 4) return undefined;
	const corners: { x: number; y: number }[] = [];
	for (const c of raw.corners) {
		if (!isRecord(c) || !inRange(c.x, RECT_MIN, RECT_MAX) || !inRange(c.y, RECT_MIN, RECT_MAX)) {
			return undefined;
		}
		corners.push({ x: c.x, y: c.y });
	}
	if (!inRange(raw.aspect, 0.1, 10)) return undefined;
	const perspective: CameraPerspective = {
		corners: corners as CameraPerspective["corners"],
		aspect: raw.aspect,
	};
	if (typeof raw.margin === "number" && Number.isFinite(raw.margin)) {
		perspective.margin = Math.min(MAX_MARGIN, Math.max(0, raw.margin));
	}
	return perspective;
}

function normalizeOneCameraSettings(raw: unknown): CameraSettings | null {
	if (!isRecord(raw)) return null;
	const settings: CameraSettings = {};
	const rotation = normalizeCameraRotation(raw.rotation);
	if (rotation !== 0) settings.rotation = rotation;
	if (typeof raw.mirror === "boolean") settings.mirror = raw.mirror;
	const crop = normalizeCrop(raw.crop);
	if (crop) settings.crop = crop;
	const perspective = normalizePerspective(raw.perspective);
	if (perspective) settings.perspective = perspective;
	return settings;
}

/** Per-camera settings, index = camera (0 = camera 1); at most `MAX_CAMERAS` entries. */
export function normalizeCameraSettings(raw: unknown): (CameraSettings | null)[] {
	if (!Array.isArray(raw)) return [];
	return raw.slice(0, MAX_CAMERAS).map(normalizeOneCameraSettings);
}

/**
 * `legacyEditor.cameraSettings` after a change to one camera. `patch: null` resets the camera;
 * a key set to `undefined` removes it. Defaults (rotation 0, mirror off) are not stored, and
 * the main camera (`mainCamera`, camera 1 by default) keeps only `perspective` -- its other
 * settings are the layout pane's older fields. Any other camera, camera 1 included while it is
 * not the main one, keeps its own rotation, mirror and crop here.
 * Returns `undefined` when nothing is left to store (the key is then deleted).
 */
export function patchCameraSettings(
	raw: unknown,
	index: number,
	patch: Partial<CameraSettings> | null,
	mainCamera = 0,
): (CameraSettings | null)[] | undefined {
	if (!Number.isInteger(index) || index < 0 || index >= MAX_CAMERAS) {
		return normalizeCameraSettings(raw).length > 0 ? normalizeCameraSettings(raw) : undefined;
	}
	const list = normalizeCameraSettings(raw);
	while (list.length <= index) list.push(null);
	let merged: CameraSettings = {};
	if (patch !== null) {
		merged = { ...(list[index] ?? {}) };
		for (const key of Object.keys(patch) as (keyof CameraSettings)[]) {
			if (index === mainCamera && key !== "perspective") continue;
			if (patch[key] === undefined) delete merged[key];
			else Object.assign(merged, { [key]: patch[key] });
		}
		if (merged.rotation === 0) delete merged.rotation;
		if (merged.mirror === false) delete merged.mirror;
	}
	list[index] = Object.keys(merged).length > 0 ? merged : null;
	while (list.length > 0 && list[list.length - 1] === null) list.pop();
	return list.length > 0 ? list : undefined;
}
