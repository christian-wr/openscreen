import { describe, expect, it } from "vitest";
import { type AxcutAsset, type AxcutDocument, axcutSchemaVersion } from "@/lib/ai-edition/schema";
import { buildNativeClipList } from "./CliExportRunner";

function doc(asset: AxcutAsset): AxcutDocument {
	return {
		schemaVersion: axcutSchemaVersion,
		project: {
			id: "proj_1",
			title: "Cli",
			createdAt: "2026-10-05T10:00:00Z",
			updatedAt: "2026-10-05T10:00:00Z",
			primaryAssetId: asset.id,
		},
		assets: [asset],
		transcript: null,
		transcripts: [],
		timeline: {
			clips: [
				{
					id: "c1",
					assetId: asset.id,
					sourceStartSec: 0,
					sourceEndSec: 10,
					timelineStartSec: 0,
					timelineEndSec: 10,
					wordRefs: [],
					origin: "user",
					reason: "",
				},
			],
			gaps: [],
			trimRanges: [],
			muteRanges: [],
			speedRanges: [],
			captionRanges: [],
		},
		annotations: [],
		zoomRanges: [],
		audioTracks: [],
		legacyEditor: null,
	};
}

const ASSET: AxcutAsset = {
	id: "a1",
	kind: "video",
	label: "asset",
	originalPath: "/tmp/a.mp4",
	cameraTrack: null,
};

describe("CLI export clip list", () => {
	it("carries the asset's extra cameras", () => {
		const clips = buildNativeClipList(
			doc({
				...ASSET,
				additionalCameraTracks: [
					{ sourcePath: "/tmp/cam2.mp4", startMs: 1000, offsetMs: -250, visible: true, label: "" },
				],
			}),
		);
		expect(clips).toHaveLength(1);
		expect(clips[0].additionalCameras).toEqual([{ path: "/tmp/cam2.mp4", offsetSec: 0.75 }]);
	});

	it("sends no extra cameras for a one-camera asset", () => {
		const clips = buildNativeClipList(doc(ASSET));
		expect(clips[0]).not.toHaveProperty("additionalCameras");
	});
});
