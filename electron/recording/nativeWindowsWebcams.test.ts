import { describe, expect, it } from "vitest";
import {
	additionalWebcamLabels,
	buildHelperWebcamConfig,
	collectStoppedWebcams,
	dedupeAdditionalWebcams,
	deskWebcamPath,
	isWebcamSidecarFile,
	labelsOfUnavailableAdditionalWebcams,
	labelsOfWebcamsStoppedEarly,
	recordedDeskCamera,
	remapDeskCamera,
	stripWebcamSuffix,
	webcamOutputPath,
} from "./nativeWindowsWebcams";

describe("nativeWindowsWebcams", () => {
	it("names camera files", () => {
		expect(webcamOutputPath("C:\\r", "rec-", 7, 1)).toMatch(/rec-7-webcam\.mp4$/);
		expect(webcamOutputPath("C:\\r", "rec-", 7, 3)).toMatch(/rec-7-webcam-3\.mp4$/);
	});

	it("recognizes every camera file of a recording and nothing else", () => {
		for (const f of ["rec-7-webcam.mp4", "rec-7-webcam-2.mp4", "rec-7-webcam-4.webm"]) {
			expect(isWebcamSidecarFile(f)).toBe(true);
		}
		for (const f of ["rec-7.mp4", "rec-7-webcamera.mp4", "rec-7-webcam-x.mp4"]) {
			expect(isWebcamSidecarFile(f)).toBe(false);
		}
		expect(stripWebcamSuffix("rec-7-webcam-2")).toBe("rec-7");
		expect(stripWebcamSuffix("rec-7-webcam")).toBe("rec-7");
		expect(stripWebcamSuffix("rec-7")).toBe("rec-7");
	});

	it("dedupes a device that equals camera 1, duplicates, and caps at three", () => {
		const extras = [
			{ deviceId: "a", deviceName: "Front" },
			{ deviceId: "b", deviceName: "Desk" },
			{ deviceId: "b", deviceName: "Desk" },
			{ deviceName: "Side" },
			{ deviceName: "Top" },
			{ deviceName: "Fifth" },
		];
		expect(
			dedupeAdditionalWebcams({ deviceId: "a", deviceName: "Front" }, extras).map(
				(e) => e.deviceName,
			),
		).toEqual(["Desk", "Side", "Top"]);
	});

	it("drops extras that name no device at all", () => {
		expect(dedupeAdditionalWebcams(null, [{ deviceName: "  " }, { deviceName: "Desk" }])).toEqual([
			{ deviceName: "Desk" },
		]);
	});

	it("skips malformed entries from IPC", () => {
		const junk = [
			null,
			{ deviceName: 3 },
			{ deviceId: 4, deviceName: "X" },
			{ deviceName: "Desk" },
		];
		expect(dedupeAdditionalWebcams(null, junk as unknown as Array<{ deviceName: string }>)).toEqual(
			[{ deviceName: "Desk" }],
		);
	});

	it("never matches an extra with an id to an id-less camera 1 by name", () => {
		// Two cameras of the same model: same name, and camera 1 came without an id.
		expect(
			dedupeAdditionalWebcams({ deviceName: "USB Camera" }, [
				{ deviceId: "b", deviceName: "USB Camera" },
			]),
		).toEqual([{ deviceId: "b", deviceName: "USB Camera" }]);
		// Without an id on either side the name is all there is, and it still matches.
		expect(
			dedupeAdditionalWebcams({ deviceName: "USB Camera" }, [{ deviceName: "USB Camera" }]),
		).toEqual([]);
	});

	describe("labelsOfWebcamsStoppedEarly", () => {
		const front = String.raw`C:\Rec\r-webcam.mp4`;
		const desk = String.raw`C:\Rec\r-webcam-2.mp4`;
		const side = String.raw`C:\Rec\r-webcam-3.mp4`;
		const requested = [
			{ path: front, label: "Front" },
			{ path: desk, label: "Desk" },
			{ path: side, label: "Side" },
		];
		const sizes = new Map([
			[front, 100],
			[desk, 100],
			[side, 0],
		]);

		it("names a kept camera the helper no longer listed, camera 1 included", () => {
			expect(
				labelsOfWebcamsStoppedEarly({
					requested,
					sizes,
					helperWebcamPaths: [desk],
				}),
			).toEqual(["Front"]);
		});

		it("leaves out a camera whose file was not kept: that one was not recorded", () => {
			expect(labelsOfWebcamsStoppedEarly({ requested, sizes, helperWebcamPaths: [] })).toEqual([
				"Front",
				"Desk",
			]);
		});

		it("flags nothing without a webcamPaths key", () => {
			expect(labelsOfWebcamsStoppedEarly({ requested, sizes, helperWebcamPaths: null })).toEqual(
				[],
			);
		});

		it("matches paths regardless of case and separator", () => {
			expect(
				labelsOfWebcamsStoppedEarly({
					requested,
					sizes,
					helperWebcamPaths: ["c:/rec/R-WEBCAM.mp4", String.raw`c:\REC//r-webcam-2.MP4`],
				}),
			).toEqual([]);
		});
	});

	it("drops an empty additional camera file and names it", () => {
		const r = collectStoppedWebcams({
			camera1Enabled: true,
			requested: [
				{ path: "w.mp4", label: "Front" },
				{ path: "w-2.mp4", label: "Desk" },
				{ path: "w-3.mp4", label: "Side" },
			],
			sizes: new Map([
				["w.mp4", 100],
				["w-2.mp4", 0],
				["w-3.mp4", 50],
			]),
		});
		expect(r).toEqual({
			camera1: "w.mp4",
			additional: [{ path: "w-3.mp4", label: "Side" }],
			dropped: ["Desk"],
		});
	});

	it("keeps camera 1 and reports a camera whose file never appeared as not recorded", () => {
		const r = collectStoppedWebcams({
			camera1Enabled: true,
			requested: [
				{ path: "w.mp4", label: "Front" },
				{ path: "w-2.mp4", label: "Desk" },
			],
			sizes: new Map([["w.mp4", 100]]),
		});
		expect(r).toEqual({ camera1: "w.mp4", additional: [], dropped: ["Desk"] });
	});

	it("keeps extras when camera 1 is lost, leaving camera 1 out of dropped", () => {
		const r = collectStoppedWebcams({
			camera1Enabled: true,
			requested: [
				{ path: "w.mp4", label: "Front" },
				{ path: "w-2.mp4", label: "Desk" },
			],
			sizes: new Map([
				["w.mp4", 0],
				["w-2.mp4", 10],
			]),
		});
		expect(r).toEqual({ additional: [{ path: "w-2.mp4", label: "Desk" }], dropped: [] });
	});

	it("maps unavailable helper indices to the labels of the extras", () => {
		const requested = [
			{ path: "w.mp4", label: "Front" },
			{ path: "w-2.mp4", label: "Desk" },
			{ path: "w-3.mp4", label: "Side" },
		];
		expect(labelsOfUnavailableAdditionalWebcams(requested, [0, 2, 2, 9])).toEqual(["Side"]);
	});

	it("labels extras by device name, else Camera <n>", () => {
		expect(additionalWebcamLabels("Front", [{ deviceName: "Desk" }, { deviceName: "  " }])).toEqual(
			["Desk", "Camera 3"],
		);
	});

	it("tells cameras with the same name apart by occurrence, counting camera 1", () => {
		expect(
			additionalWebcamLabels("USB Camera", [
				{ deviceName: "USB Camera" },
				{ deviceName: "Desk" },
				{ deviceName: " USB Camera " },
			]),
		).toEqual(["USB Camera (2)", "Desk", "USB Camera (3)"]);
		expect(
			additionalWebcamLabels(undefined, [
				{ deviceName: "USB Camera" },
				{ deviceName: "USB Camera" },
			]),
		).toEqual(["USB Camera", "USB Camera (2)"]);
	});

	it("builds a start config with the legacy fields and a list of every camera", () => {
		const config = buildHelperWebcamConfig({
			camera1: {
				enabled: true,
				deviceId: "id-1",
				deviceName: "Front",
				width: 1280,
				height: 720,
				fps: 30,
			},
			camera1Clsid: "{c1}",
			camera1Path: "C:\\r\\rec-7-webcam.mp4",
			extras: [
				{ deviceId: "id-2", deviceName: "Desk", clsid: null, path: "C:\\r\\rec-7-webcam-2.mp4" },
			],
		});
		const parsed = JSON.parse(JSON.stringify(config));
		expect(parsed).toMatchObject({
			webcamEnabled: true,
			webcamDeviceId: "id-1",
			webcamDeviceName: "Front",
			webcamDirectShowClsid: "{c1}",
			webcamWidth: 1280,
			webcamHeight: 720,
			webcamFps: 30,
		});
		expect(parsed.webcams).toEqual([
			{
				camDeviceId: "id-1",
				camDeviceName: "Front",
				camClsid: "{c1}",
				camWidth: 1280,
				camHeight: 720,
				camFps: 30,
				camPath: "C:\\r\\rec-7-webcam.mp4",
			},
			{
				camDeviceId: "id-2",
				camDeviceName: "Desk",
				camClsid: null,
				camWidth: 1280,
				camHeight: 720,
				camFps: 30,
				camPath: "C:\\r\\rec-7-webcam-2.mp4",
			},
		]);
	});

	it("sends no camera list while camera 1 is off", () => {
		const config = buildHelperWebcamConfig({
			camera1: { enabled: false, width: 1280, height: 720, fps: 30 },
			camera1Clsid: null,
			camera1Path: "C:\\r\\rec-7-webcam.mp4",
			extras: [{ deviceName: "Desk", clsid: null, path: "C:\\r\\rec-7-webcam-2.mp4" }],
		});
		expect(config.webcamEnabled).toBe(false);
		expect(config.webcams).toEqual([]);
	});
});

describe("desk camera of a native take", () => {
	const requested = [
		{ deviceId: "b", deviceName: "B" },
		{ deviceId: "a", deviceName: "A" },
		{ deviceId: "c", deviceName: "C" },
	];
	// "a" is camera 1 and is dropped by the dedupe: the files go to B and C.
	const kept = [requested[0], requested[2]];
	const keptPaths = ["/r-webcam-2.mp4", "/r-webcam-3.mp4"];

	it("finds the file the desk camera records into", () => {
		const input = { camera1Path: "/r-webcam.mp4", requested, kept, keptPaths };
		expect(deskWebcamPath({ ...input, deskCamera: 0 })).toBe("/r-webcam.mp4");
		expect(deskWebcamPath({ ...input, deskCamera: 1 })).toBe("/r-webcam-2.mp4");
		expect(deskWebcamPath({ ...input, deskCamera: 3 })).toBe("/r-webcam-3.mp4");
	});

	it("has no file for a desk camera that is not recorded or not an index", () => {
		const input = { camera1Path: "/r-webcam.mp4", requested, kept, keptPaths };
		for (const deskCamera of [2, 4, -1, 0.5, "1", undefined]) {
			expect(deskWebcamPath({ ...input, deskCamera })).toBeNull();
		}
		expect(deskWebcamPath({ ...input, camera1Path: null, deskCamera: 0 })).toBeNull();
	});

	it("indexes the desk camera in recorded order", () => {
		const additional = [
			{ path: "/r-webcam-2.mp4", label: "B" },
			{ path: "/r-webcam-3.mp4", label: "C" },
		];
		expect(recordedDeskCamera("/r-webcam.mp4", "/r-webcam.mp4", additional)).toBe(0);
		expect(recordedDeskCamera("/r-webcam-3.mp4", "/r-webcam.mp4", additional)).toBe(2);
		// Camera 2 came out empty: camera 3 moves up to index 1.
		expect(recordedDeskCamera("/r-webcam-3.mp4", "/r-webcam.mp4", [additional[1]])).toBe(1);
	});

	it("has no recorded index for a desk camera whose file was lost", () => {
		expect(recordedDeskCamera("/r-webcam-2.mp4", "/r-webcam.mp4", [])).toBeUndefined();
		expect(recordedDeskCamera("/r-webcam.mp4", undefined, [])).toBeUndefined();
		expect(recordedDeskCamera(null, "/r-webcam.mp4", [])).toBeUndefined();
	});

	it("follows the desk camera when restored cameras are dropped", () => {
		expect(remapDeskCamera(0, true, [0, 2])).toBe(0);
		expect(remapDeskCamera(3, true, [0, 2])).toBe(2);
		expect(remapDeskCamera(2, true, [0, 2])).toBeUndefined();
		expect(remapDeskCamera(0, false, [0, 1])).toBeUndefined();
		expect(remapDeskCamera(undefined, true, [0])).toBeUndefined();
	});
});
