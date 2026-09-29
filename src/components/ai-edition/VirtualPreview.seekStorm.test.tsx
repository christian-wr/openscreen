// @vitest-environment jsdom
import "@testing-library/jest-dom";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AxcutClip } from "@/lib/ai-edition/schema";
import {
	PRIMARY_AUDIO_PLAYING_LEASH_SEC,
	SUPPLEMENTAL_AUDIO_PLAYING_LEASH_SEC,
	shouldResyncAudio,
	type VideoSource,
	VirtualPreview,
} from "./VirtualPreview";

// The root cause of issue #395, in a test.
//
// Dragging the playhead publishes a new time every rAF, the shell mints a
// seekTarget per publish, and this component used to turn each one into a
// `currentTime` write — ~60 demuxer seeks a second on a 1080p H.264 file the
// native compositor is decoding at the same time. Chromium eventually fails
// one (`PIPELINE_ERROR_READ: FFmpegDemuxer: demuxer seek failed`, observed on a
// file ffmpeg decodes end to end without a defect), and on main any media error
// emptied the editor.

afterEach(cleanup);

const SOURCES: VideoSource[] = [{ id: "a1", src: "file:///tmp/a1.mp4", label: "a1" }];
const CLIPS: AxcutClip[] = [
	{
		id: "clip_1",
		assetId: "a1",
		sourceStartSec: 0,
		sourceEndSec: 10,
		timelineStartSec: 0,
		timelineEndSec: 10,
		wordRefs: [],
		origin: "user",
		reason: "",
	},
];

/** A `<video>` that behaves like a real one on the only axis this file tests:
 *  a `currentTime` write starts a seek, and the element stays `seeking` until
 *  the browser says otherwise. */
function driveVideo(element: HTMLVideoElement) {
	let currentTime = 0;
	let seeking = false;
	const writes: number[] = [];
	Object.defineProperty(element, "currentTime", {
		configurable: true,
		get: () => currentTime,
		set: (next: number) => {
			currentTime = next;
			seeking = true;
			writes.push(next);
		},
	});
	Object.defineProperty(element, "seeking", { configurable: true, get: () => seeking });
	Object.defineProperty(element, "paused", { configurable: true, get: () => true });
	Object.defineProperty(element, "readyState", { configurable: true, get: () => 4 });
	Object.defineProperty(element, "duration", { configurable: true, get: () => 10 });
	element.play = vi.fn(() => Promise.resolve());
	element.pause = vi.fn();
	return {
		writes,
		get currentTime() {
			return currentTime;
		},
		/** What the browser does when the demuxer is done. */
		finishSeek: () => {
			seeking = false;
			act(() => {
				fireEvent.seeked(element);
			});
		},
	};
}

function mount() {
	let requestId = 0;
	const tree = (seekTarget: { timeSec: number; requestId: number } | null) => (
		<VirtualPreview videoSources={SOURCES} clips={CLIPS} seekTarget={seekTarget} />
	);
	const view = render(tree(null));
	const element = view.container.querySelector("video");
	if (!element) throw new Error("no <video> rendered");
	const video = driveVideo(element as HTMLVideoElement);
	act(() => {
		fireEvent.loadedMetadata(element);
	});
	video.writes.length = 0;
	return {
		video,
		/** One rAF-throttled scrub publish, the way the shell emits them. */
		scrubTo: (timeSec: number) =>
			act(() => {
				requestId += 1;
				view.rerender(tree({ timeSec, requestId }));
			}),
	};
}

describe("VirtualPreview keeps one demuxer seek in flight (issue #395 root cause)", () => {
	it("does not stack a seek onto an element that is still seeking", () => {
		const { video, scrubTo } = mount();

		scrubTo(2);
		expect(video.writes).toEqual([2]); // demuxer busy from here

		scrubTo(4);
		scrubTo(6);
		scrubTo(8);

		// Three more scrub publishes, no extra seeks: this is the storm that made
		// the demuxer fail.
		expect(video.writes).toEqual([2]);
	});

	it("applies the newest target once the demuxer is free, not the queued ones", () => {
		const { video, scrubTo } = mount();

		scrubTo(2);
		scrubTo(4);
		scrubTo(6);
		scrubTo(8);

		video.finishSeek();

		// The last position the user asked for — the intermediate ones were never
		// destinations, and replaying them would be the storm again, delayed.
		expect(video.writes).toEqual([2, 8]);
		expect(video.currentTime).toBe(8);
	});

	it("stops seeking once the playhead settles", () => {
		const { video, scrubTo } = mount();

		scrubTo(5);
		video.finishSeek();
		expect(video.writes).toEqual([5]);

		// The drag ended on the position already reached: nothing more to do.
		scrubTo(5);
		video.finishSeek();
		expect(video.writes).toEqual([5]);
	});

	it("still serves an ordinary seek immediately when nothing is in flight", () => {
		const { video, scrubTo } = mount();

		scrubTo(3);
		video.finishSeek();
		scrubTo(7);

		expect(video.writes).toEqual([3, 7]);
	});
});

describe("the primary audio element free-runs instead of being re-seeked every frame", () => {
	// Measured in the shipped editor on a Snapdragon X Elite, during ordinary playback:
	// 157 `seeking` events in 20 s with a single `seeked`, and 87 `currentTime` writes in
	// 15 s — about six a second. Each write stepped forward by ~0.1 s, which is exactly the
	// time that had passed: the audio was being sent to where it already was heading.
	//
	// The 25 ms leash assumed the rAF tick runs tight against the <video>'s own clock. It
	// does not when the renderer main thread is loaded (measured ~44 % blocked during
	// playback): ticks land 100+ ms apart, the audio element has free-run past 25 ms by
	// then, and gets yanked back. The yank stalls it, so it falls behind again — the storm
	// sustains itself, which is why the drift sat at a steady ~100 ms instead of decaying.
	it("leaves a playing element alone at the drift the storm was measured at", () => {
		expect(shouldResyncAudio(0.1, true, PRIMARY_AUDIO_PLAYING_LEASH_SEC)).toBe(false);
		expect(shouldResyncAudio(-0.1, true, PRIMARY_AUDIO_PLAYING_LEASH_SEC)).toBe(false);
	});

	it("still corrects a real desync", () => {
		expect(shouldResyncAudio(0.4, true, PRIMARY_AUDIO_PLAYING_LEASH_SEC)).toBe(true);
		expect(shouldResyncAudio(-0.4, true, PRIMARY_AUDIO_PLAYING_LEASH_SEC)).toBe(true);
	});

	// A parked element is not free-running, so nothing sustains its position: it has to be
	// placed exactly, and placing it costs nothing because it is not playing.
	it("keeps the tight leash when the element is not free-running", () => {
		expect(shouldResyncAudio(0.05, false, PRIMARY_AUDIO_PLAYING_LEASH_SEC)).toBe(true);
		expect(shouldResyncAudio(0.01, false, PRIMARY_AUDIO_PLAYING_LEASH_SEC)).toBe(false);
	});

	// The same discipline the video path learned in issue #395: a write onto an element
	// that is already seeking restarts the seek instead of finishing it, so the element
	// never arrives. Measured after the leash change alone, residual writes still landed
	// on an element mid-seek.
	it("never stacks a write onto an element that is already seeking", () => {
		expect(shouldResyncAudio(5, true, PRIMARY_AUDIO_PLAYING_LEASH_SEC, true)).toBe(false);
		expect(shouldResyncAudio(5, false, PRIMARY_AUDIO_PLAYING_LEASH_SEC, true)).toBe(false);
		expect(shouldResyncAudio(5, true, PRIMARY_AUDIO_PLAYING_LEASH_SEC, false)).toBe(true);
	});

	// Lip sync is the constraint the primary track has and an imported one does not, so it
	// gets the shorter leash of the two. Audio behind picture is tolerated to about 125 ms
	// before it reads as out of sync, which is the ceiling this has to stay under.
	it("gives the primary track a shorter leash than an imported one", () => {
		expect(PRIMARY_AUDIO_PLAYING_LEASH_SEC).toBeLessThan(SUPPLEMENTAL_AUDIO_PLAYING_LEASH_SEC);
		expect(PRIMARY_AUDIO_PLAYING_LEASH_SEC).toBeLessThan(0.125);
	});
});
