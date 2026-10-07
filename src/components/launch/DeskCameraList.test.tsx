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
		const items = screen.getAllByRole("radio");
		expect(items.map((item) => item.textContent)).toEqual([
			"None",
			"Camera A",
			"Camera C",
			"Camera B",
		]);
	});

	it("leaves out cameras that are not recorded", () => {
		renderList({ additional: [choice("C")] });

		const items = screen.getAllByRole("radio");
		expect(items.map((item) => item.textContent)).toEqual(["None", "Camera A", "Camera C"]);
	});

	it("is not shown with fewer than two recorded cameras", () => {
		renderList({ additional: [] });

		expect(screen.queryByText(labels.title)).not.toBeInTheDocument();
		expect(screen.queryAllByRole("radio")).toHaveLength(0);
	});

	it("stores the current id and name of the picked camera", () => {
		const onChange = renderList();

		fireEvent.click(screen.getByRole("radio", { name: "Camera C" }));
		expect(onChange).toHaveBeenLastCalledWith({ id: "C", name: "Camera C" });

		fireEvent.click(screen.getByRole("radio", { name: "Camera A" }));
		expect(onChange).toHaveBeenLastCalledWith({ id: "A", name: "Camera A" });
	});

	it("clears the pick with None", () => {
		const onChange = renderList({ selected: choice("C") });

		fireEvent.click(screen.getByRole("radio", { name: "None" }));
		expect(onChange).toHaveBeenLastCalledWith(null);
	});

	it("checks the stored pick", () => {
		renderList({ selected: choice("B") });

		expect(screen.getByRole("radio", { name: "Camera B" })).toHaveAttribute("aria-checked", "true");
		expect(screen.getByRole("radio", { name: "None" })).toHaveAttribute("aria-checked", "false");
	});

	it("checks None when the stored pick is not among the recorded cameras", () => {
		// D is unplugged / not checked as an additional camera: it will not be recorded.
		renderList({ selected: choice("D") });

		expect(screen.getByRole("radio", { name: "None" })).toHaveAttribute("aria-checked", "true");
		for (const name of ["Camera A", "Camera B", "Camera C"]) {
			expect(screen.getByRole("radio", { name })).toHaveAttribute("aria-checked", "false");
		}
	});

	it("offers a stale-id additional camera as the device the recording resolves it to", () => {
		// The reviewer's case for #1025: the pick was saved under an id the system no longer
		// reports, and the recorder takes the camera of that name -- so the desk list offers it.
		const onChange = renderList({
			devices: [device("A"), { deviceId: "new-id", label: "USB Camera", groupId: "g" }],
			additional: [{ id: "old-id", name: "USB Camera" }],
		});

		const items = screen.getAllByRole("radio");
		expect(items.map((item) => item.textContent)).toEqual(["None", "Camera A", "USB Camera"]);
		fireEvent.click(screen.getByRole("radio", { name: "USB Camera" }));
		expect(onChange).toHaveBeenLastCalledWith({ id: "new-id", name: "USB Camera" });
	});

	it("checks the extra a stale desk pick resolves to by name", () => {
		renderList({
			devices: [device("A"), { deviceId: "new-id", label: "USB Camera", groupId: "g" }],
			additional: [{ id: "old-id", name: "USB Camera" }],
			selected: { id: "old-id", name: "USB Camera" },
		});

		expect(screen.getByRole("radio", { name: "USB Camera" })).toHaveAttribute(
			"aria-checked",
			"true",
		);
		expect(screen.getByRole("radio", { name: "None" })).toHaveAttribute("aria-checked", "false");
	});

	it("checks camera 1 for a stale desk pick of its name while no other camera shares it", () => {
		renderList({ selected: { id: "old-id", name: "Camera A" } });

		expect(screen.getByRole("radio", { name: "Camera A" })).toHaveAttribute("aria-checked", "true");
	});

	it("keeps a valid desk pick on its own camera among two extras of the same name", () => {
		const brio = (id: string) => ({ deviceId: id, label: "Brio", groupId: id });
		renderList({
			devices: [device("A"), brio("brio-2"), brio("brio-3")],
			additional: [
				{ id: "brio-2", name: "Brio" },
				{ id: "brio-3", name: "Brio" },
			],
			selected: { id: "brio-3", name: "Brio" },
		});

		const checked = screen.getAllByRole("radio").map((item) => item.getAttribute("aria-checked"));
		expect(checked).toEqual(["false", "false", "false", "true"]);
	});

	it("checks the extra a stale desk pick's own saved pick resolved to", () => {
		const brio = (id: string) => ({ deviceId: id, label: "Brio", groupId: id });
		renderList({
			devices: [device("A"), brio("brio-2"), brio("brio-3")],
			additional: [
				{ id: "brio-3", name: "Brio" },
				{ id: "old-2", name: "Brio" },
			],
			selected: { id: "old-2", name: "Brio" },
		});

		// None, Camera A, brio-3, brio-2 (recorded order): the stale pick is brio-2.
		const checked = screen.getAllByRole("radio").map((item) => item.getAttribute("aria-checked"));
		expect(checked).toEqual(["false", "false", "false", "true"]);
	});

	it("is disabled with a hint without native Windows recording", () => {
		const onChange = renderList({ disabled: true });

		const item = screen.getByRole("radio", { name: "Camera C" });
		expect(item).toBeDisabled();
		expect(screen.getByRole("radio", { name: "None" })).toBeDisabled();
		expect(screen.getByText(labels.hint)).toBeInTheDocument();
		fireEvent.click(item);
		expect(onChange).not.toHaveBeenCalled();
	});

	it("is a radio group named by its title", () => {
		renderList();

		expect(screen.getByRole("radiogroup", { name: labels.title })).toBeInTheDocument();
	});

	it("leaves the hint to the list above when it has none of its own", () => {
		renderList({ disabled: true, labels: { title: labels.title, none: labels.none } });

		expect(screen.getByRole("radio", { name: "Camera C" })).toBeDisabled();
		expect(screen.queryByText(labels.hint)).not.toBeInTheDocument();
	});

	it("shows no hint while it is usable", () => {
		renderList();

		expect(screen.queryByText(labels.hint)).not.toBeInTheDocument();
	});
});
