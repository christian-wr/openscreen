// @vitest-environment jsdom
import "@testing-library/jest-dom";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdditionalCameraChoice } from "./AdditionalCamerasList";
import { DeskCameraList } from "./DeskCameraList";

afterEach(cleanup);

const labels = {
	title: "Desk camera",
	none: "None",
	hint: "Only with native Windows recording",
};

const device = (id: string) => ({ deviceId: id, label: `Camera ${id}`, groupId: id });
const choice = (id: string): AdditionalCameraChoice => ({ id, name: `Camera ${id}` });

function renderList(
	overrides: Partial<Parameters<typeof DeskCameraList>[0]> = {},
): ReturnType<typeof vi.fn> {
	const onChange = vi.fn();
	render(
		<DeskCameraList
			devices={[device("A"), device("B"), device("C")]}
			primaryDeviceId="A"
			additional={[choice("C"), choice("B")]}
			selected={null}
			onChange={onChange}
			disabled={false}
			labels={labels}
			{...overrides}
		/>,
	);
	return onChange;
}

describe("DeskCameraList", () => {
	it("offers None, camera 1 and the checked additional cameras in recorded order", () => {
		renderList();

		expect(screen.getByText(labels.title)).toBeInTheDocument();
		const items = screen.getAllByRole("menuitemradio");
		expect(items.map((item) => item.textContent)).toEqual([
			"None",
			"Camera A",
			"Camera C",
			"Camera B",
		]);
	});

	it("leaves out cameras that are not recorded", () => {
		renderList({ additional: [choice("C")] });

		const items = screen.getAllByRole("menuitemradio");
		expect(items.map((item) => item.textContent)).toEqual(["None", "Camera A", "Camera C"]);
	});

	it("is not shown with fewer than two recorded cameras", () => {
		renderList({ additional: [] });

		expect(screen.queryByText(labels.title)).not.toBeInTheDocument();
		expect(screen.queryAllByRole("menuitemradio")).toHaveLength(0);
	});

	it("stores the current id and name of the picked camera", () => {
		const onChange = renderList();

		fireEvent.click(screen.getByRole("menuitemradio", { name: "Camera C" }));
		expect(onChange).toHaveBeenLastCalledWith({ id: "C", name: "Camera C" });

		fireEvent.click(screen.getByRole("menuitemradio", { name: "Camera A" }));
		expect(onChange).toHaveBeenLastCalledWith({ id: "A", name: "Camera A" });
	});

	it("clears the pick with None", () => {
		const onChange = renderList({ selected: choice("C") });

		fireEvent.click(screen.getByRole("menuitemradio", { name: "None" }));
		expect(onChange).toHaveBeenLastCalledWith(null);
	});

	it("checks the stored pick", () => {
		renderList({ selected: choice("B") });

		expect(screen.getByRole("menuitemradio", { name: "Camera B" })).toHaveAttribute(
			"aria-checked",
			"true",
		);
		expect(screen.getByRole("menuitemradio", { name: "None" })).toHaveAttribute(
			"aria-checked",
			"false",
		);
	});

	it("checks None when the stored pick is not among the recorded cameras", () => {
		// D is unplugged / not checked as an additional camera: it will not be recorded.
		renderList({ selected: choice("D") });

		expect(screen.getByRole("menuitemradio", { name: "None" })).toHaveAttribute(
			"aria-checked",
			"true",
		);
		for (const name of ["Camera A", "Camera B", "Camera C"]) {
			expect(screen.getByRole("menuitemradio", { name })).toHaveAttribute("aria-checked", "false");
		}
	});

	it("is disabled with a hint without native Windows recording", () => {
		const onChange = renderList({ disabled: true });

		const item = screen.getByRole("menuitemradio", { name: "Camera C" });
		expect(item).toBeDisabled();
		expect(screen.getByRole("menuitemradio", { name: "None" })).toBeDisabled();
		expect(screen.getByText(labels.hint)).toBeInTheDocument();
		fireEvent.click(item);
		expect(onChange).not.toHaveBeenCalled();
	});

	it("shows no hint while it is usable", () => {
		renderList();

		expect(screen.queryByText(labels.hint)).not.toBeInTheDocument();
	});
});
