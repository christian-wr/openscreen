// Where each copyable region kind lives, so copy and paste never guess: an unsupported kind
// maps to `null` instead of falling through into another kind's list.

import type { RegionSnapshot } from "./regionClipboard";

export type RegionKindName = RegionSnapshot["kind"];

/** The `useTimeline` array a selected pill of this kind is copied from. */
export type CopySourceKey =
	| "zoomRegions"
	| "annotationRegions"
	| "speedRegions"
	| "cameraFullscreenRegions"
	| "cameraLayoutRegions";

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
		case "trim":
		case "audio":
			return null;
	}
}

/** Where a pasted region is appended: a top-level document array, or a legacyEditor list. */
export type PasteTarget =
	| { store: "document"; key: "zoomRanges" | "annotations" }
	| {
			store: "legacy";
			key: "speedRegions" | "cameraFullscreenRegions" | "cameraLayoutRegions";
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
