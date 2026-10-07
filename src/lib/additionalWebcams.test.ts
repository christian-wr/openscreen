import { describe, expect, it } from "vitest";
import {
	deskCameraIndex,
	nativeRequestCameraFields,
	resolveAdditionalCameraPicks,
	resolveAdditionalWebcams,
} from "./additionalWebcams";

const present = [
	{ deviceId: "a", label: "Cam A" },
	{ deviceId: "b", label: "Cam B" },
	{ deviceId: "c", label: "Cam C" },
	{ deviceId: "d", label: "Cam D" },
	{ deviceId: "e", label: "Cam E" },
];

describe("resolveAdditionalWebcams", () => {
	it("keeps the order of the picks and reports the current id and label", () => {
		expect(
			resolveAdditionalWebcams(
				[
					{ id: "c", name: "Cam C" },
					{ id: "b", name: "Cam B" },
				],
				present,
				"a",
			),
		).toEqual([
			{ deviceId: "c", deviceName: "Cam C" },
			{ deviceId: "b", deviceName: "Cam B" },
		]);
	});

	it("drops cameras that are no longer present and falls back to the name when the id changed", () => {
		expect(
			resolveAdditionalWebcams(
				[
					{ id: "gone", name: "Unplugged" },
					{ id: "old-id", name: "Cam B" },
				],
				present,
				"a",
			),
		).toEqual([{ deviceId: "b", deviceName: "Cam B" }]);
	});

	it("never repeats camera 1 or a camera picked twice", () => {
		expect(
			resolveAdditionalWebcams(
				[
					{ id: "a", name: "Cam A" },
					{ id: "b", name: "Cam B" },
					{ id: null, name: "Cam B" },
				],
				present,
				"a",
			),
		).toEqual([{ deviceId: "b", deviceName: "Cam B" }]);
	});

	it("caps at three", () => {
		const picks = ["b", "c", "d", "e"].map((id) => ({ id, name: `Cam ${id.toUpperCase()}` }));
		expect(resolveAdditionalWebcams(picks, present, "a")).toHaveLength(3);
	});
});

describe("deskCameraIndex", () => {
	const camera1 = { id: "a", name: "Cam A" };
	const recorded = [
		{ id: "b", name: "Cam B" },
		{ id: "c", name: "Cam C" },
	];

	it("answers 0 for camera 1", () => {
		expect(deskCameraIndex({ id: "a", name: "Cam A" }, camera1, recorded)).toBe(0);
	});

	it("answers k for the k-th additional camera recorded", () => {
		expect(deskCameraIndex({ id: "b", name: "Cam B" }, camera1, recorded)).toBe(1);
		expect(deskCameraIndex({ id: "c", name: "Cam C" }, camera1, recorded)).toBe(2);
	});

	it("matches by name when the pick has no id, and by id while that id is plugged in", () => {
		expect(deskCameraIndex({ id: null, name: "Cam C" }, camera1, recorded)).toBe(2);
		// zz is plugged in but not recorded: the pick names that camera, not Cam C.
		const withZz = [...present, { deviceId: "zz", label: "Cam C" }];
		expect(deskCameraIndex({ id: "zz", name: "Cam C" }, camera1, recorded, withZz)).toBeUndefined();
	});

	it("answers undefined for a camera that is not recorded", () => {
		expect(deskCameraIndex({ id: "d", name: "Cam D" }, camera1, recorded)).toBeUndefined();
		expect(deskCameraIndex({ id: "a", name: "Cam A" }, null, recorded)).toBe(undefined);
	});

	it("answers undefined without a desk camera", () => {
		expect(deskCameraIndex(null, camera1, recorded)).toBeUndefined();
	});

	it("tells two cameras of the same name apart when camera 1 has no id", () => {
		const brio1 = { id: null, name: "Brio" };
		const extras = [{ id: "brio-2", name: "Brio" }];
		expect(deskCameraIndex({ id: "brio-2", name: "Brio" }, brio1, extras)).toBe(1);
		// Camera 1 picked: misses every extra id and still reaches camera 1 by name.
		expect(deskCameraIndex({ id: "brio-1", name: "Brio" }, brio1, extras)).toBe(0);
	});

	it("never matches an extra by name while the pick's own id is plugged in", () => {
		const brios = [
			{ deviceId: "a", label: "Cam A" },
			{ deviceId: "brio-2", label: "Brio" },
			{ deviceId: "brio-3", label: "Brio" },
		];
		expect(
			deskCameraIndex(
				{ id: "brio-3", name: "Brio" },
				camera1,
				[{ id: "brio-2", name: "Brio" }],
				brios,
			),
		).toBeUndefined();
	});

	it("resolves a stale id to the recorded extra of the same name", () => {
		const usbPresent = [
			{ deviceId: "a", label: "Cam A" },
			{ deviceId: "new-id", label: "USB Camera" },
		];
		expect(
			deskCameraIndex(
				{ id: "old-id", name: "USB Camera" },
				camera1,
				[{ id: "new-id", name: "USB Camera" }],
				usbPresent,
			),
		).toBe(1);
	});

	it("resolves a stale id among same-name extras to the first recorded, extras before camera 1", () => {
		const brios = [
			{ deviceId: "brio-1", label: "Brio" },
			{ deviceId: "brio-2", label: "Brio" },
			{ deviceId: "brio-3", label: "Brio" },
		];
		expect(
			deskCameraIndex(
				{ id: "old-id", name: "Brio" },
				{ id: "brio-1", name: "Brio" },
				[
					{ id: "brio-3", name: "Brio" },
					{ id: "brio-2", name: "Brio" },
				],
				brios,
			),
		).toBe(1);
	});

	it("resolves a stale id to camera 1 by name while no other plugged-in camera shares it", () => {
		const brioPresent = [
			{ deviceId: "brio-1", label: "Brio" },
			{ deviceId: "b", label: "Cam B" },
		];
		const brio1 = { id: "brio-1", name: "Brio" };
		const extras = [{ id: "b", name: "Cam B" }];
		expect(deskCameraIndex({ id: "old-id", name: "Brio" }, brio1, extras, brioPresent)).toBe(0);
		// A second Brio plugged in but not recorded: the stale pick could be either one.
		expect(
			deskCameraIndex({ id: "old-id", name: "Brio" }, brio1, extras, [
				...brioPresent,
				{ deviceId: "brio-9", label: "Brio" },
			]),
		).toBeUndefined();
	});

	it("keeps a valid id on its own camera among two extras of the same name", () => {
		const brios = [
			{ deviceId: "a", label: "Cam A" },
			{ deviceId: "brio-2", label: "Brio" },
			{ deviceId: "brio-3", label: "Brio" },
		];
		const extras = [
			{ id: "brio-2", name: "Brio" },
			{ id: "brio-3", name: "Brio" },
		];
		expect(deskCameraIndex({ id: "brio-3", name: "Brio" }, camera1, extras, brios)).toBe(2);
		expect(deskCameraIndex({ id: "brio-2", name: "Brio" }, camera1, extras, brios)).toBe(1);
	});

	it("does not take a stale pick for camera 1 by name while another camera shares it", () => {
		const brioPresent = [
			{ deviceId: "brio-1", label: "Brio" },
			{ deviceId: "brio-2", label: "Brio" },
		];
		// brio-2 is plugged in but not recorded; camera 1 (no id) could be either Brio.
		expect(
			deskCameraIndex({ id: "brio-2", name: "Brio" }, { id: null, name: "Brio" }, [], brioPresent),
		).toBeUndefined();
		// With brio-2 recorded as an extra, camera 1 can only be brio-1.
		expect(
			deskCameraIndex(
				{ id: "brio-1", name: "Brio" },
				{ id: null, name: "Brio" },
				[{ id: "brio-2", name: "Brio" }],
				brioPresent,
			),
		).toBe(0);
	});

	it("matches camera 1 by name when the live identity carries no id", () => {
		// The HUD stores camera 1 under its enumerated id; a recorder that could not read the id
		// off the track must still find it.
		expect(deskCameraIndex({ id: "a", name: "Cam A" }, { id: null, name: "Cam A" }, recorded)).toBe(
			0,
		);
	});
});

describe("nativeRequestCameraFields", () => {
	const camera1 = { deviceId: "a", deviceName: "Cam A" };

	it("puts the additional cameras and the desk camera's index into the request", () => {
		expect(
			nativeRequestCameraFields(
				[
					{ id: "c", name: "Cam C" },
					{ id: "b", name: "Cam B" },
				],
				{ id: "b", name: "Cam B" },
				present,
				camera1,
			),
		).toEqual({
			additionalWebcams: [
				{ deviceId: "c", deviceName: "Cam C" },
				{ deviceId: "b", deviceName: "Cam B" },
			],
			deskCamera: 2,
		});
	});

	it("answers 0 when camera 1 is the desk camera", () => {
		expect(
			nativeRequestCameraFields(
				[{ id: "b", name: "Cam B" }],
				{ id: "a", name: "Cam A" },
				present,
				camera1,
			),
		).toEqual({ additionalWebcams: [{ deviceId: "b", deviceName: "Cam B" }], deskCamera: 0 });
	});

	it("sends the index of the extra a stale desk pick resolves to", () => {
		const usbPresent = [...present, { deviceId: "new-id", label: "USB Camera" }];
		const stale = { id: "old-id", name: "USB Camera" };
		expect(nativeRequestCameraFields([stale], stale, usbPresent, camera1)).toEqual({
			additionalWebcams: [{ deviceId: "new-id", deviceName: "USB Camera" }],
			deskCamera: 1,
		});
	});

	it("leaves the desk camera out of a take with camera 1 alone", () => {
		expect(nativeRequestCameraFields([], { id: "a", name: "Cam A" }, present, camera1)).toEqual({});
	});

	it("leaves both keys out when there is nothing to add", () => {
		expect(nativeRequestCameraFields([], null, present, camera1)).toEqual({});
		// A desk camera that is not recorded is no desk camera.
		expect(
			nativeRequestCameraFields(
				[{ id: "b", name: "Cam B" }],
				{ id: "d", name: "Cam D" },
				present,
				camera1,
			),
		).toEqual({ additionalWebcams: [{ deviceId: "b", deviceName: "Cam B" }] });
	});
});

describe("resolveAdditionalCameraPicks", () => {
	const usb = (deviceId: string) => ({ deviceId, label: "USB Camera" });

	it("pairs each pick with the camera it resolves to, a stale id by name", () => {
		const stale = { id: "old-id", name: "USB Camera" };
		expect(
			resolveAdditionalCameraPicks(
				[stale],
				[{ deviceId: "p", label: "Primary" }, usb("new-id")],
				"p",
			),
		).toEqual([{ pick: stale, device: usb("new-id") }]);
	});

	it("resolves a stale id among same-label cameras to the first one enumerated", () => {
		const stale = { id: "old-id", name: "USB Camera" };
		expect(resolveAdditionalCameraPicks([stale], [usb("one"), usb("two")], undefined)).toEqual([
			{ pick: stale, device: usb("one") },
		]);
	});

	it("keeps a valid saved id on its own camera when another has the same label", () => {
		const pick = { id: "two", name: "USB Camera" };
		expect(resolveAdditionalCameraPicks([pick], [usb("one"), usb("two")], undefined)).toEqual([
			{ pick, device: usb("two") },
		]);
	});

	it("agrees with resolveAdditionalWebcams", () => {
		const picks = [
			{ id: "old-id", name: "USB Camera" },
			{ id: "two", name: "USB Camera" },
			{ id: null, name: "Cam B" },
		];
		const cams = [usb("one"), usb("two"), ...present];
		expect(
			resolveAdditionalCameraPicks(picks, cams, "a").map(({ device }) => ({
				deviceId: device.deviceId,
				deviceName: device.label,
			})),
		).toEqual(resolveAdditionalWebcams(picks, cams, "a"));
	});
});
