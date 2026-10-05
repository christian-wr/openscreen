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

import { CamerasSection } from "./CamerasSection";

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
});
