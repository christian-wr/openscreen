// @vitest-environment jsdom
import "@testing-library/jest-dom";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { CameraLayoutRegion } from "@/components/video-editor/types";
import type { CameraSectionHandle } from "@/lib/ai-edition/store/useTimeline";
import type { ProjectCamera } from "@/lib/ai-edition/timeline/cameraList";

vi.mock("@/contexts/I18nContext", () => ({
	useScopedT: (scope: string) => (key: string) => `${scope}.${key}`,
}));

vi.mock("../RightPanes", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../RightPanes")>();
	return { ChoiceRow: actual.ChoiceRow, Toggle: actual.Toggle };
});

import { LayoutSectionPane } from "./LayoutSectionPane";

const camera = (index: number, available = true): ProjectCamera => ({
	index,
	label: `Cam ${index + 1}`,
	path: available ? `/c${index}.mp4` : "",
	available,
});

function setup(region: Partial<CameraLayoutRegion>, cameras: ProjectCamera[], blockPreset = false) {
	const tl = {
		setLayoutTemplate: vi.fn(async (handle: CameraSectionHandle) => handle),
		setLayoutSlotCamera: vi.fn(async (handle: CameraSectionHandle) => handle),
		resetLayoutSlotRects: vi.fn(async () => undefined),
		removeRegion: vi.fn(async () => undefined),
		selectRegion: vi.fn(),
	};
	const full: CameraLayoutRegion = {
		id: "L1",
		startMs: 0,
		endMs: 2000,
		template: "side-by-side",
		slots: [{ camera: 0 }, { camera: 1 }],
		...region,
	};
	const setSectionCameras = vi.fn(async () => "set" as const);
	render(
		<LayoutSectionPane
			tl={tl}
			region={full}
			cameras={cameras}
			blockPreset={blockPreset}
			setSectionCameras={setSectionCameras}
			onClose={vi.fn()}
		/>,
	);
	return Object.assign(tl, { setSectionCameras });
}

describe("LayoutSectionPane", () => {
	it("shows one camera select per place", () => {
		setup({}, [camera(0), camera(1), camera(2)]);
		expect(screen.getAllByRole("combobox")).toHaveLength(2);
		expect(screen.getByRole("combobox", { name: "settings.cameraLayout.placeLeft" })).toHaveValue(
			"0",
		);
		expect(screen.getByRole("combobox", { name: "settings.cameraLayout.placeRight" })).toHaveValue(
			"1",
		);
	});

	it("choosing a template calls setLayoutTemplate", async () => {
		const tl = setup({}, [camera(0), camera(1), camera(2)]);
		fireEvent.click(screen.getByRole("button", { name: /timeline\.labels\.layoutCameraFullPip/ }));
		expect(tl.setLayoutTemplate).toHaveBeenCalledWith(
			{ kind: "cameraLayout", id: "L1" },
			"camera-full-pip",
			[0, 1, 2],
		);
		// The returned handle is the same section: the selection stays.
		await waitFor(() => expect(tl.setLayoutTemplate).toHaveBeenCalledTimes(1));
		expect(tl.selectRegion).not.toHaveBeenCalled();
	});

	it("moves the selection to the handle a change returns", async () => {
		const tl = setup({}, [camera(0), camera(1)]);
		tl.setLayoutSlotCamera.mockResolvedValueOnce({ kind: "cameraFullscreen", id: "F1" });
		fireEvent.change(screen.getByRole("combobox", { name: "settings.cameraLayout.placeLeft" }), {
			target: { value: "1" },
		});
		expect(tl.setLayoutSlotCamera).toHaveBeenCalledWith({ kind: "cameraLayout", id: "L1" }, 0, 1);
		await waitFor(() => expect(tl.selectRegion).toHaveBeenCalledWith("cameraFullscreen", "F1"));
	});

	it("a slot whose camera is gone shows as unavailable", () => {
		setup({ slots: [{ camera: 0 }, { camera: 1 }] }, [camera(0), camera(1, false)]);
		const select = screen.getByRole("combobox", { name: "settings.cameraLayout.placeRight" });
		expect(select).toHaveValue("1");
		expect(
			screen.getAllByRole("option", { name: "settings.cameraLayout.cameraUnavailable" }),
		).not.toHaveLength(0);
	});

	it("side-by-side is disabled with one camera", () => {
		setup({ template: "camera-full", slots: [{ camera: 0 }] }, [camera(0)]);
		const button = screen.getByRole("button", { name: /timeline\.labels\.layoutSideBySide/ });
		expect(button).toBeDisabled();
		expect(screen.getByText("timeline.layoutMenu.needsCamerasHint")).toBeInTheDocument();
	});

	it("pip templates are disabled under dual-frame", () => {
		setup({}, [camera(0), camera(1)], true);
		expect(
			screen.getByRole("button", { name: /timeline\.labels\.layoutScreenPip/ }),
		).toBeDisabled();
		expect(
			screen.getByRole("button", { name: /timeline\.labels\.layoutCameraFullPip/ }),
		).toBeDisabled();
		expect(
			screen.getByRole("button", { name: /timeline\.labels\.layoutCameraFull$/ }),
		).toBeEnabled();
		expect(screen.getByText("timeline.layoutMenu.blockLayoutHint")).toBeInTheDocument();
	});

	it("resets the windows only when a place has its own rect", () => {
		const tl = setup(
			{ slots: [{ camera: 0 }, { camera: 1, rect: { x: 0, y: 0, width: 0.3, height: 0.3 } }] },
			[camera(0), camera(1)],
		);
		const reset = screen.getByRole("button", { name: "settings.cameraLayout.resetWindows" });
		expect(reset).toBeEnabled();
		fireEvent.click(reset);
		expect(tl.resetLayoutSlotRects).toHaveBeenCalledWith("L1");
	});

	describe("screen + camera", () => {
		const pip = (cams: number[]) => ({
			template: "screen-pip" as const,
			slots: cams.map((c) => ({ camera: c })),
		});

		it("shows one switch per camera, named like the Cameras section, instead of the selects", () => {
			setup(pip([0]), [camera(0), camera(1), camera(2)]);
			expect(screen.queryAllByRole("combobox")).toHaveLength(0);
			expect(screen.getByText("settings.cameras.title")).toBeInTheDocument();
			expect(screen.getByRole("button", { name: "Cam 1" })).toHaveAttribute("aria-pressed", "true");
			expect(screen.getByRole("button", { name: "Cam 2" })).toHaveAttribute(
				"aria-pressed",
				"false",
			);
			expect(screen.getByRole("button", { name: "Cam 3" })).toHaveAttribute(
				"aria-pressed",
				"false",
			);
		});

		it("switching a camera on writes the set with it added", () => {
			const tl = setup(pip([2]), [camera(0), camera(1), camera(2)]);
			fireEvent.click(screen.getByRole("button", { name: "Cam 1" }));
			expect(tl.setSectionCameras).toHaveBeenCalledWith({ kind: "cameraLayout", id: "L1" }, [2, 0]);
		});

		it("switching a camera off writes the set without it", () => {
			const tl = setup(pip([0, 1]), [camera(0), camera(1)]);
			fireEvent.click(screen.getByRole("button", { name: "Cam 1" }));
			expect(tl.setSectionCameras).toHaveBeenCalledWith({ kind: "cameraLayout", id: "L1" }, [1]);
		});

		it("the only camera on is locked, with the reason", () => {
			setup(pip([1]), [camera(0), camera(1)]);
			expect(screen.getByRole("button", { name: "Cam 2" })).toBeDisabled();
			expect(screen.getByRole("button", { name: "Cam 1" })).toBeEnabled();
			expect(screen.getByText("settings.layoutSection.minOneCamera")).toBeInTheDocument();
		});

		it("with three on, the others are locked, with the reason", () => {
			setup(pip([0, 1, 2]), [camera(0), camera(1), camera(2), camera(3)]);
			expect(screen.getByRole("button", { name: "Cam 4" })).toBeDisabled();
			expect(screen.getByRole("button", { name: "Cam 1" })).toBeEnabled();
			expect(screen.getByText("settings.layoutSection.maxThreeWindows")).toBeInTheDocument();
			expect(screen.queryByText("settings.layoutSection.minOneCamera")).not.toBeInTheDocument();
		});

		it("with three on and no camera left off, the cap is not mentioned", () => {
			setup(pip([0, 1, 2]), [camera(0), camera(1), camera(2)]);
			expect(screen.queryByText("settings.layoutSection.maxThreeWindows")).not.toBeInTheDocument();
		});

		it("an unavailable camera that is off is locked", () => {
			setup(pip([0]), [camera(0), camera(1, false)]);
			expect(screen.getByRole("button", { name: "Cam 2" })).toBeDisabled();
		});

		it("an unavailable camera that is on can still be switched off", () => {
			const tl = setup(pip([0, 1]), [camera(0), camera(1, false)]);
			const cam2 = screen.getByRole("button", { name: "Cam 2" });
			expect(cam2).toBeEnabled();
			fireEvent.click(cam2);
			expect(tl.setSectionCameras).toHaveBeenCalledWith({ kind: "cameraLayout", id: "L1" }, [0]);
		});

		it("side-by-side keeps the selects", () => {
			setup({}, [camera(0), camera(1), camera(2)]);
			expect(screen.getAllByRole("combobox")).toHaveLength(2);
			expect(screen.queryByRole("button", { name: "Cam 1" })).not.toBeInTheDocument();
		});
	});
});
