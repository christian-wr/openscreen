// @vitest-environment jsdom
import "@testing-library/jest-dom";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AxcutDocument } from "@/lib/ai-edition/schema";

vi.mock("@/contexts/I18nContext", () => ({
	useScopedT: (scope: string) => (key: string, vars?: Record<string, string | number>) =>
		vars?.n !== undefined
			? `${scope}.${key}#${vars.n}${vars.label ? `|${vars.label}` : ""}`
			: `${scope}.${key}`,
}));
vi.mock("@/lib/ai-edition/timeline/grabFrame", () => ({
	grabFrameDataUrl: vi.fn(() => Promise.resolve("data:image/png;base64,AAAA")),
}));

import { readFileSync } from "node:fs";
import { act } from "@testing-library/react";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import { grabFrameDataUrl } from "@/lib/ai-edition/timeline/grabFrame";
import { CamerasSection, calibrationCameraAt, cameraHasCrop } from "./CamerasSection";

const track = (sourcePath: string, extra: Record<string, unknown> = {}) => ({
	sourcePath,
	visible: true,
	startMs: 0,
	offsetMs: 0,
	...extra,
});

function makeDoc(extraCameras: number): AxcutDocument {
	return {
		assets: [
			{
				id: "a1",
				cameraTrack: track("C:/cam1.mp4"),
				additionalCameraTracks: Array.from({ length: extraCameras }, (_, i) =>
					track(`C:/cam${i + 2}.mp4`, { label: i === 0 ? "Desk" : "" }),
				),
			},
		],
		timeline: {
			clips: [
				{
					id: "c1",
					assetId: "a1",
					sourceStartSec: 0,
					sourceEndSec: 10,
					timelineStartSec: 0,
					timelineEndSec: 10,
				},
			],
		},
	} as unknown as AxcutDocument;
}

const render2 = (extra: number, setCameraSettings = vi.fn(), onOpenCalibration = vi.fn()) => {
	render(
		<CamerasSection
			document={makeDoc(extra)}
			playheadSec={2}
			cameraSettings={[]}
			setCameraSettings={setCameraSettings}
			onOpenCalibration={onOpenCalibration}
		/>,
	);
	return { setCameraSettings, onOpenCalibration };
};

describe("CamerasSection", () => {
	it("lists every camera of the clip", () => {
		render2(2);
		expect(screen.getByTestId("camera-row-0")).toHaveTextContent("settings.cameras.cameraN#1");
		expect(screen.getByTestId("camera-row-1")).toHaveTextContent(
			"settings.cameras.cameraNamed#2|Desk",
		);
		expect(screen.getByTestId("camera-row-2")).toHaveTextContent("settings.cameras.cameraN#3");
	});

	it("camera 1 offers only the perspective", () => {
		const { onOpenCalibration } = render2(1);
		const row = screen.getByTestId("camera-row-0");
		expect(row).toHaveTextContent("settings.cameras.camera1Hint");
		expect(row.querySelectorAll("button")).toHaveLength(1);
		fireEvent.click(row.querySelector("button") as Element);
		expect(onOpenCalibration).toHaveBeenCalledWith(0, "perspective");
	});

	it("rotating camera 2 calls setCameraSettings", () => {
		const { setCameraSettings, onOpenCalibration } = render2(1);
		const row = screen.getByTestId("camera-row-1");
		fireEvent.click(
			row.querySelector("button[aria-pressed]:not([aria-pressed='true'])") as Element,
		);
		expect(setCameraSettings).toHaveBeenCalledWith(1, { rotation: 180 });
		const buttons = Array.from(row.querySelectorAll("button"));
		fireEvent.click(buttons.find((b) => b.textContent === "settings.cameras.crop") as Element);
		expect(onOpenCalibration).toHaveBeenCalledWith(1, "crop");
	});

	it("follows the playhead from the store without a prop", async () => {
		vi.useFakeTimers();
		useProjectStore.setState({ currentTimeSec: 1 });
		render(
			<CamerasSection document={makeDoc(0)} cameraSettings={[]} setCameraSettings={vi.fn()} />,
		);
		act(() => {
			useProjectStore.setState({ currentTimeSec: 4 });
		});
		act(() => {
			vi.advanceTimersByTime(300);
		});
		expect(vi.mocked(grabFrameDataUrl).mock.calls.at(-1)?.[1]).toBe(4);
		vi.useRealTimers();
	});

	it("keeps the playhead subscription out of LayoutPane", () => {
		const source = readFileSync("src/components/ai-edition/RightPanes.tsx", "utf8");
		const start = source.indexOf("export function LayoutPane(");
		const end = source.indexOf("/** The tightest the frame gets");
		expect(source.slice(start, end)).not.toContain("currentTimeSec");
	});

	it("finds the calibration still of a camera at the playhead", () => {
		const t = (key: string, vars?: Record<string, string | number>) =>
			vars?.n !== undefined ? `${key}#${vars.n}${vars.label ? `|${vars.label}` : ""}` : key;
		const doc = makeDoc(1);
		const desk = calibrationCameraAt(doc, 2, 1, t);
		expect(desk).toMatchObject({ index: 1, label: "cameras.cameraNamed#2|Desk", timeSec: 2 });
		expect(desk?.src).toMatch(/^file:\/\/.*cam2\.mp4$/);
		expect(calibrationCameraAt(doc, 2, 0, t)?.label).toBe("cameras.cameraN#1");
		// No such camera, or no document: nothing to calibrate.
		expect(calibrationCameraAt(doc, 2, 3, t)).toBeNull();
		expect(calibrationCameraAt(null, 2, 0, t)).toBeNull();
	});

	it("a perspective disables the crop with a hint", () => {
		const onOpenCalibration = vi.fn();
		render(
			<CamerasSection
				document={makeDoc(1)}
				playheadSec={2}
				cameraSettings={[
					null,
					{
						perspective: {
							corners: [
								{ x: 0.1, y: 0.1 },
								{ x: 0.9, y: 0.1 },
								{ x: 0.9, y: 0.9 },
								{ x: 0.1, y: 0.9 },
							],
							aspect: 1.5,
						},
					},
				]}
				setCameraSettings={vi.fn()}
				onOpenCalibration={onOpenCalibration}
			/>,
		);
		const row = screen.getByTestId("camera-row-1");
		const crop = screen.getByRole("button", { name: "settings.cameras.crop" });
		expect(crop).toBeDisabled();
		expect(row).toHaveTextContent("settings.cameras.cropOffWithPerspective");
		fireEvent.click(crop);
		expect(onOpenCalibration).not.toHaveBeenCalled();
	});

	it("without a perspective the crop stays available and no hint shows", () => {
		render2(1);
		expect(screen.getByRole("button", { name: "settings.cameras.crop" })).toBeEnabled();
		expect(screen.queryByText("settings.cameras.cropOffWithPerspective")).toBeNull();
	});

	it("knows whether a camera has a crop", () => {
		const crop = { x: 0.1, y: 0.1, width: 0.5, height: 0.5 };
		expect(cameraHasCrop(null, [null, { crop }], 1)).toBe(true);
		expect(cameraHasCrop(null, [null, { mirror: true }], 1)).toBe(false);
		const withCamera1Crop = (webcamCropRegion: unknown) =>
			({ legacyEditor: { webcamCropRegion } }) as unknown as AxcutDocument;
		expect(cameraHasCrop(withCamera1Crop(crop), [], 0)).toBe(true);
		expect(cameraHasCrop(withCamera1Crop({ x: 0, y: 0, width: 1, height: 1 }), [], 0)).toBe(false);
		expect(cameraHasCrop(makeDoc(0), [], 0)).toBe(false);
	});
});

describe("CamerasSection with a main camera", () => {
	it("gives camera 1 its own controls and the main camera the note", () => {
		const setCameraSettings = vi.fn();
		const onOpenCalibration = vi.fn();
		render(
			<CamerasSection
				document={makeDoc(2)}
				playheadSec={2}
				cameraSettings={[{ mirror: true }]}
				setCameraSettings={setCameraSettings}
				onOpenCalibration={onOpenCalibration}
				mainCamera={2}
			/>,
		);
		const first = screen.getByTestId("camera-row-0");
		expect(first).not.toHaveTextContent("settings.cameras.camera1Hint");
		fireEvent.click(
			first.querySelector("button[aria-pressed]:not([aria-pressed='true'])") as Element,
		);
		expect(setCameraSettings).toHaveBeenCalledWith(0, { rotation: 180 });
		fireEvent.click(within(first).getByRole("button", { name: "settings.cameras.mirror" }));
		expect(setCameraSettings).toHaveBeenCalledWith(0, { mirror: false });
		fireEvent.click(within(first).getByRole("button", { name: "settings.cameras.crop" }));
		expect(onOpenCalibration).toHaveBeenCalledWith(0, "crop");
		fireEvent.click(within(first).getByRole("button", { name: "settings.cameras.reset" }));
		expect(setCameraSettings).toHaveBeenCalledWith(0, null);

		const main = screen.getByTestId("camera-row-2");
		expect(main).toHaveTextContent("settings.cameras.camera1Hint");
		expect(main.querySelectorAll("button")).toHaveLength(1);
		fireEvent.click(main.querySelector("button") as Element);
		expect(onOpenCalibration).toHaveBeenCalledWith(2, "perspective");
	});

	it("reads the main camera's crop from the layout pane's field", () => {
		const crop = { x: 0.1, y: 0.1, width: 0.5, height: 0.5 };
		const withLegacyCrop = { legacyEditor: { webcamCropRegion: crop } } as unknown as AxcutDocument;
		expect(cameraHasCrop(withLegacyCrop, [], 2, 2)).toBe(true);
		expect(cameraHasCrop(withLegacyCrop, [], 0, 2)).toBe(false);
		expect(cameraHasCrop(null, [{ crop }], 0, 2)).toBe(true);
	});
});

describe("CamerasSection desk camera", () => {
	const renderDesk = (
		camera: number | null,
		chosen: number | null,
		extra = 1,
		document: AxcutDocument = makeDoc(extra),
	) => {
		const setDeskCamera = vi.fn();
		render(
			<CamerasSection
				document={document}
				playheadSec={2}
				cameraSettings={[]}
				setCameraSettings={vi.fn()}
				desk={{ camera, chosen, setDeskCamera }}
			/>,
		);
		const radioOf = (index: number) =>
			within(screen.getByTestId(`camera-row-${index}`)).getByRole("radio");
		return { setDeskCamera, radioOf };
	};

	// One choice among the cameras: radios in one named group, each named after its camera.
	it("offers the desk camera as one radio group, each radio named after its camera", () => {
		renderDesk(1, null);
		const group = screen.getByRole("radiogroup", { name: "settings.cameras.deskCamera" });
		const radios = within(group).getAllByRole("radio");
		expect(radios).toHaveLength(2);
		expect(
			screen.getByRole("radio", {
				name: "settings.cameras.deskCamera – settings.cameras.cameraN#1",
			}),
		).toBe(radios[0]);
		expect(
			screen.getByRole("radio", {
				name: "settings.cameras.deskCamera – settings.cameras.cameraNamed#2|Desk",
			}),
		).toBe(radios[1]);
	});

	it("marks the resolved desk camera and says when it was picked automatically", () => {
		const { radioOf } = renderDesk(1, null);
		expect(radioOf(0)).toHaveAttribute("aria-checked", "false");
		expect(radioOf(1)).toHaveAttribute("aria-checked", "true");
		expect(screen.getByTestId("camera-row-1")).toHaveTextContent("settings.cameras.deskCameraAuto");
		expect(screen.getByTestId("camera-row-0")).not.toHaveTextContent(
			"settings.cameras.deskCameraAuto",
		);
	});

	it("picks camera 2 as the desk camera", () => {
		const { setDeskCamera, radioOf } = renderDesk(1, null);
		fireEvent.click(radioOf(1));
		expect(setDeskCamera).toHaveBeenCalledWith(1);
	});

	it("a click on the chosen desk camera lifts the choice", () => {
		const { setDeskCamera, radioOf } = renderDesk(1, 1);
		expect(screen.queryByText("settings.cameras.deskCameraAuto")).toBeNull();
		fireEvent.click(radioOf(1));
		expect(setDeskCamera).toHaveBeenCalledWith(null);
	});

	// The chosen camera is not in the project (file lost): the one shown is automatic again.
	it("marks the fallback as automatic when the chosen desk camera is gone", () => {
		const { radioOf } = renderDesk(1, 5);
		expect(radioOf(1)).toHaveAttribute("aria-checked", "true");
		expect(screen.getByTestId("camera-row-1")).toHaveTextContent("settings.cameras.deskCameraAuto");
	});

	it("camera 1 can be the desk camera", () => {
		const { setDeskCamera, radioOf } = renderDesk(1, null);
		fireEvent.click(radioOf(0));
		expect(setDeskCamera).toHaveBeenCalledWith(0);
	});

	// A hidden camera draws nothing: it is not offered, unless it is the stored choice to lift.
	it("does not offer an unavailable camera as the desk camera", () => {
		const doc = makeDoc(2);
		const hidden = {
			...doc,
			assets: doc.assets.map((a) => ({
				...a,
				additionalCameraTracks: (a.additionalCameraTracks ?? []).map((t, i) =>
					i === 0 ? { ...t, visible: false } : t,
				),
			})),
		} as AxcutDocument;
		const { radioOf } = renderDesk(2, null, 2, hidden);
		expect(radioOf(1)).toBeDisabled();
		expect(radioOf(2)).toBeEnabled();
		cleanup();
		const lifted = renderDesk(2, 1, 2, hidden);
		expect(lifted.radioOf(1)).toBeEnabled();
		fireEvent.click(lifted.radioOf(1));
		expect(lifted.setDeskCamera).toHaveBeenCalledWith(null);
	});

	it("offers no desk choice to a one-camera project", () => {
		renderDesk(null, null, 0);
		expect(screen.queryByRole("radio")).toBeNull();
		expect(screen.queryByRole("radiogroup")).toBeNull();
	});
});

// The desk pane's "Change" finds the section by this marker to scroll it into view.
it("marks the Cameras section for the desk pane's 'Change'", () => {
	render(
		<CamerasSection
			document={makeDoc(1)}
			playheadSec={2}
			cameraSettings={[]}
			setCameraSettings={vi.fn()}
		/>,
	);
	expect(screen.getByTestId("cameras-section")).toHaveTextContent("settings.cameras.title");
});
