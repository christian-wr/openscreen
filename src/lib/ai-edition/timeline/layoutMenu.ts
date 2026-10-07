// Rules behind the timeline's "Add layout" menu: which templates are offered, which are
// disabled (and why), and which cameras a new section starts with.

import type { CameraLayoutTemplate } from "@/components/video-editor/types";
import { TEMPLATE_SLOTS } from "@/lib/cameraLayouts";
import { sceneCameraIndex } from "@/lib/mainCamera";
import type { AxcutAsset, AxcutClip } from "../schema";
import { type ProjectCamera, projectCameras } from "./cameraList";
import { locateVirtualPosition } from "./virtual-preview";

export const LAYOUT_TEMPLATES: readonly CameraLayoutTemplate[] = [
	"screen-pip",
	"camera-full",
	"camera-full-pip",
	"side-by-side",
];

/** Templates that place a picture-in-picture bubble over something. */
const PIP_TEMPLATES: ReadonlySet<CameraLayoutTemplate> = new Set(["screen-pip", "camera-full-pip"]);

export type LayoutTemplateBlock = "block-layout" | "needs-cameras";

/**
 * Why a template cannot be added right now, or `null` when it can. The block layout presets
 * (dual-frame, vertical-stack) own the camera placement, so PiP templates are off there.
 */
export function layoutTemplateBlock(
	template: CameraLayoutTemplate,
	ctx: { cameraCount: number; blockPreset: boolean },
): LayoutTemplateBlock | null {
	if (ctx.blockPreset && PIP_TEMPLATES.has(template)) return "block-layout";
	if (ctx.cameraCount < TEMPLATE_SLOTS[template].min) return "needs-cameras";
	return null;
}

/** The project's camera roles: the main camera (the face) and the resolved desk camera. */
export interface LayoutCameraRoles {
	main: number;
	desk: number | null;
}

/**
 * The cameras a new section of `template` starts with, from the available camera indexes of
 * the clip under the playhead, seeded from the camera roles: Screen + camera and camera-full
 * start with the main camera; camera-full-pip with the desk camera large and the main camera
 * small; side-by-side with the main camera, then the desk camera or another one. Without a
 * desk camera, camera-full-pip keeps its older rule with the main camera in camera 1's role
 * (camera 2 large, the main camera small). A role whose camera the clip does not have falls
 * back to the first `min` available cameras.
 */
export function defaultLayoutCameras(
	template: CameraLayoutTemplate,
	available: readonly number[],
	roles: LayoutCameraRoles = { main: 0, desk: null },
): number[] {
	const { min } = TEMPLATE_SLOTS[template];
	const { main } = roles;
	const fallback = available.slice(0, min);
	if (!available.includes(main)) return fallback;
	const desk =
		roles.desk !== null && roles.desk !== main && available.includes(roles.desk)
			? roles.desk
			: null;
	if (template === "screen-pip" || template === "camera-full") return [main];
	if (template === "camera-full-pip") {
		if (desk !== null) return [desk, main];
		const second = sceneCameraIndex(1, main);
		return available.includes(second) ? [second, main] : fallback;
	}
	const other = desk ?? available.find((camera) => camera !== main);
	return other === undefined ? fallback : [main, other];
}

/**
 * The cameras the "Add layout" menu judges its templates by: those of the clip under the
 * playhead, even when it has none (a section anchored on a screen-only clip would reference
 * cameras its asset lacks). Only with no clip under the playhead (past every clip) does the
 * menu fall back to the nearest clip that has cameras.
 */
export function camerasForLayoutMenu(
	clips: AxcutClip[],
	assets: AxcutAsset[],
	timelineSec: number,
	t: (key: string, vars?: Record<string, string | number>) => string,
): ProjectCamera[] {
	const availableOf = (clip: AxcutClip) =>
		projectCameras(
			assets.find((a) => a.id === clip.assetId),
			t,
		).filter((c) => c.available);
	// `locateVirtualPosition` clamps to the nearest clip; "under" means the playhead is
	// really inside it (its end included, for the playhead parked at the timeline's end).
	const located = locateVirtualPosition(clips, timelineSec)?.clip;
	const under =
		located && timelineSec >= located.timelineStartSec && timelineSec <= located.timelineEndSec
			? located
			: null;
	if (under) return availableOf(under);
	const distance = (clip: AxcutClip) =>
		Math.max(clip.timelineStartSec - timelineSec, timelineSec - clip.timelineEndSec, 0);
	let best: { cameras: ProjectCamera[]; distance: number } | null = null;
	for (const clip of clips) {
		const cameras = availableOf(clip);
		if (cameras.length === 0) continue;
		const d = distance(clip);
		if (!best || d < best.distance) best = { cameras, distance: d };
	}
	return best?.cameras ?? [];
}
