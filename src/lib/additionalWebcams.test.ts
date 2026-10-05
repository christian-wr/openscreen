import { describe, expect, it } from "vitest";
import { resolveAdditionalWebcams } from "./additionalWebcams";

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
