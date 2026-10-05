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

function normalizeRegion(raw: unknown): CameraLayoutRegion | null {
	if (!isRecord(raw) || !isTemplate(raw.template)) return null;
	const { id, startMs, endMs } = raw;
	if (typeof id !== "string") return null;
	if (typeof startMs !== "number" || typeof endMs !== "number") return null;
	if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs >= endMs) return null;
	const template = raw.template;
	const slots = normalizeSlots(raw.slots, template);
	if (slots.length < TEMPLATE_SLOTS[template].min) return null;
	const region: CameraLayoutRegion = { id, startMs, endMs, template, slots };
	if (template === "camera-full") {
		const rotation = normalizeCameraRotation(raw.rotation);
		const mirror = normalizeCameraMirror(raw.mirror);
		if (rotation !== 0) region.rotation = rotation;
		if (mirror !== "auto") region.mirror = mirror;
		if (raw.deskLabel === false) region.deskLabel = false;
	}
	return region;
}

/** Reads stored layout regions defensively: invalid ones are dropped, overlaps resolved. */
export function normalizeCameraLayoutRegions(raw: unknown): CameraLayoutRegion[] {
	if (!Array.isArray(raw)) return [];
	const regions = raw
		.map(normalizeRegion)
		.filter((r): r is CameraLayoutRegion => r !== null)
		.sort((a, b) => a.startMs - b.startMs);
	const kept: CameraLayoutRegion[] = [];
	for (const region of regions) {
		const last = kept[kept.length - 1];
		if (last && region.startMs < last.endMs) continue;
		kept.push(region);
	}
	return kept;
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
