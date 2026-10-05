// Rules behind the timeline's "Add layout" menu: which templates are offered, which are
// disabled (and why), and which cameras a new section starts with.

import type { CameraLayoutTemplate } from "@/components/video-editor/types";
import { TEMPLATE_SLOTS } from "@/lib/cameraLayouts";

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

/**
 * The cameras a new section of `template` starts with, from the available camera indexes of
 * the clip under the playhead: the first `min` of them. `camera-full-pip` puts the desk
 * camera (camera 2) first when there is one.
 */
export function defaultLayoutCameras(
	template: CameraLayoutTemplate,
	available: readonly number[],
): number[] {
	const { min } = TEMPLATE_SLOTS[template];
	if (template === "camera-full-pip" && available.includes(1) && available.includes(0)) {
		return [1, 0];
	}
	return available.slice(0, min);
}
