import { describe, expect, it } from "vitest";
import { resolveAdditionalCameraPicks, resolveAdditionalWebcams } from "./additionalWebcams";

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
