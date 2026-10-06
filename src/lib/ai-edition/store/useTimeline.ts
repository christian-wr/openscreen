// Hook: region mutations for the new editor shell. Wraps the project store
// with typed add/remove/select operations for zoom, trim, annotation, and
// speed regions. Each add creates a 2-second region at the current playhead
// (a reasonable default for the user to then resize).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { toFileUrl } from "@/components/video-editor/projectPersistence";
import type {
	AnnotationRegion,
	AnnotationType,
	CameraFullscreenRegion,
	CameraLayoutSlot,
	CameraLayoutTemplate,
	CameraSettings,
	NormalizedRect,
	Rotation3DPreset,
} from "@/components/video-editor/types";
import { useScopedT } from "@/contexts/I18nContext";
import {
	type AnchoredCameraLayoutRegion,
	cameraSectionsOverlapping,
	isFullCameraLayout,
	MAX_CAMERAS,
	normalizeCameraLayoutRegions,
	normalizeCameraSettings,
	patchCameraSettings,
	TEMPLATE_SLOTS,
} from "@/lib/cameraLayouts";
import {
	type CameraMirrorMode,
	type CameraRotation,
	normalizeCameraMirror,
	normalizeCameraRotation,
} from "@/lib/cameraOrientation";
import {
	type AnchoredDeskRegion,
	normalizeDeskRegions,
	resolveDeskCamera,
} from "@/lib/deskSections";
import { DEFAULT_TEXT_PLATE } from "../annotations/background";
import { fitTextBox } from "../annotations/placement";
import {
	collapseTracksToPills,
	patchAudioTrack,
	placeAudioTrackInDocument,
	removeAudioTrack as removeAudioTrackInDocument,
	trackGroupId,
} from "../document/audioTracks";
import { createId } from "../document/ids";
import { resolveAspectRatioValue } from "../document/outputFormat";
import {
	clearEditRegions,
	countEditRegions,
	duplicateClip as duplicateClipInDocument,
	moveClip as moveClipInDocument,
	PLACEHOLDER_DURATION_SEC,
	type RegionKind,
	readSpeedRegions,
	removeClip as removeClipInDocument,
	removeRegion as removeRegionInDocument,
	resequenceClips,
	setClipSourceRange,
	withClipsChanged,
} from "../document/timeline";
import type { AxcutAudioTrack, AxcutClipCropRegion, AxcutDocument } from "../schema";
import { appendAutoZoomSuggestions } from "../timeline/apply-auto-zooms";
import { hasAnyClipWithCamera } from "../timeline/camera";
import { projectCameraAvailable, projectCameraCount } from "../timeline/cameraList";
import { probeAudioDuration, probeVideoDimensions, probeVideoDuration } from "../timeline/duration";
import {
	anchorRegionsWithDerivedMs,
	clampSpanAgainstNeighbours,
	coalesceRegionsForRuler,
	dropPillsByIds,
	replacePillSpan,
	resolvePillIds,
} from "../timeline/timelineMap";
import { dropTrimPillsByIds, resolveTimelineSpanToTrim } from "../timeline/trim-mapping";
import { MAX_ZOOM_SCALE, MIN_ZOOM_SCALE } from "../timeline/zoom-scale";
import type { AutoZoomSuggestion } from "../timeline/zoom-suggestions";
import { getEditorSettings } from "./editorSettings";
import { saveWithDeadline, useProjectStore, waitForDocumentSaves } from "./projectStore";
import { currentWriteEpoch } from "./undoStack";
import { useSequentialTimelineOps } from "./useSequentialTimelineOps";

// How long a region lasts when the caller doesn't say. The timeline's toolbar
// passes its own duration instead, derived from the current zoom so the new pill
// always comes out the same WIDTH on screen (see PILL_CREATE_PX in V4Timeline).
// Every other entry point — keyboard shortcuts, the agent, auto-zooms — gets
// these 2 s, which is what all five add* used to hardcode.
const DEFAULT_NEW_REGION_SEC = 2;

// NaN-guarded floors. Timeline inputs arrive from drag deltas and persisted
// documents, both of which can carry NaN; every action needs the same guard.
const finiteSec = (n: number) => (Number.isFinite(n) ? Math.max(0, n) : 0);
const finiteMs = (n: number) => (Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0);
const finiteFraction = (n: number) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0.5);

// Placeholder duration applied to a freshly-inserted clip whose source asset hasn't
// reported its real duration yet (media drag → drop before the preview video fires
// `loadedmetadata`). `applyProbedDuration` (document layer) swaps it — and the
// extent-less clip a legacy v2 import mints — for the real length once metadata
// arrives. Defined there, re-exported here so existing importers keep working and the
// value has exactly one definition.
export { PLACEHOLDER_DURATION_SEC };

interface RegionHandle {
	kind: RegionKind;
	id: string;
}

type Clip = AxcutDocument["timeline"]["clips"][number];

/**
 * Patch every region under the pill `id` belongs to. A payload edit must hit them all,
 * or the pieces of one pill would disagree — and then, by the merge rule, visibly split.
 */
function patchPillById<T extends { id: string; startMs: number; endMs: number }>(
	regions: T[],
	id: string,
	patch: Partial<T>,
): T[] {
	const under = new Set(resolvePillIds(regions, id));
	return regions.map((r) => (under.has(r.id) ? { ...r, ...patch } : r));
}

/**
 * The rows with the desk label of the pill `id` shown or hidden. Only `deskLabel: false` is
 * stored; showing the label again removes the field. Rows outside the pill keep their identity.
 */
function withDeskLabel<T extends { id: string; startMs: number; endMs: number; deskLabel?: false }>(
	rows: T[],
	id: string,
	show: boolean,
): T[] {
	// patchPillById copies exactly the pill's rows; untouched rows keep their identity.
	return patchPillById(rows, id, {}).map((r, i) => {
		if (r === rows[i]) return r;
		const { deskLabel: _d, ...rest } = r;
		return (show ? rest : { ...rest, deskLabel: false as const }) as T;
	});
}

// --- Camera sections ---------------------------------------------------------------
// Full Camera regions and layout sections share one timeline lane but live in two lists:
// a `camera-full` section of camera 1 is a Full Camera region, everything else a layout
// row (see `isFullCameraLayout`). Desk sections have a lane and a list of their own. The
// helpers below keep the three lists disjoint in time and move a section between the first
// two when its template changes.

/** The anchor and derived span every stored row of both lists carries. */
interface AnchoredRow {
	id: string;
	startMs: number;
	endMs: number;
	clipId?: string;
	assetId?: string;
	sourceStartSec?: number;
	sourceEndSec?: number;
}

type FullCameraRow = CameraFullscreenRegion & AnchoredRow;

/** A section on the shared camera lane, as the selection names it. */
export interface CameraSectionHandle {
	kind: "cameraFullscreen" | "cameraLayout";
	id: string;
}

/**
 * `too-few-cameras`: the project has a camera, but the template needs more than were given.
 * `no-desk-camera`: a desk section was asked for, but no desk camera resolves.
 * The same union as `CameraSectionOutcome` (cameraSectionNotice), which tells the user.
 */
export type AddCameraSectionOutcome =
	| "added"
	| "occupied"
	| "no-camera"
	| "too-few-cameras"
	| "no-desk-camera";

interface CameraLanes {
	legacy: Record<string, unknown>;
	full: FullCameraRow[];
	layout: AnchoredCameraLayoutRegion[];
	desk: AnchoredDeskRegion[];
}

function cameraLanes(doc: AxcutDocument): CameraLanes {
	const legacy = (doc.legacyEditor as Record<string, unknown>) ?? {};
	const full = (legacy.cameraFullscreenRegions as FullCameraRow[] | undefined) ?? [];
	const layout = (legacy.cameraLayoutRegions as AnchoredCameraLayoutRegion[] | undefined) ?? [];
	const desk = (legacy.deskRegions as AnchoredDeskRegion[] | undefined) ?? [];
	return { legacy, full, layout, desk };
}

function withCameraLanes(
	doc: AxcutDocument,
	lanes: CameraLanes,
	full: FullCameraRow[],
	layout: AnchoredCameraLayoutRegion[],
	desk: AnchoredDeskRegion[] = lanes.desk,
): AxcutDocument {
	// A list that was never stored and is still empty stays absent, so a project that never
	// used layout or desk sections keeps its legacy envelope unchanged.
	const keep = (key: string, rows: unknown[]) =>
		rows.length > 0 || key in lanes.legacy ? { [key]: rows } : {};
	return {
		...doc,
		legacyEditor: {
			...lanes.legacy,
			...keep("cameraFullscreenRegions", full),
			...keep("cameraLayoutRegions", layout),
			...keep("deskRegions", desk),
		},
	};
}

/** Whether the span `[startMs, endMs)` overlaps any row of the given lists. */
function cameraLaneOccupied(lists: AnchoredRow[][], startMs: number, endMs: number): boolean {
	return cameraSectionsOverlapping(lists.flat(), startMs, endMs).length > 0;
}

// An identity no stored region can have, so a pill of another list is always a wall.
const OTHER_CAMERA_LIST = "\u0000other-camera-list";

/**
 * The span the pill holding `id` may take: clamped against the other pills of its own list
 * (by the usual identity rule) and against every pill of the other camera-section lists.
 * `replacePillSpan` then applies the same-list clamp again, which is a no-op.
 */
function clampCameraSpan(
	own: AnchoredRow[],
	others: AnchoredRow[][],
	id: string,
	startMs: number,
	endMs: number,
): { startMs: number; endMs: number } {
	const pills = coalesceRegionsForRuler(own);
	const pill = pills.find((p) => p.ids.includes(id));
	if (!pill) return { startMs, endMs };
	const walls = [
		...pills
			.filter((p) => p !== pill)
			.map((p) => ({ id: p.ids[0], start: p.start, end: p.end, identity: p.identity })),
		...others.flatMap((other) =>
			coalesceRegionsForRuler(other).map((p) => ({
				id: p.ids[0],
				start: p.start,
				end: p.end,
				identity: OTHER_CAMERA_LIST,
			})),
		),
	];
	const clamped = clampSpanAgainstNeighbours(
		{ start: startMs / 1000, end: endMs / 1000 },
		pill.identity,
		walls,
	);
	return { startMs: Math.round(clamped.start * 1000), endMs: Math.round(clamped.end * 1000) };
}

/** Only the anchor and span of a row: what survives a move to the other list. */
function anchorOf(row: AnchoredRow, id: string): AnchoredRow {
	const out: AnchoredRow = { id, startMs: row.startMs, endMs: row.endMs };
	if (row.clipId !== undefined) out.clipId = row.clipId;
	if (row.assetId !== undefined) out.assetId = row.assetId;
	if (row.sourceStartSec !== undefined) out.sourceStartSec = row.sourceStartSec;
	if (row.sourceEndSec !== undefined) out.sourceEndSec = row.sourceEndSec;
	return out;
}

/**
 * The cameras of a section after a template change: its own cameras in order, then the
 * given ones it does not hold yet, cut to what the template places. `null` when the
 * template needs more cameras than that.
 */
function camerasForTemplate(
	template: CameraLayoutTemplate,
	current: number[],
	cameras: number[],
): number[] | null {
	const out: number[] = [];
	for (const camera of [...current, ...cameras]) {
		if (!Number.isInteger(camera) || camera < 0 || camera >= MAX_CAMERAS) continue;
		if (!out.includes(camera)) out.push(camera);
	}
	const { min, max } = TEMPLATE_SLOTS[template];
	const cut = out.slice(0, max);
	return cut.length >= min ? cut : null;
}

/**
 * Move the pill holding `id` from one list to the other, keeping every row's anchor and
 * span. `toRow` builds the new row; returns the new rows and the id the moved `id` became,
 * or `null` when no stored row has that id.
 */
function movePill<From extends AnchoredRow, To extends AnchoredRow>(
	from: From[],
	id: string,
	prefix: string,
	toRow: (anchor: AnchoredRow) => To,
): { remaining: From[]; moved: To[]; newId: string } | null {
	if (!from.some((r) => r.id === id)) return null;
	const under = new Set(resolvePillIds(from, id));
	let newId = id;
	const moved: To[] = [];
	for (const row of from) {
		if (!under.has(row.id)) continue;
		const rowId = createId(prefix);
		if (row.id === id) newId = rowId;
		moved.push(toRow(anchorOf(row, rowId)));
	}
	return { remaining: from.filter((r) => !under.has(r.id)), moved, newId };
}

/**
 * The document with the Full Camera pill `id` turned into a layout section with the given
 * template and places. The desk fields stay behind: desk view exists only on Full Camera.
 */
function fullCameraPillToLayout(
	doc: AxcutDocument,
	lanes: CameraLanes,
	id: string,
	template: CameraLayoutTemplate,
	slots: CameraLayoutSlot[],
): { doc: AxcutDocument; handle: CameraSectionHandle } | null {
	const move = movePill(
		lanes.full,
		id,
		"camlayout",
		(anchor): AnchoredCameraLayoutRegion => ({ ...anchor, template, slots }),
	);
	if (!move) return null;
	return {
		doc: withCameraLanes(doc, lanes, move.remaining, [...lanes.layout, ...move.moved]),
		handle: { kind: "cameraLayout", id: move.newId },
	};
}

/** The document with the layout pill `id` turned into a Full Camera region of camera 1. */
function layoutPillToFullCamera(
	doc: AxcutDocument,
	lanes: CameraLanes,
	id: string,
): { doc: AxcutDocument; handle: CameraSectionHandle } | null {
	const move = movePill(lanes.layout, id, "camfull", (anchor): FullCameraRow => anchor);
	if (!move) return null;
	return {
		doc: withCameraLanes(doc, lanes, [...lanes.full, ...move.moved], move.remaining),
		handle: { kind: "cameraFullscreen", id: move.newId },
	};
}

/** The desk camera the user chose (`legacyEditor.deskCamera`), or `null` when none is stored. */
function chosenDeskCamera(legacy: Record<string, unknown>): number | null {
	const value = legacy.deskCamera;
	return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

/** The project's desk camera as `resolveDeskCamera` settles it (0 = camera 1), or `null`. */
function deskCameraOf(doc: AxcutDocument): number | null {
	const legacy = (doc.legacyEditor as Record<string, unknown> | null) ?? {};
	return resolveDeskCamera({
		deskCamera: legacy.deskCamera,
		cameraCount: projectCameraCount(doc.assets),
		cameraSettings: normalizeCameraSettings(legacy.cameraSettings).map((s) => s ?? {}),
		available: (index) => projectCameraAvailable(doc.assets, index),
	});
}

/**
 * Playhead position at CALL time, read imperatively — deliberately not a
 * subscription.
 *
 * `currentTimeSec` is rewritten on every animation frame during playback (see
 * VirtualPreview's rAF tick). Subscribing to it here would give this hook's
 * return value a new identity 60×/s and re-render every consumer with it — and
 * `useTimeline()` is called by the editor shell, so that meant re-rendering the
 * whole editor (timeline, clips, waveforms, inspector) once per frame just to
 * move the playhead a few pixels. That render cascade was the playhead's own
 * stutter: React had to commit the entire tree before the playhead's DOM moved.
 *
 * Nothing in this hook RENDERS the playhead — the add* actions below only need
 * its value at the instant the user fires them, which is exactly what a
 * getState() read gives (and is strictly fresher than a captured render value).
 */
function playheadSec(): number {
	return useProjectStore.getState().currentTimeSec;
}

export function useTimeline() {
	const ts = useScopedT("settings");
	const document = useProjectStore((s) => s.document);
	const projectId = useProjectStore((s) => s.projectId);
	const saveDocument = useProjectStore((s) => s.saveDocument);
	const setDocument = useProjectStore((s) => s.setDocument);
	const [selection, setSelection] = useState<RegionHandle | null>(null);
	// F2.7 — shift-click multi-selection. `selection` stays the inspector's
	// focused region (the last one clicked); `multiSelection` is the full set
	// the Delete key operates on.
	const [multiSelection, setMultiSelection] = useState<RegionHandle[]>([]);
	const [clipSelection, setClipSelection] = useState<string | null>(null);
	// The selected imported audio track (issue #350) lives in the project store —
	// not here — because the media panel and the inspector, in different subtrees,
	// both touch it (see projectStore). It shares "this is the thing I mean"
	// exclusivity with the region/clip selection above, so the selects below clear
	// it and it clears them, but it carries none of the region delete/anchor logic.
	const selectedAudioTrackId = useProjectStore((s) => s.selectedAudioTrackId);
	const setSelectedAudioTrackId = useProjectStore((s) => s.setSelectedAudioTrackId);
	const storeAddAudioTrack = useProjectStore((s) => s.addAudioTrack);
	const importAudioAsset = useProjectStore((s) => s.importAudioAsset);
	// Pre-drag snapshots for the two optimistic paths (zoom focus, annotations), so a
	// failed commit can put the document back instead of leaving an edit on screen that
	// was never written.
	const zoomFocusRollbackRef = useRef<AxcutDocument | null>(null);
	const zoomFocusLiveRef = useRef<AxcutDocument | null>(null);
	// And the focus drag's last value, which its commit puts back if a zoom write lands over it,
	// with the write epoch it was made in.
	const zoomFocusEditRef = useRef<{
		id: string;
		focus: { cx: number; cy: number };
		epoch: number;
	} | null>(null);
	const annotationRollbackRef = useRef<AxcutDocument | null>(null);
	const annotationLiveRef = useRef<AxcutDocument | null>(null);
	// The same pair for dragging a place of a layout section.
	const layoutRectRollbackRef = useRef<AxcutDocument | null>(null);
	const layoutRectLiveRef = useRef<AxcutDocument | null>(null);

	// A drag does not always end in a commit: `ZoomFocusOverlay` unmounts the moment
	// `focusMode` flips to "auto", so `endDrag` never runs and the snapshot outlives the
	// project. Left alone, resetting focus in project B and failing that save restored
	// project A's document into B -- the next successful save then wrote A over B. It
	// also pinned two whole documents per hook instance, and annotations can carry
	// base64 image data URLs.
	// biome-ignore lint/correctness/useExhaustiveDependencies: projectId is the trigger, not a read — the body only clears refs.
	useEffect(() => {
		zoomFocusRollbackRef.current = null;
		zoomFocusLiveRef.current = null;
		zoomFocusEditRef.current = null;
		annotationRollbackRef.current = null;
		annotationLiveRef.current = null;
		layoutRectRollbackRef.current = null;
		layoutRectLiveRef.current = null;
	}, [projectId]);

	const hasDoc = document !== null && projectId !== null;

	// Clear a stale audio-track selection. `removeAudioTrack` clears it on an explicit
	// delete, but an undo (or any document swap) can drop the selected track WITHOUT
	// going through that op — and then `selectedAudioTrackId` points at nothing while the
	// inspector stays open on an empty AudioTrackPane, recoverable only by clicking a facet.
	useEffect(() => {
		if (selectedAudioTrackId === null) return;
		if (!document?.audioTracks.some((t) => trackGroupId(t) === selectedAudioTrackId)) {
			setSelectedAudioTrackId(null);
		}
	}, [document, selectedAudioTrackId, setSelectedAudioTrackId]);

	// Backfill missing source dimensions for any USED asset whose `video` was never probed.
	// `probeAndCorrectClip` only populates dims on INSERT, gated on a null duration, so an asset
	// saved with a duration but no dims (e.g. a project migrated from before dims were probed
	// alongside duration) never gets re-probed — opening it triggers no insert. `asset.video` is
	// the single source of truth for a clip's real shape/size: the ratio picker's ORIGINAL list
	// (collectNativeFormats), the output resolution (referenceClipDims) and the export badges all
	// read it, so an unpopulated one silently drops that clip from ALL of them — which is why a
	// cropped clip could show under ORIGINAL while an un-probed 16:9 sibling was missing entirely.
	// Probe once on load and persist via saveDocument with `history: false` (a write the user
	// never made must not be what the next Ctrl+Z reverses), so the fix sticks and every consumer
	// agrees without each re-probing on its own (what the export dialog used to do). Attempt each
	// asset at most once per session, even on failure, so a file that can't be probed doesn't
	// spin the effect on every document change.
	const probedAssetIdsRef = useRef<Set<string>>(new Set());
	useEffect(() => {
		if (!document) return;
		const usedAssetIds = new Set(document.timeline.clips.map((c) => c.assetId));
		type Asset = (typeof document.assets)[number];
		const needsScreen = (a: Asset) =>
			Boolean(a.originalPath) && (!a.video || !a.video.width || !a.video.height);
		// The camera is backfilled the same way and for the same reason. The PiP's layout
		// box is derived from these dimensions, so an asset that never carried them was
		// laid out from a hardcoded 4:3 — and differently depending on who was asking: the
		// preview had a mounted <video> reporting the real size, an export had nothing, so
		// a 16:9 camera came out framed one way on screen and another in the file.
		const needsCamera = (a: Asset) =>
			Boolean(a.cameraTrack?.sourcePath) && (!a.cameraTrack?.width || !a.cameraTrack?.height);
		const missing = document.assets.filter(
			(a) =>
				usedAssetIds.has(a.id) &&
				(needsScreen(a) || needsCamera(a)) &&
				!probedAssetIdsRef.current.has(a.id),
		);
		if (missing.length === 0) return;
		// No cleanup cancels this. The effect re-runs on EVERY document change, and a fresh
		// recording changes it several times while the probe is out (placeholder seed,
		// measured duration, camera link, auto-zoom). A cancel dropped the result while the
		// asset was already marked attempted, so nothing ever probed it again that session and
		// the take was exported with no dims. The write below re-reads the store instead, and
		// the project check is the only staleness that matters.
		const originatingProjectId = document.project.id;
		void (async () => {
			type Dims = { width: number; height: number };
			const probed: Record<string, { video?: Dims; camera?: Dims }> = {};
			for (const a of missing) {
				probedAssetIdsRef.current.add(a.id);
				const entry: { video?: Dims; camera?: Dims } = {};
				if (needsScreen(a)) {
					const dims = await probeVideoDimensions(toFileUrl(a.originalPath));
					if (dims) entry.video = dims;
				}
				// Probed independently of the screen: one file being unreadable must not cost
				// the other its dimensions, and a camera-less asset simply skips this.
				if (a.cameraTrack && needsCamera(a)) {
					const dims = await probeVideoDimensions(toFileUrl(a.cameraTrack.sourcePath));
					if (dims) entry.camera = dims;
				}
				if (entry.video || entry.camera) probed[a.id] = entry;
			}
			if (Object.keys(probed).length === 0) return;
			// The store only takes a document once its save returns, so a write still in flight
			// (the fresh-recording auto-zooms, typically) is invisible here. Building on the store
			// before it lands and saving after it would erase it. Wait it out; on a timeout,
			// write nothing and let a later run probe again.
			if ((await waitForDocumentSaves()) === "timeout") {
				for (const id of Object.keys(probed)) probedAssetIdsRef.current.delete(id);
				return;
			}
			// Re-read fresh state so a concurrent edit made while probing isn't stomped.
			const current = useProjectStore.getState().document;
			if (!current || current.project.id !== originatingProjectId) return;
			// `history: false` — see the comment above: a backfill nobody asked for must
			// not become the thing the next Ctrl+Z reverses.
			await useProjectStore.getState().saveDocument(
				{
					...current,
					assets: current.assets.map((a) => {
						const found = probed[a.id];
						if (!found) return a;
						return {
							...a,
							...(found.video
								? { video: { codec: "unknown", fps: 0, ...a.video, ...found.video } }
								: {}),
							...(found.camera && a.cameraTrack
								? { cameraTrack: { ...a.cameraTrack, ...found.camera } }
								: {}),
						};
					}),
				},
				{ history: false },
			);
		})();
	}, [document]);

	// Backfill the real duration of imported audio assets (issue #350), the audio
	// counterpart of the dimension backfill above. `addAudioAsset` probes once at
	// import; a transient failure (timeout, a file still being written) would
	// otherwise leave `durationSec` at 0 forever, and a 0-length window is a track
	// that never plays and a pill with no width. Re-probe on load — once per asset
	// per session, success or not — and stamp both the asset AND every track that
	// caches its duration, with `history: false` so the fix is not an undo step.
	const probedAudioAssetIdsRef = useRef<Set<string>>(new Set());
	useEffect(() => {
		if (!document) return;
		const usedAssetIds = new Set(document.audioTracks.map((t) => t.assetId));
		const missing = document.assets.filter(
			(a) =>
				a.kind === "audio" &&
				a.originalPath &&
				usedAssetIds.has(a.id) &&
				!(a.durationSec && a.durationSec > 0) &&
				!probedAudioAssetIdsRef.current.has(a.id),
		);
		if (missing.length === 0) return;
		// Mark every candidate BEFORE the first await. Marking each only as its turn
		// came meant a document change that re-entered this effect while asset #1 was
		// still awaiting found #2+ unmarked and probed them a second time.
		for (const a of missing) probedAudioAssetIdsRef.current.add(a.id);
		let cancelled = false;
		void (async () => {
			const probed: Record<string, number> = {};
			for (const a of missing) {
				const durationSec = await probeAudioDuration(toFileUrl(a.originalPath));
				if (durationSec != null && durationSec > 0) probed[a.id] = durationSec;
			}
			if (cancelled || Object.keys(probed).length === 0) return;
			const current = useProjectStore.getState().document;
			if (!current) return;
			await useProjectStore.getState().saveDocument(
				{
					...current,
					assets: current.assets.map((a) =>
						probed[a.id] ? { ...a, durationSec: probed[a.id] } : a,
					),
					audioTracks: current.audioTracks.map((t) =>
						probed[t.assetId] && !(t.durationSec > 0)
							? { ...t, durationSec: probed[t.assetId] }
							: t,
					),
				},
				{ history: false },
			);
		})();
		return () => {
			cancelled = true;
		};
	}, [document]);

	// Every add* below anchors the new region to the clip(s) it covers before storing it.
	// A modifier MUST own a clip anchor to survive reorder/trim (see
	// technical-documentation/architecture/timeline-model.md) — writing only startMs/endMs
	// would strand it. A region created across a clip boundary becomes one fragment per
	// clip; the ruler renders them as one pill because their properties are equal.
	const addZoom = useCallback(
		async (durationSec = DEFAULT_NEW_REGION_SEC) => {
			if (!document) return;
			const timeMs = Math.round(playheadSec() * 1000);
			const endMs = timeMs + Math.round(durationSec * 1000);
			const anchored = anchorRegionsWithDerivedMs(
				[
					{
						id: createId("zoom"),
						startMs: timeMs,
						endMs,
						depth: 3,
						// Auto: a zoom added with Z frames what the pointer is doing, like the ones
						// placed at import. The centre is its fallback where no pointer was recorded.
						focus: { cx: 0.5, cy: 0.5 },
						focusMode: "auto" as const,
					},
				],
				document.timeline.clips,
				() => createId("zoom"),
			);
			const next: AxcutDocument = {
				...document,
				zoomRanges: [...document.zoomRanges, ...anchored] as AxcutDocument["zoomRanges"],
			};
			await saveDocument(next, { history: true });
		},
		[document, saveDocument],
	);

	// Append several auto-generated zoom regions in one save (auto-enhance).
	// Suggestions come from buildAutoZoomSuggestions, which already reserves
	// existing zoom spans, so no extra overlap filtering is needed here.
	// Returns the count actually added (0 when there's no doc/suggestions).
	const addZoomsBulk = useCallback(
		async (suggestions: AutoZoomSuggestion[]) => {
			// Read from the store, not off the render closure. Unlike its `add*` siblings,
			// which compute and save in the same tick, this one is reached from the wand
			// AFTER a multi-second cursor-telemetry IPC: the closure document is the one
			// from before that wait, so anything the user committed during it is missing
			// from the snapshot, and writing the snapshot back drops their edit. Reading
			// here is also what lets this compose with `useSequentialTimelineOps` -- same
			// reason as `applyClipEdit`, `setTrimEntries` and `insertClipAt`.
			const doc = useProjectStore.getState().document;
			if (!doc || suggestions.length === 0) return 0;
			// The same wait makes the PROJECT stale, and reading the document fresh is what
			// exposes it: the suggestions were built from the OLD project's telemetry and its
			// ruler, so applying them to whatever is loaded now writes one project's zooms into
			// another. `saveDocument`'s epoch check cannot see this one -- the write is issued
			// after the switch, not across it -- which is the same reason
			// `documentAfterProbedDuration` carries an `originatingProjectId`.
			if (useProjectStore.getState().projectId !== projectId) return 0;
			// One append shared with the fresh-recording import path, so the wand and the
			// import cannot drift apart. It anchors against the SAME document the write is
			// built from: anchoring on stale clips and saving the fresh document would
			// place the regions against a timeline that no longer exists.
			const next = appendAutoZoomSuggestions(doc, suggestions);
			if (!(await saveDocument(next, { history: true }))) return 0;
			return suggestions.length;
		},
		[projectId, saveDocument],
	);

	const addTrim = useCallback(
		async (durationSec = DEFAULT_NEW_REGION_SEC) => {
			if (!document) return;
			// Insert a 2s trim at the playhead in *timeline* time, then resolve it
			// down to the correct clip's asset + source-time. Writing currentTimeSec
			// straight into startSec (as before) only happened to be right for an
			// identity single-clip project — for trimmed/reordered clips it landed
			// the trim at the wrong source position.
			const playhead = playheadSec();
			const end = playhead + durationSec;
			const resolved = resolveTimelineSpanToTrim(playhead, end, document.timeline.clips);
			const asset =
				document.assets.find((a) => a.id === document.project.primaryAssetId) ?? document.assets[0];
			if (!resolved && !asset) return;
			const next: AxcutDocument = {
				...document,
				timeline: {
					...document.timeline,
					trimRanges: [
						...document.timeline.trimRanges,
						{
							id: createId("trim"),
							assetId: resolved?.assetId ?? asset!.id,
							// The carrier clip, so the cut lands on THAT clip and not on every clip
							// sharing its media (see `trimAppliesToClip`). Absent only in the
							// no-clip fallback below, where there is no clip to name.
							...(resolved ? { clipId: resolved.clipId } : {}),
							startSec: resolved?.sourceStartSec ?? playhead,
							endSec: resolved?.sourceEndSec ?? end,
							reason: "manual",
							origin: "user" as const,
						},
					],
				},
			};
			await saveDocument(next, { history: true });
		},
		[document, saveDocument],
	);

	const addAnnotation = useCallback(
		async (durationSec = DEFAULT_NEW_REGION_SEC) => {
			if (!document) return;
			const timeMs = Math.round(playheadSec() * 1000);
			const draft: AnnotationRegion = {
				id: createId("ann"),
				startMs: timeMs,
				endMs: timeMs + Math.round(durationSec * 1000),
				type: "text" as AnnotationType,
				// Real, localised text rather than an empty field. An empty annotation
				// renders nothing at all, so the user added a region and saw no change
				// on the canvas; the inspector's placeholder is CSS ghost text that
				// never reaches `content`, so it never reached the compositor either.
				// `textContent` stays empty because the render path reads
				// `content || textContent` and seeding both would just duplicate it.
				content: ts("annotation.defaultText"),
				textContent: "",
				// On the frame, free of the footage: padding never moves it.
				space: "frame",
				// A point at the centre of the frame; `fitTextBox` below grows the box around it.
				position: { x: 50, y: 50 },
				size: { width: 0, height: 0 },
				style: {
					color: "#ffffff",
					backgroundColor: DEFAULT_TEXT_PLATE,
					fontSize: 32,
					fontFamily: "Inter",
					fontWeight: "bold",
					fontStyle: "normal",
					textDecoration: "none",
					textAlign: "center",
					textAnimation: "none",
				},
				zIndex: document.annotations.length + 1,
			};
			const frameAspect = resolveAspectRatioValue(
				document,
				getEditorSettings(document).aspectRatio,
			);
			const ann: AnnotationRegion = { ...draft, ...fitTextBox(draft, frameAspect) };
			const created = anchorRegionsWithDerivedMs([ann], document.timeline.clips, () =>
				createId("ann"),
			);
			const next: AxcutDocument = {
				...document,
				annotations: [
					...document.annotations,
					...created,
				] as unknown as AxcutDocument["annotations"],
			};
			if (!(await saveDocument(next, { history: true }))) return;
			// Select the freshly added annotation so its inspector opens and it shows a
			// selection box on the canvas, ready to be retyped over.
			const newId = created[0]?.id ?? ann.id;
			setMultiSelection([{ kind: "annotation", id: newId }]);
			setSelection({ kind: "annotation", id: newId });
			// `ts` is memoised on [locale, namespace] by useScopedT, so this does not
			// churn the callback identity between renders.
		},
		[document, saveDocument, ts],
	);

	const addSpeed = useCallback(
		async (durationSec = DEFAULT_NEW_REGION_SEC) => {
			if (!document) return;
			const timeMs = Math.round(playheadSec() * 1000);
			const endMs = timeMs + Math.round(durationSec * 1000);
			const legacy = (document.legacyEditor as Record<string, unknown>) ?? {};
			const prev = (legacy.speedRegions as unknown[]) ?? [];
			const next: AxcutDocument = {
				...document,
				legacyEditor: {
					...legacy,
					speedRegions: [
						...prev,
						...anchorRegionsWithDerivedMs(
							[{ id: createId("speed"), startMs: timeMs, endMs, speed: 1.5 as const }],
							document.timeline.clips,
							() => createId("speed"),
						),
					],
				},
			};
			await saveDocument(next, { history: true });
		},
		[document, saveDocument],
	);

	// Full Camera: a plain time span (no value) during which the preview/export
	// grows the webcam overlay to (almost) fill the canvas and eases it back.
	//
	// With no webcam anywhere on the timeline there is nothing to grow, so the region
	// renders nothing in the preview (`PreviewCanvas.effectiveLayout` short-circuits on
	// a missing `webcamRect`) and nothing in the export — it just sits in
	// `legacyEditor.cameraFullscreenRegions` forever. The agent's `addCameraFullscreen`
	// tool already refuses this and says why (electron/ai-edition/agent-tools.ts,
	// `noCameraUnderSpan`); the gate lives HERE rather than at each button so both UI
	// entry points — the toolbar and the `C` shortcut — and any future one are covered
	// by construction. `hasAnyClipWithCamera` is the consolidated answer to "does this
	// project have a camera at all", used the same way by the Layout pane.
	//
	// The lane is shared with layout sections, and neither list overlaps the desk sections: a
	// span that would land on a layout or desk section is refused ("occupied") and nothing is
	// written. Over another Full Camera region it still writes, and the two merge on display.
	const addCameraFullscreen = useCallback(
		async (durationSec = DEFAULT_NEW_REGION_SEC): Promise<AddCameraSectionOutcome> => {
			if (!document) return "no-camera";
			if (!hasAnyClipWithCamera(document.assets, document.timeline.clips)) return "no-camera";
			const timeMs = Math.round(playheadSec() * 1000);
			const endMs = timeMs + Math.round(durationSec * 1000);
			const lanes = cameraLanes(document);
			if (cameraLaneOccupied([lanes.layout, lanes.desk], timeMs, endMs)) return "occupied";
			const prev = (lanes.legacy.cameraFullscreenRegions as unknown[]) ?? [];
			const next: AxcutDocument = {
				...document,
				legacyEditor: {
					...lanes.legacy,
					cameraFullscreenRegions: [
						...prev,
						...anchorRegionsWithDerivedMs(
							[{ id: createId("camfull"), startMs: timeMs, endMs }],
							document.timeline.clips,
							() => createId("camfull"),
						),
					],
				},
			};
			await saveDocument(next, { history: true });
			return "added";
		},
		[document, saveDocument],
	);

	// A layout section at the playhead, with the same camera gate and default duration as
	// Full Camera. Unlike Full Camera it refuses any overlap on the shared lane, so the
	// caller can tell the user the spot is taken. `camera-full` of camera 1 IS a Full
	// Camera region and is added as one.
	const addCameraLayout = useCallback(
		async (
			template: CameraLayoutTemplate,
			cameras: number[],
			durationSec = DEFAULT_NEW_REGION_SEC,
		): Promise<AddCameraSectionOutcome> => {
			if (!document) return "no-camera";
			if (!hasAnyClipWithCamera(document.assets, document.timeline.clips)) return "no-camera";
			const picked = camerasForTemplate(template, [], cameras);
			if (!picked) return "too-few-cameras";
			const slots: CameraLayoutSlot[] = picked.map((camera) => ({ camera }));
			const timeMs = Math.round(playheadSec() * 1000);
			const endMs = timeMs + Math.round(durationSec * 1000);
			const lanes = cameraLanes(document);
			if (cameraLaneOccupied([lanes.full, lanes.layout, lanes.desk], timeMs, endMs)) {
				return "occupied";
			}
			if (isFullCameraLayout({ template, slots })) return addCameraFullscreen(durationSec);
			const added = anchorRegionsWithDerivedMs<AnchoredCameraLayoutRegion>(
				[{ id: createId("camlayout"), startMs: timeMs, endMs, template, slots }],
				document.timeline.clips,
				() => createId("camlayout"),
			);
			const next = withCameraLanes(document, lanes, lanes.full, [...lanes.layout, ...added]);
			await saveDocument(next, { history: true });
			return "added";
		},
		[addCameraFullscreen, document, saveDocument],
	);

	// A desk section at the playhead: the project's desk camera fills the frame. Refused
	// without a desk camera, and over any camera section — Full Camera, layout or desk — so the
	// caller can tell the user why. Touching one is allowed.
	const addDeskSection = useCallback(
		async (durationSec = DEFAULT_NEW_REGION_SEC): Promise<AddCameraSectionOutcome> => {
			if (!document || deskCameraOf(document) === null) return "no-desk-camera";
			const timeMs = Math.round(playheadSec() * 1000);
			const endMs = timeMs + Math.round(durationSec * 1000);
			const lanes = cameraLanes(document);
			if (cameraLaneOccupied([lanes.full, lanes.layout, lanes.desk], timeMs, endMs)) {
				return "occupied";
			}
			const added = anchorRegionsWithDerivedMs<AnchoredDeskRegion>(
				[{ id: createId("desk"), startMs: timeMs, endMs }],
				document.timeline.clips,
				() => createId("desk"),
			);
			const next = withCameraLanes(document, lanes, lanes.full, lanes.layout, [
				...lanes.desk,
				...added,
			]);
			await saveDocument(next, { history: true });
			return "added";
		},
		[document, saveDocument],
	);

	// Like updateTrimRange but also re-attaches the trim to a (possibly different) CLIP —
	// needed when a trim is dragged across a clip boundary, whether or not the landing clip
	// is backed by another asset. Re-pointing `clipId` as well as `assetId` is what makes a
	// drag onto the second clip of a duplicated asset actually move the cut instead of
	// leaving it on the first (the two are indistinguishable by asset + source range alone).
	// Callers resolve the timeline span via `resolveTimelineSpanToTrim`.
	const updateTrim = useCallback(
		async (
			trimId: string,
			next: { assetId: string; clipId?: string; startSec: number; endSec: number },
		) => {
			if (!document) return;
			const s = finiteSec(next.startSec);
			const e = finiteSec(next.endSec);
			const nextDoc: AxcutDocument = {
				...document,
				timeline: {
					...document.timeline,
					trimRanges: document.timeline.trimRanges.map((r) =>
						r.id === trimId
							? {
									...r,
									assetId: next.assetId,
									clipId: next.clipId,
									startSec: Math.min(s, e),
									endSec: Math.max(s, e),
								}
							: r,
					),
				},
			};
			await saveDocument(nextDoc, { history: true });
		},
		[document, saveDocument],
	);

	// Reconcile the set of trim entries "owned" by one drag with a freshly
	// ventilated result. A trim resized across a clip boundary can't stay a
	// single source range (source-time is per asset), so it materialises as one
	// entry per covered clip — the caller passes explicit, stable ids (so the
	// dragged pill keeps its identity across frames) plus `dropIds` for entries a
	// shrinking span no longer needs. Trims not owned by this drag are untouched.
	const setTrimEntries = useCallback(
		async (
			entries: Array<{
				id: string;
				assetId: string;
				clipId?: string;
				sourceStartSec: number;
				sourceEndSec: number;
			}>,
			dropIds: string[],
		) => {
			const doc = useProjectStore.getState().document;
			if (!doc) return;
			const managed = new Set<string>([...entries.map((e) => e.id), ...dropIds]);
			const others = doc.timeline.trimRanges.filter((r) => !managed.has(r.id));
			const rebuilt = entries.map((e) => {
				const prev = doc.timeline.trimRanges.find((r) => r.id === e.id);
				const s = finiteSec(e.sourceStartSec);
				const en = finiteSec(e.sourceEndSec);
				return {
					id: e.id,
					assetId: e.assetId,
					// Ventilation names the covered clip per entry; carrying it through is what
					// keeps a drag over two clips of the SAME media as two distinct cuts rather
					// than one that lands on both.
					clipId: e.clipId,
					startSec: Math.min(s, en),
					endSec: Math.max(s, en),
					reason: prev?.reason ?? "manual",
					origin: prev?.origin ?? ("user" as const),
				};
			});
			await saveDocument(
				{
					...doc,
					timeline: { ...doc.timeline, trimRanges: [...others, ...rebuilt] },
				},
				{ history: true },
			);
		},
		[saveDocument],
	);

	// The zoom pane's own write chain -- see `queueZoomWrite`. Only `enqueue` is used, so
	// there is no fallback document to hand it.
	const { enqueue: enqueueZoomWrite } = useSequentialTimelineOps({
		fallbackDocument: null,
		saveDocument,
	});

	// Every whole-document write to one zoom goes through this chain: the pane's one-field
	// writes (level, 3D tilt, focus mode, cursor), a pill's span, and the focus
	// commit. `write` runs INSIDE the chain, on the document the previous zoom write left, and
	// returns its `saveDocument`. The level buttons step while the previous save is still out,
	// and 3 -> 4 -> 5 built both saves from the render's depth-3 document: the main process does
	// not order them, so the 4 could land last, and even in order one Ctrl+Z skipped a level. A
	// neighbouring select changed, a pill resized or a focus committed while a level was pending
	// rebuilt from that same document and put 3 back. Resolves `saveDocument`'s answer, so the
	// level buttons can retry a failed write, or `"timeout"` when it did not come in time.
	//
	// Each request is bound to the project and write epoch it was asked against — the same
	// pair `addAsset` samples: an undo bumps the epoch, a project switch swaps both, and a
	// queued patch that only STARTS after such a replacement must not apply to the document
	// that replaced its target. A save whose answer is unknown (`saveWithDeadline` timed out
	// with the bridge still silent) may still land, so later zoom writes are refused until it
	// settles instead of racing it — the same "a queued write racing a stuck one" the
	// `waitForDocumentSaves` header calls out. The block is keyed to the save's own epoch:
	// once a replacement moves the epoch, that save can no longer install anything
	// (`saveDocument` drops it) and must stop blocking; a project switch does not move the
	// epoch, so there the stuck save can still land and the block correctly stays.
	const unknownZoomSavesRef = useRef<Array<number>>([]);
	const queueZoomWrite = useCallback(
		(write: (doc: AxcutDocument, historyBase: AxcutDocument | undefined) => Promise<boolean>) => {
			const epoch = currentWriteEpoch();
			const projectId = useProjectStore.getState().projectId;
			return enqueueZoomWrite(async () => {
				if (useProjectStore.getState().projectId !== projectId || currentWriteEpoch() !== epoch) {
					return false;
				}
				if (unknownZoomSavesRef.current.filter((stuck) => stuck === epoch).length > 0) {
					return false;
				}
				const doc = useProjectStore.getState().document;
				if (!doc) return false;
				// A focus drag not yet committed is on screen, so this write saves it too, and the
				// commit will find nothing left to record. Its undo step reaches back to before
				// the drag instead, or the drag could never be undone.
				const historyBase =
					doc === zoomFocusLiveRef.current
						? (zoomFocusRollbackRef.current ?? undefined)
						: undefined;
				const save = write(doc, historyBase);
				const outcome = await saveWithDeadline(save);
				if (outcome === "timeout") {
					// Unknown, not failed: the write may still land. Refuse later writes into
					// this same document generation until the save settles or the epoch moves
					// past it.
					unknownZoomSavesRef.current.push(epoch);
					void save
						.then(
							() => undefined,
							() => undefined,
						)
						.finally(() => {
							unknownZoomSavesRef.current = unknownZoomSavesRef.current.filter(
								(stuck) => stuck !== epoch,
							);
						});
				}
				return outcome;
			});
		},
		[enqueueZoomWrite],
	);

	// Reports not-taken for an unknown answer too, so the buttons retry.
	const saveZoomPatch = useCallback(
		(id: string, patch: Partial<AxcutDocument["zoomRanges"][number]>) =>
			queueZoomWrite((doc, historyBase) =>
				saveDocument(
					{
						...doc,
						zoomRanges: patchPillById(doc.zoomRanges, id, patch) as AxcutDocument["zoomRanges"],
					},
					{ history: true, historyBase },
				),
			).then((outcome) => outcome === true),
		[queueZoomWrite, saveDocument],
	);

	// Span edits are GROUP-AWARE: dragging/resizing a pill re-anchors every fragment
	// under the pill to the new ruler span, so an edit that crosses a clip
	// boundary re-splits and one dragged back inside a clip collapses — one user edit stays
	// one pill. See timelineMap.reanchorGroupSpan.
	const updateZoomSpan = useCallback(
		(id: string, startMs: number, endMs: number) => {
			const s = finiteMs(startMs);
			const e = finiteMs(endMs);
			return queueZoomWrite((doc, historyBase) =>
				saveDocument(
					{
						...doc,
						zoomRanges: replacePillSpan(
							doc.zoomRanges,
							id,
							Math.min(s, e),
							Math.max(s, e),
							doc.timeline.clips,
							() => createId("zoom"),
						) as AxcutDocument["zoomRanges"],
					},
					{ history: true, historyBase },
				),
			);
		},
		[queueZoomWrite, saveDocument],
	);

	// ponytail: the focus overlay drags at pointermove frequency (~60-120 Hz).
	// Routing every frame through `saveDocument` (IPC round-trip + disk write
	// + zod re-parse + full store replace) made dragging visibly laggy.
	// `updateZoomFocusLive` mirrors `useEditorSettings`'s setLive/commit split:
	// local-only store writes while dragging, one persisted save on release.
	const updateZoomFocusLive = useCallback(
		(id: string, focus: { cx: number; cy: number }) => {
			const doc = useProjectStore.getState().document;
			if (!doc) return;
			// The first live write of a drag is the one editing a document this callback
			// did not itself produce, so it is the pre-drag state — the one thing worth
			// returning to. It is remembered, not recorded: `commitZoomFocus` hands it to
			// `saveDocument` as `historyBase`, so the whole gesture becomes ONE undo step
			// and only once the write landed. Recording it here instead left the entry
			// behind when the commit failed and rolled the document back to that very
			// document — a Ctrl+Z that visibly did nothing, with `future` already wiped.
			if (zoomFocusLiveRef.current !== doc) zoomFocusRollbackRef.current = doc;
			const edit = {
				id,
				focus: { cx: finiteFraction(focus.cx), cy: finiteFraction(focus.cy) },
				epoch: currentWriteEpoch(),
			};
			const next: AxcutDocument = {
				...doc,
				zoomRanges: patchPillById(doc.zoomRanges, id, {
					focus: edit.focus,
				}) as AxcutDocument["zoomRanges"],
			};
			setDocument(next, { history: false });
			zoomFocusLiveRef.current = next;
			zoomFocusEditRef.current = edit;
		},
		[setDocument],
	);

	// On the zoom chain, like every zoom write: a level still being saved when the focus is
	// committed would otherwise land first and be overwritten by this save, built before it.
	const commitZoomFocus = useCallback(async () => {
		// What the drag left, taken now. While the commit waits its turn, a zoom write queued
		// before the drag can land, and it installs ITS document, built before the drag, in
		// place of the dragged one.
		const live = zoomFocusLiveRef.current;
		const rollback = zoomFocusRollbackRef.current;
		const epoch = currentWriteEpoch();
		// A drag abandoned before an undo or a replacement is not this commit's to put back: the
		// document it was made on is gone, and restoring its focus would undo the undo.
		const pendingEdit = zoomFocusEditRef.current;
		const edit = pendingEdit?.epoch === epoch ? pendingEdit : null;
		zoomFocusRollbackRef.current = null;
		zoomFocusLiveRef.current = null;
		zoomFocusEditRef.current = null;
		const pending: { save?: Promise<boolean> } = {};
		const outcome = await queueZoomWrite((doc) => {
			// The snapshot counts only while the document on screen is still the one this
			// hook's last live write produced -- `updateZoomFocusLive`'s own identity test,
			// read the other way round. Without it a commit that arrives with no live write
			// in front of it picks up whatever an abandoned drag left behind, and every
			// recording write since has already put the states in between on the stack: as a
			// `historyBase` that makes one Ctrl+Z step over the lot, and on the failure path
			// below it puts that buried document back on screen, silently dropping them.
			// `handlePointerDown` sets `draggingRef` BEFORE its live write and that write
			// returns early on a zero-size overlay rect, so `endDrag` can reach here bare.
			//
			// `historyBase` is the pre-drag document, not the one the store holds (that is the
			// dragged one, written live); `null` when no live write happened, which records
			// nothing, which is right: nothing changed.
			let next = doc;
			let historyBase = doc === live ? rollback : null;
			const pill = edit ? doc.zoomRanges.find((zoom) => zoom.id === edit.id) : undefined;
			if (
				doc !== live &&
				edit &&
				pill &&
				(pill.focus.cx !== edit.focus.cx || pill.focus.cy !== edit.focus.cy)
			) {
				// A zoom write landed over the drag and took its focus off screen. The focus goes
				// back on top of that write, so both stay, and one Ctrl+Z takes the focus off it
				// again. When the writes since carried the focus along, there is nothing to add.
				next = {
					...doc,
					zoomRanges: patchPillById(doc.zoomRanges, edit.id, {
						focus: edit.focus,
					}) as AxcutDocument["zoomRanges"],
				};
				historyBase = doc;
			}
			pending.save = saveDocument(next, { history: true, historyBase });
			return pending.save;
		});
		// A save out of time has left the chain, but it can still fail: its answer, whenever it
		// comes, decides the rollback, or the dragged focus stays on screen for a later save.
		const saved = outcome === "timeout" && pending.save ? await pending.save : outcome;
		if (saved === false && rollback) {
			useProjectStore.setState((state) =>
				// Only while the dragged document is still the one on screen, in the epoch it was
				// committed in: anything else there was put by a write that landed, or by an undo.
				// `dirty` is deliberately NOT cleared. The rollback target is the last document
				// this drag started from, which is not the same as the last SAVED one: with two
				// commits in flight the first one's unsaved document is what we restore. Saying
				// "clean" there tells `beforeunload` and `setHasUnsavedChanges` there is nothing
				// to save, and the window closes on real work without prompting.
				state.document === live && currentWriteEpoch() === epoch
					? { document: rollback, revision: state.revision + 1 }
					: {},
			);
		}
	}, [queueZoomWrite, saveDocument]);

	// A preset level (`ZOOM_DEPTH_SCALES`, 1.25×–5×). It clears any custom scale, which
	// would otherwise keep overriding the depth: the level picked is the level rendered.
	const updateZoomDepth = useCallback(
		(id: string, depth: 1 | 2 | 3 | 4 | 5 | 6) =>
			saveZoomPatch(id, { depth, customScale: undefined }),
		[saveZoomPatch],
	);

	// Any other level, from the pane's free field. Clamped to the renderer's range here, so no
	// caller can store a scale that `effectiveZoomScale` would then read differently.
	const updateZoomCustomScale = useCallback(
		(id: string, scale: number) =>
			saveZoomPatch(id, { customScale: Math.min(MAX_ZOOM_SCALE, Math.max(MIN_ZOOM_SCALE, scale)) }),
		[saveZoomPatch],
	);

	// Same story as `focusMode` below: the 3D tilt was implemented end to end — schema
	// (`rotationPreset`), migration, `sceneDescription` (`rotation:`), `rotation3d_for` in
	// regions.rs and the perspective shader in compositor.rs — with no control to set it.
	// `undefined` clears the preset back to a flat frame; `migrate.ts` already drops the field
	// when it is falsy, so absent and "no rotation" are the same state.
	const updateZoomRotation = useCallback(
		(id: string, rotationPreset: Rotation3DPreset | undefined) =>
			saveZoomPatch(id, { rotationPreset }),
		[saveZoomPatch],
	);

	// Nothing could set `focusMode`: "auto" only ever arrived from the automatic suggestion pass
	// (`zoomSuggestions.ts`), so a hand-drawn zoom stayed pinned to its static focus point with no
	// way to make it follow the cursor. The capability itself was complete end to end —
	// `sceneDescription.ts` ships the mode, `scene.rs` parses it, `regions.rs::resolve_focus`
	// samples the cursor track — only this setter was missing.
	//
	// Writing "manual" explicitly is safe even though `migrate.ts` only persists "auto": an absent
	// field MEANS manual, so both forms resolve identically.
	const updateZoomFocusMode = useCallback(
		(id: string, focusMode: "manual" | "auto") => saveZoomPatch(id, { focusMode }),
		[saveZoomPatch],
	);

	const updateZoomHideCursor = useCallback(
		(id: string, hideCursor: boolean | undefined) =>
			saveZoomPatch(id, { hideCursor: hideCursor ? true : undefined }),
		[saveZoomPatch],
	);

	const updateAnnotationSpan = useCallback(
		async (id: string, startMs: number, endMs: number) => {
			if (!document) return;
			const s = finiteMs(startMs);
			const e = finiteMs(endMs);
			const next: AxcutDocument = {
				...document,
				annotations: replacePillSpan(
					document.annotations,
					id,
					Math.min(s, e),
					Math.max(s, e),
					document.timeline.clips,
					() => createId("ann"),
				),
			};
			await saveDocument(next, { history: true });
		},
		[document, saveDocument],
	);

	// Drag/resize on the preview overlay (position, size, blur mask edits) — same
	// live/commit split as updateZoomFocusLive/commitZoomFocus, for the same
	// reason: local-only writes while dragging, one persisted save on release.
	const updateAnnotationLive = useCallback(
		(id: string, patch: Partial<AxcutDocument["annotations"][number]>) => {
			const doc = useProjectStore.getState().document;
			if (!doc) return;
			// One undo step per drag, recorded by the commit once it lands — same
			// reasoning, and the same failed-commit hole, as `updateZoomFocusLive` above.
			if (annotationLiveRef.current !== doc) annotationRollbackRef.current = doc;
			const next: AxcutDocument = {
				...doc,
				annotations: patchPillById(doc.annotations, id, patch),
			};
			setDocument(next, { history: false });
			annotationLiveRef.current = next;
		},
		[setDocument],
	);

	const commitAnnotationChange = useCallback(async () => {
		const doc = useProjectStore.getState().document;
		if (!doc) return;
		// See `commitZoomFocus`: the snapshot counts only while the document on screen is
		// still the one this hook's live writes produced. This is the reachable half.
		// The inspector's annotation `<textarea>` calls `updateAnnotationLive` on every
		// keystroke and commits `onBlur`, and closing the panel unmounts the focused node
		// before blur can fire: `V4Timeline`'s `startScrub` clears the selection from a
		// pointerdown handler, and React flushes discrete events synchronously, so the
		// textarea is gone before mousedown moves focus. (Deleting the region does NOT
		// reach here — its button is an `onClick`, which runs after blur has committed.)
		// `SliderCell` then wires mouseup
		// straight to `onCommit`, so a bare click on a stroke-width thumb lands here
		// carrying the typing's base. `NewEditorShell` builds one `useTimeline()` for
		// both, so it is one instance's ref.
		const rollback = annotationLiveRef.current === doc ? annotationRollbackRef.current : null;
		annotationRollbackRef.current = null;
		annotationLiveRef.current = null;
		// The pre-drag document is the undo target, and it is recorded only if this write
		// succeeds.
		if (!(await saveDocument(doc, { history: true, historyBase: rollback })) && rollback) {
			useProjectStore.setState((state) =>
				// `dirty` is deliberately NOT cleared. The rollback target is the last document
				// this drag started from, which is not the same as the last SAVED one: with two
				// commits in flight the first one's unsaved document is what we restore. Saying
				// "clean" there tells `beforeunload` and `setHasUnsavedChanges` there is nothing
				// to save, and the window closes on real work without prompting.
				state.document === doc ? { document: rollback, revision: state.revision + 1 } : {},
			);
		}
	}, [saveDocument]);

	const updateSpeedSpan = useCallback(
		async (id: string, startMs: number, endMs: number) => {
			if (!document) return;
			const s = finiteMs(startMs);
			const e = finiteMs(endMs);
			const legacy = (document.legacyEditor as Record<string, unknown>) ?? {};
			const prev = ((legacy.speedRegions as unknown[]) ?? []) as Array<{
				id: string;
				startMs: number;
				endMs: number;
				speed: number;
			}>;
			const next: AxcutDocument = {
				...document,
				legacyEditor: {
					...legacy,
					speedRegions: replacePillSpan(
						prev,
						id,
						Math.min(s, e),
						Math.max(s, e),
						document.timeline.clips,
						() => createId("speed"),
					),
				},
			};
			await saveDocument(next, { history: true });
		},
		[document, saveDocument],
	);

	// Move/resize on the camera lanes: clamped at the pills of all three lists.
	const updateCameraFullscreenSpan = useCallback(
		async (id: string, startMs: number, endMs: number) => {
			if (!document) return;
			const s = finiteMs(startMs);
			const e = finiteMs(endMs);
			const lanes = cameraLanes(document);
			const span = clampCameraSpan(
				lanes.full,
				[lanes.layout, lanes.desk],
				id,
				Math.min(s, e),
				Math.max(s, e),
			);
			const next: AxcutDocument = {
				...document,
				legacyEditor: {
					...lanes.legacy,
					cameraFullscreenRegions: replacePillSpan(
						lanes.full,
						id,
						span.startMs,
						span.endMs,
						document.timeline.clips,
						() => createId("camfull"),
					),
				},
			};
			await saveDocument(next, { history: true });
		},
		[document, saveDocument],
	);

	const updateCameraLayoutSpan = useCallback(
		async (id: string, startMs: number, endMs: number) => {
			if (!document) return;
			const s = finiteMs(startMs);
			const e = finiteMs(endMs);
			const lanes = cameraLanes(document);
			const span = clampCameraSpan(
				lanes.layout,
				[lanes.full, lanes.desk],
				id,
				Math.min(s, e),
				Math.max(s, e),
			);
			const layout = replacePillSpan(
				lanes.layout,
				id,
				span.startMs,
				span.endMs,
				document.timeline.clips,
				() => createId("camlayout"),
			);
			await saveDocument(withCameraLanes(document, lanes, lanes.full, layout), { history: true });
		},
		[document, saveDocument],
	);

	const updateDeskSpan = useCallback(
		async (id: string, startMs: number, endMs: number) => {
			if (!document) return;
			const s = finiteMs(startMs);
			const e = finiteMs(endMs);
			const lanes = cameraLanes(document);
			const span = clampCameraSpan(
				lanes.desk,
				[lanes.full, lanes.layout],
				id,
				Math.min(s, e),
				Math.max(s, e),
			);
			const desk = replacePillSpan(
				lanes.desk,
				id,
				span.startMs,
				span.endMs,
				document.timeline.clips,
				() => createId("desk"),
			);
			await saveDocument(withCameraLanes(document, lanes, lanes.full, lanes.layout, desk), {
				history: true,
			});
		},
		[document, saveDocument],
	);

	const updateSpeedValue = useCallback(
		async (id: string, speed: number) => {
			if (!document) return;
			const legacy = (document.legacyEditor as Record<string, unknown>) ?? {};
			const prev = ((legacy.speedRegions as unknown[]) ?? []) as Array<{
				id: string;
				startMs: number;
				endMs: number;
				speed: number;
			}>;
			const next: AxcutDocument = {
				...document,
				legacyEditor: {
					...legacy,
					speedRegions: patchPillById(prev, id, { speed }),
				},
			};
			await saveDocument(next, { history: true });
		},
		[document, saveDocument],
	);

	const updateCameraFullscreenOrientation = useCallback(
		async (id: string, orientation: { rotation: CameraRotation; mirror: CameraMirrorMode }) => {
			if (!document) return;
			const legacy = (document.legacyEditor as Record<string, unknown>) ?? {};
			const prev = ((legacy.cameraFullscreenRegions as unknown[]) ??
				[]) as CameraFullscreenRegion[];
			const rotation = normalizeCameraRotation(orientation.rotation);
			const mirror = normalizeCameraMirror(orientation.mirror);
			// Defaults are not stored: a section turned back to plain is byte-identical to one
			// that was never touched.
			// patchPillById copies exactly the pill's rows; untouched rows keep their identity.
			const patched = patchPillById(prev, id, {}).map((r, i) => {
				if (r === prev[i]) return r;
				const { rotation: _r, mirror: _m, ...rest } = r;
				return {
					...rest,
					...(rotation !== 0 ? { rotation } : {}),
					...(mirror !== "auto" ? { mirror } : {}),
				};
			});
			const next: AxcutDocument = {
				...document,
				legacyEditor: { ...legacy, cameraFullscreenRegions: patched },
			};
			await saveDocument(next, { history: true });
		},
		[document, saveDocument],
	);

	// Per-camera settings (`legacyEditor.cameraSettings`). One write, one undo step; the key
	// is deleted when nothing is left, so untouched projects stay byte-identical.
	// The document is read when the write runs, not when the callback was made: callers put
	// it on the shell's write queue, and a queued write must build on the save before it.
	const setCameraSettings = useCallback(
		async (index: number, patch: Partial<CameraSettings> | null) => {
			const current = useProjectStore.getState().document ?? document;
			if (!current) return;
			const legacy = (current.legacyEditor as Record<string, unknown>) ?? {};
			const list = patchCameraSettings(legacy.cameraSettings, index, patch);
			// Nothing changes (out-of-range index, camera-1 patch without a perspective, resetting a
			// default camera): no save and no empty undo step.
			if (
				JSON.stringify(list ?? []) ===
				JSON.stringify(normalizeCameraSettings(legacy.cameraSettings))
			)
				return;
			const { cameraSettings: _prev, ...rest } = legacy;
			const next: AxcutDocument = {
				...current,
				legacyEditor: list ? { ...rest, cameraSettings: list } : rest,
			};
			await saveDocument(next, { history: true });
		},
		[document, saveDocument],
	);

	const updateCameraFullscreenDeskLabel = useCallback(
		async (id: string, show: boolean) => {
			if (!document) return;
			const legacy = (document.legacyEditor as Record<string, unknown>) ?? {};
			const prev = ((legacy.cameraFullscreenRegions as unknown[]) ??
				[]) as CameraFullscreenRegion[];
			const next: AxcutDocument = {
				...document,
				legacyEditor: { ...legacy, cameraFullscreenRegions: withDeskLabel(prev, id, show) },
			};
			await saveDocument(next, { history: true });
		},
		[document, saveDocument],
	);

	const updateDeskLabel = useCallback(
		async (id: string, show: boolean) => {
			if (!document) return;
			const lanes = cameraLanes(document);
			const desk = withDeskLabel(lanes.desk, id, show);
			await saveDocument(withCameraLanes(document, lanes, lanes.full, lanes.layout, desk), {
				history: true,
			});
		},
		[document, saveDocument],
	);

	// The desk camera the user chose (`legacyEditor.deskCamera`, 0 = camera 1), or `null` to
	// remove the choice and let `resolveDeskCamera` pick. One write, one undo step; a choice
	// that changes nothing writes nothing. Read at write time, like `setCameraSettings`.
	const setDeskCamera = useCallback(
		async (index: number | null) => {
			const current = useProjectStore.getState().document ?? document;
			if (!current) return;
			if (index !== null && (!Number.isInteger(index) || index < 0 || index >= MAX_CAMERAS)) {
				return;
			}
			const legacy = (current.legacyEditor as Record<string, unknown>) ?? {};
			if (chosenDeskCamera(legacy) === index) return;
			const { deskCamera: _prev, ...rest } = legacy;
			const next: AxcutDocument = {
				...current,
				legacyEditor: index === null ? rest : { ...rest, deskCamera: index },
			};
			await saveDocument(next, { history: true });
		},
		[document, saveDocument],
	);

	// Change the template of a section on the camera lane, in ONE save, so one undo step.
	// The storage rule decides the list: a `camera-full` section of camera 1 is a Full
	// Camera region, everything else a layout row. A switch that crosses that line moves
	// the section's rows to the other list on the same anchors; a Full Camera section's
	// desk fields stay behind (desk view exists only there), and a section coming back gets
	// the default desk fields. Returns the section's handle afterwards, so the selection can
	// follow it to the other list — or the given handle when nothing was written.
	const setLayoutTemplate = useCallback(
		async (
			handle: CameraSectionHandle,
			template: CameraLayoutTemplate,
			cameras: number[],
		): Promise<CameraSectionHandle> => {
			if (!document) return handle;
			const lanes = cameraLanes(document);
			const current =
				handle.kind === "cameraFullscreen"
					? [0]
					: (lanes.layout.find((r) => r.id === handle.id)?.slots.map((s) => s.camera) ?? []);
			const picked = camerasForTemplate(template, current, cameras);
			if (!picked) return handle;
			const slots: CameraLayoutSlot[] = picked.map((camera) => ({ camera }));
			const toFullCamera = isFullCameraLayout({ template, slots });
			let result: { doc: AxcutDocument; handle: CameraSectionHandle } | null = null;
			if (handle.kind === "cameraFullscreen") {
				if (toFullCamera) return handle;
				result = fullCameraPillToLayout(document, lanes, handle.id, template, slots);
			} else if (toFullCamera) {
				result = layoutPillToFullCamera(document, lanes, handle.id);
			} else {
				const member = lanes.layout.find((r) => r.id === handle.id);
				if (!member || member.template === template) return handle;
				// A place's own rect belongs to the old template's arrangement, so it goes.
				const layout = patchPillById(lanes.layout, handle.id, { template, slots });
				result = { doc: withCameraLanes(document, lanes, lanes.full, layout), handle };
			}
			if (!result) return handle;
			return (await saveDocument(result.doc, { history: true })) ? result.handle : handle;
		},
		[document, saveDocument],
	);

	// Put `camera` in place `slotIndex` of a layout section. A camera shows once per
	// section, so if it already has another place the two swap; each place keeps its rect.
	// A `camera-full` section that ends up showing camera 1 becomes a Full Camera region,
	// and a Full Camera region given another camera becomes that camera's `camera-full`
	// section. Returns the section's handle afterwards, or the given one when nothing changed.
	const setLayoutSlotCamera = useCallback(
		async (
			handle: CameraSectionHandle,
			slotIndex: number,
			camera: number,
		): Promise<CameraSectionHandle> => {
			if (!document) return handle;
			if (!Number.isInteger(camera) || camera < 0 || camera >= MAX_CAMERAS) return handle;
			const lanes = cameraLanes(document);
			if (handle.kind === "cameraFullscreen") {
				// Its one place shows camera 1; choosing camera 1 again changes nothing.
				if (slotIndex !== 0 || camera === 0) return handle;
				const moved = fullCameraPillToLayout(document, lanes, handle.id, "camera-full", [
					{ camera },
				]);
				if (!moved) return handle;
				return (await saveDocument(moved.doc, { history: true })) ? moved.handle : handle;
			}
			const id = handle.id;
			const member = lanes.layout.find((r) => r.id === id);
			const place = member?.slots[slotIndex];
			if (!member || !place || place.camera === camera) return handle;
			const slots = member.slots.map((slot, i) => {
				if (i === slotIndex) return { ...slot, camera };
				return slot.camera === camera ? { ...slot, camera: place.camera } : slot;
			});
			const result = isFullCameraLayout({ template: member.template, slots })
				? layoutPillToFullCamera(document, lanes, id)
				: {
						doc: withCameraLanes(
							document,
							lanes,
							lanes.full,
							patchPillById(lanes.layout, id, { slots }),
						),
						handle,
					};
			if (!result) return handle;
			return (await saveDocument(result.doc, { history: true })) ? result.handle : handle;
		},
		[document, saveDocument],
	);

	// Dragging a place in the preview: the same live/commit split as
	// `updateAnnotationLive` / `commitAnnotationChange` — store-only writes while the
	// pointer moves, one save (one undo step) on release.
	const updateLayoutSlotRectLive = useCallback(
		(id: string, slotIndex: number, rect: NormalizedRect) => {
			const doc = useProjectStore.getState().document;
			if (!doc) return;
			const { x, y, width, height } = rect;
			if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return;
			const lanes = cameraLanes(doc);
			const member = lanes.layout.find((r) => r.id === id);
			if (!member?.slots[slotIndex]) return;
			if (layoutRectLiveRef.current !== doc) layoutRectRollbackRef.current = doc;
			const slots = member.slots.map((slot, i) =>
				i === slotIndex ? { camera: slot.camera, rect: { x, y, width, height } } : slot,
			);
			const next = withCameraLanes(
				doc,
				lanes,
				lanes.full,
				patchPillById(lanes.layout, id, { slots }),
			);
			setDocument(next, { history: false });
			layoutRectLiveRef.current = next;
		},
		[setDocument],
	);

	const commitLayoutSlotRect = useCallback(async () => {
		const doc = useProjectStore.getState().document;
		if (!doc) return;
		// See `commitAnnotationChange`: the pre-drag document counts only while the one on
		// screen is still the one the live writes produced.
		const rollback = layoutRectLiveRef.current === doc ? layoutRectRollbackRef.current : null;
		layoutRectRollbackRef.current = null;
		layoutRectLiveRef.current = null;
		if (!(await saveDocument(doc, { history: true, historyBase: rollback })) && rollback) {
			useProjectStore.setState((state) =>
				state.document === doc ? { document: rollback, revision: state.revision + 1 } : {},
			);
		}
	}, [saveDocument]);

	// Every place of the section back to the template's own position: the rects are
	// deleted, not set to a default, so a reset section is byte-identical to a fresh one.
	const resetLayoutSlotRects = useCallback(
		async (id: string) => {
			if (!document) return;
			const lanes = cameraLanes(document);
			const member = lanes.layout.find((r) => r.id === id);
			if (!member?.slots.some((slot) => slot.rect)) return;
			const slots = member.slots.map((slot) => ({ camera: slot.camera }));
			const layout = patchPillById(lanes.layout, id, { slots });
			await saveDocument(withCameraLanes(document, lanes, lanes.full, layout), { history: true });
		},
		[document, saveDocument],
	);

	const removeRegion = useCallback(
		async (kind: RegionKind, id: string) => {
			if (!document) return;
			// One shared mutator with the agent's removeTrim / removeModifier tools.
			if (!(await saveDocument(removeRegionInDocument(document, kind, id), { history: true })))
				return;
			if (selection?.id === id) setSelection(null);
			setMultiSelection((prev) => prev.filter((h) => h.id !== id));
		},
		[document, selection, saveDocument],
	);

	// F2.7 — batch removal for multi-selection: one document save (one undo
	// snapshot) regardless of how many regions are selected.
	const removeRegions = useCallback(
		async (handles: RegionHandle[]) => {
			if (!document || handles.length === 0) return;
			const zoomIds = new Set(handles.filter((h) => h.kind === "zoom").map((h) => h.id));
			const trimIds = new Set(handles.filter((h) => h.kind === "trim").map((h) => h.id));
			const annotationIds = new Set(
				handles.filter((h) => h.kind === "annotation").map((h) => h.id),
			);
			const speedIds = new Set(handles.filter((h) => h.kind === "speed").map((h) => h.id));
			const cameraFullscreenIds = new Set(
				handles.filter((h) => h.kind === "cameraFullscreen").map((h) => h.id),
			);
			const cameraLayoutIds = new Set(
				handles.filter((h) => h.kind === "cameraLayout").map((h) => h.id),
			);
			const deskIds = new Set(handles.filter((h) => h.kind === "desk").map((h) => h.id));
			const legacy = (document.legacyEditor as Record<string, unknown>) ?? {};
			const prevSpeed = dropPillsByIds(
				(legacy.speedRegions as Array<{ id: string; startMs: number; endMs: number }>) ?? [],
				speedIds,
			);
			const prevCameraFullscreen = dropPillsByIds(
				(legacy.cameraFullscreenRegions as Array<{ id: string; startMs: number; endMs: number }>) ??
					[],
				cameraFullscreenIds,
			);
			const next: AxcutDocument = {
				...document,
				zoomRanges: dropPillsByIds(document.zoomRanges, zoomIds) as AxcutDocument["zoomRanges"],
				annotations: dropPillsByIds(document.annotations, annotationIds),
				timeline: {
					...document.timeline,
					// Whole-pill delete, same as the zoom/annotation lines above — a trim grown
					// across a clip boundary is 2+ rows rendering as one stripe, and a bare id
					// filter left the halves the selection didn't name still cutting.
					trimRanges: dropTrimPillsByIds(
						document.timeline.trimRanges,
						document.timeline.clips,
						trimIds,
					),
				},
				legacyEditor:
					speedIds.size > 0 ||
					cameraFullscreenIds.size > 0 ||
					cameraLayoutIds.size > 0 ||
					deskIds.size > 0
						? {
								...legacy,
								speedRegions: prevSpeed,
								cameraFullscreenRegions: prevCameraFullscreen,
								...(cameraLayoutIds.size > 0
									? {
											cameraLayoutRegions: dropPillsByIds(
												(legacy.cameraLayoutRegions as AnchoredCameraLayoutRegion[]) ?? [],
												cameraLayoutIds,
											),
										}
									: {}),
								...(deskIds.size > 0
									? {
											deskRegions: dropPillsByIds(
												(legacy.deskRegions as AnchoredDeskRegion[]) ?? [],
												deskIds,
											),
										}
									: {}),
							}
						: document.legacyEditor,
			};
			if (!(await saveDocument(next, { history: true }))) return;
			setSelection(null);
			setMultiSelection([]);
		},
		[document, saveDocument],
	);

	// Every edit region (zoom, speed, trim, annotation, Full Camera), on every clip, in one
	// write: one undo step brings them all back. Clips, media, audio tracks, captions and the
	// transcript are content, not edits, and stay (see `clearEditRegions`).
	//
	// `hasEditRegions` counts the STORED regions, not the pills the lanes draw: a trim whose
	// clip is gone is stored and cleared but has no pill. The toolbar button reads it too, so
	// what shows the button and what the action clears are one count.
	const hasEditRegions = document !== null && countEditRegions(document) > 0;
	const clearTimeline = useCallback(async () => {
		if (!document || !hasEditRegions) return;
		if (!(await saveDocument(clearEditRegions(document), { history: true }))) return;
		// Every region a selection can point at is gone. An audio track is not one of them.
		if (selection && selection.kind !== "audio") setSelection(null);
		setMultiSelection((prev) => prev.filter((h) => h.kind === "audio"));
	}, [document, hasEditRegions, selection, saveDocument]);

	// Selecting a pill and selecting a clip are the SAME act — "this is the thing
	// I mean" — so they cancel each other. They used to be two states that could
	// both be set: the user saw one highlighted element while the app still held
	// the other, and everything keyed off "is a clip selected?" (copy, paste,
	// delete) silently acted on the invisible one. Copy/paste is where it showed:
	// it always operated on the clip, whatever the user had just clicked.
	const selectRegion = useCallback(
		(kind: RegionKind, id: string, opts?: { additive?: boolean }) => {
			const handle = { kind, id };
			setClipSelection(null);
			setSelectedAudioTrackId(null);
			if (opts?.additive) {
				// Shift-click toggles membership; the focused region follows the click.
				setMultiSelection((prev) => {
					const exists = prev.some((h) => h.kind === kind && h.id === id);
					return exists ? prev.filter((h) => !(h.kind === kind && h.id === id)) : [...prev, handle];
				});
				setSelection(handle);
				return;
			}
			setMultiSelection([handle]);
			setSelection(handle);
		},
		[setSelectedAudioTrackId],
	);

	const clearSelection = useCallback(() => {
		setSelection(null);
		setMultiSelection([]);
		setClipSelection(null);
		setSelectedAudioTrackId(null);
	}, [setSelectedAudioTrackId]);

	// The Edit Clip dialog's Apply, as ONE document and ONE save.
	//
	// Source range and crop are two edits made in a single user action, and they used to
	// be two independent saves fired back to back. Both built their next document from
	// the SAME pre-Apply one — the crop write never saw the source-range change — so
	// whichever IPC write landed last silently dropped the other edit, with no error and
	// no toast (#355). Composing them means the crop is applied to the *resequenced*
	// clips, which is also the only order that can be right.
	//
	// Axcut-consistent clip trim: only the source range is user-editable (the dialog's
	// draggable track). Changing it changes the clip's effective duration, so every clip
	// is resequenced back-to-back afterward — same invariant as
	// insertClipAt/moveClip/removeClip — instead of leaving downstream clips at their old
	// timeline positions (which would overlap). That whole recipe (resequence width +
	// clamp/rederive pills) lives in the one pure `setClipSourceRange`, shared with the op
	// dispatcher and the LLM tool.
	//
	// Crop is a per-clip framing, not a document-wide setting — two clips (even from the
	// same asset) can reasonably want different crops. `undefined` means the dialog's crop
	// section was never touched (leave the stored value alone); `null` clears it back to
	// "no crop" (full frame) rather than storing the identity region explicitly.
	//
	// The document is read from the store, not off the render closure, so this composes
	// with `useSequentialTimelineOps`: queued behind another timeline write, it still sees
	// what that write committed. Same reason as `setTrimEntries` / `insertClipAt`.
	const applyClipEdit = useCallback(
		async (
			clipId: string,
			sourceStartSec: number,
			sourceEndSec: number,
			cropRegion?: AxcutClipCropRegion | null,
		) => {
			const doc = useProjectStore.getState().document;
			if (!doc) return;
			const ranged = setClipSourceRange(doc, clipId, sourceStartSec, sourceEndSec);
			const next: AxcutDocument =
				cropRegion === undefined
					? ranged
					: {
							...ranged,
							timeline: {
								...ranged.timeline,
								clips: ranged.timeline.clips.map((c) =>
									c.id === clipId ? { ...c, cropRegion: cropRegion ?? undefined } : c,
								),
							},
						};
			await saveDocument(next, { history: true });
		},
		[saveDocument],
	);

	// Background probe: read the asset's actual duration and patch the
	// freshly-inserted clip to use it. Trims if the clip has already been
	// trimmed (sourceEndSec != PLACEHOLDER_DURATION_SEC) so we never stomp
	// on user edits. Also persists the duration back onto the asset so
	// subsequent inserts use the cached value without re-probing.
	const probeAndCorrectClip = useCallback(
		async (assetId: string, clipId: string, originalPath: string) => {
			const fileUrl = toFileUrl(originalPath);
			// Dims probed alongside duration — otherwise `asset.video` stays permanently unset for
			// most recordings (nothing else populates it), silently breaking anything that reads
			// real source dimensions later (e.g. the export dialog's downscale/upscale badges).
			const [probedDuration, probedDims] = await Promise.all([
				probeVideoDuration(fileUrl),
				probeVideoDimensions(fileUrl),
			]);
			const state = useProjectStore.getState();
			const doc = state.document;
			if (!doc) return;
			const asset = doc.assets.find((a) => a.id === assetId);
			const needsDims = probedDims != null && !asset?.video;
			if (probedDuration == null && !needsDims) return;

			// Guard: only correct clips still sitting at the 0..60s placeholder.
			// If the user has since trimmed the clip or moved on, leave it alone.
			const clip = doc.timeline.clips.find((c) => c.id === clipId);
			const stillPlaceholder =
				clip != null &&
				clip.sourceStartSec === 0 &&
				Math.abs((clip.sourceEndSec ?? 0) - PLACEHOLDER_DURATION_SEC) < 0.01;
			const correctDuration = probedDuration != null && stillPlaceholder;
			if (!correctDuration && !needsDims) return;

			// Only correct the probed clip's own length here — do NOT hand-shift
			// every sibling by the delta, since that has no notion of which clips
			// sit before vs. after this one in timeline order (it used to shift
			// earlier clips too, corrupting their positions). resequenceClips lays
			// everything back-to-back from t=0 using each clip's own (now correct)
			// length, so it's the correct + already-shared way to renormalize.
			const oldClips = doc.timeline.clips;
			const nextClips = correctDuration
				? resequenceClips(
						oldClips.map((c) =>
							c.id === clipId
								? {
										...c,
										sourceEndSec: probedDuration as number,
										timelineEndSec: c.timelineStartSec + (probedDuration as number),
									}
								: c,
						),
					)
				: oldClips;
			const nextAssets = doc.assets.map((a) => {
				if (a.id !== assetId) return a;
				return {
					...a,
					...(correctDuration ? { durationSec: probedDuration as number } : {}),
					...(needsDims ? { video: { codec: "unknown", fps: 0, ...a.video, ...probedDims } } : {}),
				};
			});
			// `history: false`. Nothing about this write is a user action: `addAsset` never
			// populates `durationSec`, so EVERY freshly imported asset lands at the 60s
			// placeholder and fires this probe. Recording it put a placeholder-length clip
			// on the undo stack a beat after the drop, so the first Ctrl+Z snapped the clip
			// back to 60s instead of removing it — and a probe resolving after the user
			// had already undone wiped `future`, destroying redo from a background write.
			await state.saveDocument(
				{
					...doc,
					assets: nextAssets,
					timeline: { ...doc.timeline, clips: nextClips },
				},
				{ history: false },
			);
		},
		[],
	);

	// Insert a new full-duration clip for `assetId` at position `index`
	// (0 = before all, clips.length = after all), then resequence.
	//
	// ponytail: probe the file's actual duration via a throwaway <video> in
	// the BACKGROUND so the drop event stays responsive. Earlier this awaited
	// probeVideoDuration synchronously, which could take up to 5s on a slow
	// disk or broken file path — the user saw the UI freeze for the whole
	// probe window with no feedback. Now: insert the clip immediately at the
	// placeholder (60s), then update its sourceEndSec / timelineEndSec when
	// the probe resolves. If the user has since trimmed the clip, we leave it
	// alone (same guard handleLoadedMetadata uses).
	const insertClipAt = useCallback(
		async (assetId: string, index: number) => {
			const currentDoc = useProjectStore.getState().document;
			if (!currentDoc) return;
			const asset = currentDoc.assets.find((a) => a.id === assetId);
			if (!asset) return;
			// Insert immediately at whatever we know. If the asset has a cached
			// durationSec we use it; otherwise we fall back to the placeholder
			// and let the background probe correct it.
			const knownDuration = asset.durationSec ?? PLACEHOLDER_DURATION_SEC;
			const newClip: Clip = {
				id: createId("clip"),
				assetId,
				sourceStartSec: 0,
				sourceEndSec: knownDuration,
				timelineStartSec: 0,
				timelineEndSec: knownDuration,
				wordRefs: [],
				origin: "user",
				reason: "Inserted from media panel",
			};
			const oldClips = currentDoc.timeline.clips;
			const arr = [...oldClips];
			const at = Math.max(0, Math.min(arr.length, index));
			arr.splice(at, 0, newClip);
			const finalDoc = withClipsChanged(currentDoc, arr);
			if (!(await saveDocument(finalDoc, { history: true }))) return;
			setClipSelection(newClip.id);

			// If we used the placeholder, kick off the probe in the background.
			// Don't await — the drop is already responsive; the probe will
			// correct the clip when it lands.
			if (asset.durationSec == null) {
				// Detached on purpose (see above), so it needs its own handler: the probe
				// itself only ever resolves, but it finishes with a `saveDocument`, and
				// that THROWS on a failed write. Losing a background duration correction
				// is survivable — the clip keeps its placeholder length; an unhandled
				// rejection is not.
				void probeAndCorrectClip(assetId, newClip.id, asset.originalPath).catch((err) => {
					console.warn("[timeline] background duration probe failed to save:", err);
				});
			}
		},
		[saveDocument, probeAndCorrectClip],
	);

	// Reorder a clip to a new index, then resequence timeline positions.
	// Delegates to the shared document/timeline.ts implementation — the same
	// function the agent tool-executor uses for "move_clip" ops — so both
	// paths stay in step instead of maintaining two copies of the
	// splice/resequence logic that could drift.
	const moveClip = useCallback(
		async (clipId: string, toIndex: number) => {
			if (!document) return;
			if (!document.timeline.clips.some((c) => c.id === clipId)) return;
			await saveDocument(moveClipInDocument(document, clipId, toIndex), { history: true });
		},
		[document, saveDocument],
	);

	// Duplicate a clip in place (same asset + source range), inserted right
	// after the original, then resequenced. Mirrors Axcut's Ctrl+C/Ctrl+V.
	// Delegates to the shared implementation (see moveClip above).
	const duplicateClip = useCallback(
		async (clipId: string) => {
			if (!document) return;
			if (!document.timeline.clips.some((c) => c.id === clipId)) return;
			// duplicateClipInDocument inserts the copy immediately after the
			// original, so its index in the result is the original's index + 1.
			const insertedIndex = document.timeline.clips.findIndex((c) => c.id === clipId) + 1;
			const next = duplicateClipInDocument(document, clipId, "user", "Duplicated clip");
			if (!(await saveDocument(next, { history: true }))) return;
			setClipSelection(next.timeline.clips[insertedIndex]?.id ?? null);
		},
		[document, saveDocument],
	);

	const removeClip = useCallback(
		async (clipId: string) => {
			if (!document) return;
			// One shared mutator with the agent's removeClip tool: reflow survivors + rederive pills.
			if (!(await saveDocument(removeClipInDocument(document, clipId), { history: true }))) return;
			if (clipSelection === clipId) setClipSelection(null);
		},
		[document, clipSelection, saveDocument],
	);

	// Mirror of selectRegion: picking a clip retires the pill selection.
	const selectClip = useCallback(
		(id: string) => {
			setClipSelection(id);
			setSelection(null);
			setMultiSelection([]);
			setSelectedAudioTrackId(null);
		},
		[setSelectedAudioTrackId],
	);

	// Picking an audio track retires every other selection, same exclusivity rule.
	const selectAudioTrack = useCallback(
		(id: string) => {
			setSelectedAudioTrackId(id);
			setSelection(null);
			setMultiSelection([]);
			setClipSelection(null);
		},
		[setSelectedAudioTrackId],
	);

	const speedRegions = hasDoc
		? readSpeedRegions<{ id: string; startMs: number; endMs: number; speed: number }>(document)
		: [];

	const cameraFullscreenRegions = hasDoc
		? (((document.legacyEditor as Record<string, unknown> | null)
				?.cameraFullscreenRegions as CameraFullscreenRegion[]) ?? [])
		: [];

	// Read through the normaliser: unlike Full Camera rows, a layout row carries nested
	// data (template, slots, rects) that a hand-edited project can get wrong. Memoised so
	// the list keeps its identity between renders of the same document.
	const storedCameraLayouts = (document?.legacyEditor as Record<string, unknown> | null)
		?.cameraLayoutRegions;
	const cameraLayoutRegions = useMemo(
		() => (hasDoc ? normalizeCameraLayoutRegions(storedCameraLayouts) : []),
		[hasDoc, storedCameraLayouts],
	);

	// --- Timeline audio tracks (issue #350) -------------------------------------
	// CLIP-ANCHORED like every region above: one user-visible track is one pill
	// over one-or-more stored fragments, so these ops go through the shared pill
	// helpers and address a track by its group id, never a fragment id.

	// Place a new track for an imported audio asset, its head at the playhead (in
	// RAW/document timeline seconds — the clock the ruler and playhead use, NOT the
	// trim-compressed output programme the export mixes onto) unless the caller says
	// otherwise. Delegates to the store op, which also selects the new track and
	// returns its id (or null). On success, retire the hook-local region/clip
	// selection so the new audio-track selection isn't held CONCURRENTLY with a
	// stale region/clip one.
	const addAudioTrack = useCallback(
		async (
			assetId: string,
			timelineStartSec?: number,
			options?: { kind?: "voiceover" | "music"; durationSec?: number; spanSec?: number },
		): Promise<string | null> => {
			const id = await storeAddAudioTrack(assetId, timelineStartSec ?? playheadSec(), options);
			if (id) {
				setSelection(null);
				setMultiSelection([]);
				setClipSelection(null);
			}
			return id;
		},
		[storeAddAudioTrack],
	);

	// Import an audio file and drop it on the timeline (issue #350). Lives here — not in
	// the timeline toolbar — so the toolbar button and the keyboard shortcut (both call
	// through `tl`) share one path. Opens a file picker, so unlike the region adds it takes
	// no playhead duration; `importAudioAsset` places the track at the current playhead.
	const addAudio = useCallback(async () => {
		try {
			// Inside the try so a rejected picker (an IPC failure, not a cancel) still reaches the
			// localized toast instead of surfacing as an unhandled rejection. A cancel resolves with
			// `success: false` and is a silent early return, not an error.
			const picker = await window.electronAPI?.openAudioFilePicker?.();
			if (!picker?.success || !picker.path) return;
			const label = picker.name || picker.path.split(/[\\/]/).pop() || "Audio";
			const asset = await importAudioAsset(picker.path, label);
			// `importAudioAsset` selects the new track in the store, but the region/clip
			// selections are hook-local state it can't touch — clear them here so an import
			// doesn't leave a stale annotation/clip selected alongside the new track (the same
			// exclusivity `addAudioTrack` keeps). Only on success: a failed import changes nothing.
			if (asset) {
				setSelection(null);
				setMultiSelection([]);
				setClipSelection(null);
			}
		} catch (err) {
			toast.error(ts("audioTrack.importFailed"), {
				description: err instanceof Error ? err.message : String(err),
			});
		}
	}, [importAudioAsset, ts]);

	const removeAudioTrack = useCallback(
		async (trackId: string) => {
			if (!document) return;
			// Clear the inspector selection only AFTER the delete commits. A failed
			// write leaves the track in the document, so it must keep its selection.
			const ok = await saveDocument(removeAudioTrackInDocument(document, trackId), {
				history: true,
			});
			if (ok && selectedAudioTrackId === trackId) setSelectedAudioTrackId(null);
		},
		[document, saveDocument, selectedAudioTrackId, setSelectedAudioTrackId],
	);

	// The commit for a lane drag or edge-resize: move the pill's whole span and
	// re-ventilate it, so a track dragged across a cut becomes the right set of
	// fragments in one write (one undo step). `offsetMs` is preserved as the
	// track's own — `anchorAudioTrackFragments` re-derives each fragment's
	// advance from the new geometry.
	const placeAudioTrack = useCallback(
		async (trackId: string, span: { startMs: number; endMs: number; offsetMs?: number }) => {
			const doc = useProjectStore.getState().document;
			if (!doc) return;
			// The door replaces the whole group, so the survivors no longer need naming here.
			const [pill] = collapseTracksToPills(
				doc.audioTracks.filter((t) => trackGroupId(t) === trackId),
			);
			if (!pill) return;
			const moved = {
				...pill,
				startMs: Math.max(0, Math.round(span.startMs)),
				endMs: Math.max(Math.round(span.startMs) + 1, Math.round(span.endMs)),
				// A left-edge drag is a trim IN: the head moves right and the same
				// amount is skipped in the source, so the audio under the pill stays
				// put instead of sliding with it. Omitted by a plain move, which
				// keeps the offset it already had.
				offsetMs:
					span.offsetMs === undefined ? pill.offsetMs : Math.max(0, Math.round(span.offsetMs)),
			};
			// A resize stops the dragged edge at the neighbour; a move keeps the take's
			// duration and parks it against the wall. Cropping a take because it was
			// dragged somewhere crowded would lose audio the user never asked to lose.
			const next = placeAudioTrackInDocument(
				doc,
				moved,
				() => createId("audio"),
				span.offsetMs === undefined ? "move" : "resize",
			);
			if (next === doc) return;
			await saveDocument(next, { history: true });
		},
		[saveDocument],
	);

	// Payload edits hit every fragment of the track — the halves of a split take
	// must not disagree about gain, mute or loop.
	const updateAudioTrack = useCallback(
		async (
			trackId: string,
			patch: Partial<
				Pick<AxcutAudioTrack, "gainDb" | "muted" | "loop" | "fadeInMs" | "fadeOutMs" | "offsetMs">
			>,
		) => {
			const doc = useProjectStore.getState().document;
			if (!doc) return;
			await saveDocument(patchAudioTrack(doc, trackId, patch), { history: true });
		},
		[saveDocument],
	);

	// Turning loop ON fills the rest of the programme with the track.
	//
	// Looping only means anything when the span EXCEEDS the source, so a toggle
	// that changed nothing else did nothing at all — the user had to know to then
	// drag the pill's right edge out, which is not a thing anyone guesses. Filling
	// is what "loop" is for, it is one undo away, and the edge still trims it back
	// to any length. Turning loop OFF deliberately leaves the span alone: shrinking
	// it would throw away a length the user may have set by hand.
	const setAudioTrackLoop = useCallback(
		async (trackId: string, loop: boolean) => {
			const doc = useProjectStore.getState().document;
			if (!doc) return;
			const fragments = doc.audioTracks.filter((t) => trackGroupId(t) === trackId);
			const [pill] = collapseTracksToPills(fragments);
			if (!pill) return;
			// Refused on a voiceover. `anchorAudioTrackFragments` does not advance `offsetMs`
			// across a looping track's fragments, so its words map to raw moments they do not
			// occupy — the transcript lane drops it, and a cut authored from it would land in
			// the wrong place. Music loops; narration does not (issue #560).
			if (loop && pill.kind === "voiceover") return;
			const programmeEndMs = Math.round(
				doc.timeline.clips.reduce((max, c) => Math.max(max, c.timelineEndSec), 0) * 1000,
			);
			// One write, so the fill and the flag are a single undo step.
			const patched = patchAudioTrack(doc, trackId, { loop });
			if (!loop || programmeEndMs <= pill.endMs) {
				await saveDocument(patched, { history: true });
				return;
			}
			// The fill stops at the next pill of its own kind, not at the programme end: a
			// bed filling the timeline must not swallow a second bed that comes after it.
			const filled = placeAudioTrackInDocument(
				patched,
				{ ...pill, loop, endMs: programmeEndMs },
				() => createId("audio"),
				"resize",
			);
			await saveDocument(filled === patched ? patched : filled, { history: true });
		},
		[saveDocument],
	);

	const setAudioTrackGain = useCallback(
		async (trackId: string, gainDb: number) => {
			await updateAudioTrack(trackId, { gainDb });
		},
		[updateAudioTrack],
	);

	const cameraSettings = useMemo(
		() =>
			normalizeCameraSettings(
				(document?.legacyEditor as Record<string, unknown> | null)?.cameraSettings,
			),
		[document?.legacyEditor],
	);

	// Desk sections, read through the normaliser and memoised like the layout rows.
	const storedDeskRegions = (document?.legacyEditor as Record<string, unknown> | null)?.deskRegions;
	const deskRegions = useMemo(
		() => (hasDoc ? normalizeDeskRegions(storedDeskRegions) : []),
		[hasDoc, storedDeskRegions],
	);
	const deskCamera = document ? deskCameraOf(document) : null;
	const deskCameraChosen = chosenDeskCamera(
		(document?.legacyEditor as Record<string, unknown> | null) ?? {},
	);

	return {
		zoomRegions: document?.zoomRanges ?? [],
		trimRanges: document?.timeline.trimRanges ?? [],
		audioTracks: document?.audioTracks ?? [],
		// The pauses added words created. The ruler counts them; nothing else in the
		// timeline store writes them (see `document/transcript.ts`).
		annotationRegions: (document?.annotations ?? []) as unknown as AnnotationRegion[],
		speedRegions,
		cameraFullscreenRegions,
		cameraLayoutRegions,
		deskRegions,
		deskCamera,
		deskCameraChosen,
		clips: document?.timeline.clips ?? [],
		assets: document?.assets ?? [],
		// The timeline marks where the user has ADDED words — text with no audio behind it.
		// Read straight off the transcript: the word is the only record of an insert, and a
		// mark derived from it can never disagree with the pane that shows the same word.
		transcripts: document?.transcripts ?? [],
		hasDoc,
		selection,
		multiSelection,
		clipSelection,
		addZoom,
		addZoomsBulk,
		addTrim,
		addAnnotation,
		addSpeed,
		addCameraFullscreen,
		addCameraLayout,
		addDeskSection,
		removeRegion,
		removeRegions,
		hasEditRegions,
		clearTimeline,
		addAudioTrack,
		addAudio,
		removeAudioTrack,
		updateAudioTrack,
		setAudioTrackLoop,
		placeAudioTrack,
		setAudioTrackGain,
		selectedAudioTrackId,
		selectAudioTrack,
		selectRegion,
		clearSelection,
		applyClipEdit,
		insertClipAt,
		moveClip,
		duplicateClip,
		removeClip,
		selectClip,
		updateTrim,
		setTrimEntries,
		updateZoomSpan,
		updateZoomFocusLive,
		commitZoomFocus,
		updateZoomDepth,
		updateZoomCustomScale,
		updateZoomRotation,
		updateZoomFocusMode,
		updateZoomHideCursor,
		updateAnnotationSpan,
		updateAnnotationLive,
		commitAnnotationChange,
		updateSpeedSpan,
		updateSpeedValue,
		updateCameraFullscreenOrientation,
		updateCameraFullscreenDeskLabel,
		setCameraSettings,
		cameraSettings,
		updateCameraFullscreenSpan,
		updateCameraLayoutSpan,
		updateDeskSpan,
		updateDeskLabel,
		setDeskCamera,
		setLayoutTemplate,
		setLayoutSlotCamera,
		updateLayoutSlotRectLive,
		commitLayoutSlotRect,
		resetLayoutSlotRects,
		// T19 — drives the preview video during trim-edge resize.
		setCurrentTime: useProjectStore((s) => s.setCurrentTime),
	};
}
