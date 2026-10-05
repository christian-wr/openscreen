import { TRANSITION_WINDOW_MS } from "@/lib/zoomMath/constants";

/** Mirror of `DESK_COVER_FADE_S` (crates/compositor/src/regions.rs). */
export const DESK_COVER_FADE_MS = 500;
/** Above captions (`CAPTION_Z_INDEX_BASE` = 100_000), so the label sits on top. */
export const DESK_LABEL_Z_INDEX = 200_000;
const LEAD_OUT_WINDOW_MS = TRANSITION_WINDOW_MS * 1.5;

/**
 * Where a turned section's label shows, in timeline ms: over the hold plus the fade at each
 * end — the same windows `camera_fullscreen_cover_at` covers, shortened the same way for a
 * short section (each hold gets at most half; the fades share what is left). Speed regions are
 * not applied here: the label runs on source time like every annotation.
 *
 * `seams`: the ends that meet a camera layout region. That side has no grow or shrink to hold
 * over, so its window is only the fade (`full_camera_seams` in regions.rs).
 */
export function deskCoverLabelWindows(
	region: { startMs: number; endMs: number },
	seams: { start?: boolean; end?: boolean } = {},
): {
	start: [number, number];
	end: [number, number];
} {
	const len = region.endMs - region.startMs;
	const half = len / 2;
	const holdIn = seams.start ? 0 : Math.min(TRANSITION_WINDOW_MS, half);
	const holdOut = seams.end ? 0 : Math.min(LEAD_OUT_WINDOW_MS, half);
	const steady = Math.max(len - holdIn - holdOut, 0);
	const fade = Math.min(DESK_COVER_FADE_MS, steady / 2);
	return {
		start: [region.startMs, region.startMs + holdIn + fade],
		end: [region.endMs - holdOut - fade, region.endMs],
	};
}
