// Where each copyable region kind lives, so copy and paste never guess: an unsupported kind
// maps to `null` instead of falling through into another kind's list.

import { cameraSectionsOverlapping } from "@/lib/cameraLayouts";
import type { RegionSnapshot } from "./regionClipboard";

export type RegionKindName = RegionSnapshot["kind"];

/** The `useTimeline` array a selected pill of this kind is copied from. */
export type CopySourceKey =
	| "zoomRegions"
	| "annotationRegions"
	| "speedRegions"
	| "cameraFullscreenRegions"
	| "cameraLayoutRegions"
	| "deskRegions";

export function copySourceKey(kind: RegionKindName): CopySourceKey | null {
	switch (kind) {
		case "zoom":
			return "zoomRegions";
		case "annotation":
			return "annotationRegions";
		case "speed":
			return "speedRegions";
		case "cameraFullscreen":
			return "cameraFullscreenRegions";
		case "cameraLayout":
			return "cameraLayoutRegions";
		case "desk":
			return "deskRegions";
		case "trim":
		case "audio":
			return null;
	}
}

/** The three lists of camera sections, which never overlap one another. */
type CameraSectionKey = "cameraFullscreenRegions" | "cameraLayoutRegions" | "deskRegions";

/** Where a pasted region is appended: a top-level document array, or a legacyEditor list. */
export type PasteTarget =
	| { store: "document"; key: "zoomRanges" | "annotations" }
	| {
			store: "legacy";
			key: "speedRegions" | CameraSectionKey;
	  };

export function pasteTarget(kind: RegionKindName): PasteTarget | null {
	switch (kind) {
		case "zoom":
			return { store: "document", key: "zoomRanges" };
		case "annotation":
			return { store: "document", key: "annotations" };
		case "speed":
			return { store: "legacy", key: "speedRegions" };
		case "cameraFullscreen":
			return { store: "legacy", key: "cameraFullscreenRegions" };
		case "cameraLayout":
			return { store: "legacy", key: "cameraLayoutRegions" };
		case "desk":
			return { store: "legacy", key: "deskRegions" };
		case "trim":
		case "audio":
			return null;
	}
}

/** The id prefix for a pasted row of this kind. */
export function pasteIdPrefix(kind: RegionKindName): string {
	if (kind === "annotation") return "ann";
	if (kind === "cameraLayout") return "camlayout";
	return kind;
}

type Span = Array<{ startMs: number; endMs: number }>;

/**
 * Whether a pasted camera section lands on one it may not share the timeline with. Full Camera,
 * layout and desk sections never overlap, so a paste is refused over any of the three lists,
 * with one exception: a Full Camera paste over another Full Camera merges, as an add does.
 */
export function pasteHitsCameraSection(
	legacy: Record<string, unknown>,
	key: CameraSectionKey,
	startMs: number,
	endMs: number,
): boolean {
	const rows = [
		...((legacy.cameraLayoutRegions as Span | undefined) ?? []),
		...((legacy.deskRegions as Span | undefined) ?? []),
		...(key !== "cameraFullscreenRegions"
			? ((legacy.cameraFullscreenRegions as Span | undefined) ?? [])
			: []),
	];
	return cameraSectionsOverlapping(rows, startMs, endMs).length > 0;
}
