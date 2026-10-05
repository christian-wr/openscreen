// @vitest-environment jsdom
import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AxcutDocument } from "@/lib/ai-edition/schema";

vi.mock("@/contexts/I18nContext", () => ({
	useScopedT: (scope: string) => (key: string, vars?: Record<string, string | number>) =>
		vars?.n !== undefined ? `${scope}.${key}#${vars.n}` : `${scope}.${key}`,
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
		expect(screen.getByTestId("camera-row-1")).toHaveTextContent("Desk");
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
			vars?.n !== undefined ? `${key}#${vars.n}` : key;
		const doc = makeDoc(1);
		const desk = calibrationCameraAt(doc, 2, 1, t);
		expect(desk).toMatchObject({ index: 1, label: "Desk", timeSec: 2 });
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
