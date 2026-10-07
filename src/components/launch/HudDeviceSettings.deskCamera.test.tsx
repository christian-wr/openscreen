// @vitest-environment jsdom
import "@testing-library/jest-dom";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "../ui/tooltip";
import { HudDeviceSettings, type HudDeviceSettingsLabels } from "./HudDeviceSettings";

vi.mock("../../hooks/useAudioLevelMeter", () => ({
	useAudioLevelMeter: () => ({ level: 0 }),
}));
vi.mock("../../hooks/useCameraPreviewStream", () => ({
	useCameraPreviewStream: () => ({ stream: null, error: null }),
}));

const labels: HudDeviceSettingsLabels = {
	title: "Device settings",
	close: "Close",
	microphone: "Microphone",
	camera: "Camera",
	micLevel: "Input level",
	micHint: "Speak to check",
	noMicrophones: "No microphone found",
	searching: "Searching...",
	noCameras: "No camera found",
	cameraUnavailable: "Camera unavailable",
	preview: "Preview",
	previewUnavailable: "Preview unavailable",
	about: "About",
	checkForUpdates: "Check for updates",
	checkingForUpdates: "Checking…",
	cameraQuality: "Camera quality",
	cameraQualityOptions: {
		"1080p": "1080p",
		"1440p": "1440p",
		"2160p": "4K",
	},
};

afterEach(cleanup);

const devices = [
	{ deviceId: "cam-1", label: "Logitech BRIO", groupId: "group-1" },
	{ deviceId: "cam-2", label: "C920", groupId: "group-2" },
];

function renderPanel(desk: {
	selected: { id: string | null; name: string } | null;
	disabled?: boolean;
}) {
	const onChangeDesk = vi.fn();
	render(
		<TooltipProvider>
			<HudDeviceSettings
				showMicrophone={false}
				micDevices={[]}
				cameraDevices={devices}
				activeMicId={undefined}
				activeCameraId="cam-1"
				cameraLoading={false}
				cameraError={null}
				labels={labels}
				versionLabel={null}
				canCheckForUpdates={false}
				checkingForUpdates={false}
				cameraQuality="1440p"
				additionalCameras={{
					selected: [{ id: "cam-2", name: "C920" }],
					onChange: vi.fn(),
					disabled: desk.disabled ?? false,
					labels: { title: "Additional cameras", hint: "Native Windows only" },
					desk: {
						selected: desk.selected,
						onChange: onChangeDesk,
						labels: { title: "Desk camera", none: "None" },
					},
				}}
				onSelectCameraQuality={vi.fn()}
				onSelectMic={vi.fn()}
				onSelectCamera={vi.fn()}
				onCheckForUpdates={vi.fn()}
				onClose={vi.fn()}
				panelRef={() => undefined}
			/>
		</TooltipProvider>,
	);
	return { onChangeDesk };
}

describe("HudDeviceSettings desk camera", () => {
	it("offers the recorded cameras below the additional cameras and reports the pick", () => {
		const { onChangeDesk } = renderPanel({ selected: null });

		const desk = within(screen.getByRole("radiogroup", { name: "Desk camera" }));
		const items = desk.getAllByRole("radio").map((item) => item.textContent);
		expect(items).toEqual(["None", "Logitech BRIO", "C920"]);
		expect(desk.getByRole("radio", { name: "None" })).toHaveAttribute("aria-checked", "true");

		fireEvent.click(desk.getByRole("radio", { name: "C920" }));
		expect(onChangeDesk).toHaveBeenCalledWith({ id: "cam-2", name: "C920" });
	});

	it("is locked like the additional cameras", () => {
		const { onChangeDesk } = renderPanel({ selected: null, disabled: true });

		const desk = within(screen.getByRole("radiogroup", { name: "Desk camera" }));
		const item = desk.getByRole("radio", { name: "C920" });
		expect(item).toBeDisabled();
		fireEvent.click(item);
		expect(onChangeDesk).not.toHaveBeenCalled();
		// One hint for both locked lists.
		expect(screen.getAllByText("Native Windows only")).toHaveLength(1);
	});
});
