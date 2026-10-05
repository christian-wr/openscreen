// @vitest-environment jsdom
import "@testing-library/jest-dom";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type AdditionalCameraChoice, AdditionalCamerasList } from "./AdditionalCamerasList";

afterEach(cleanup);

const labels = {
	title: "Additional cameras",
	hint: "Only with native Windows recording",
};

const device = (id: string) => ({ deviceId: id, label: `Camera ${id}`, groupId: id });
const choice = (id: string): AdditionalCameraChoice => ({ id, name: `Camera ${id}` });

describe("AdditionalCamerasList", () => {
	it("the additional list never offers camera 1", () => {
		render(
			<AdditionalCamerasList
				devices={[device("A"), device("B"), device("C")]}
				primaryDeviceId="A"
				selected={[]}
				onChange={vi.fn()}
				disabled={false}
				labels={labels}
			/>,
		);

		const items = screen.getAllByRole("menuitemcheckbox");
		expect(items.map((item) => item.textContent)).toEqual(["Camera B", "Camera C"]);
	});

	it("keeps the order of selection", () => {
		const onChange = vi.fn();
		function Harness() {
			const [selected, setSelected] = useState<AdditionalCameraChoice[]>([]);
			return (
				<AdditionalCamerasList
					devices={[device("A"), device("B"), device("C")]}
					primaryDeviceId="A"
					selected={selected}
					onChange={(next) => {
						onChange(next);
						setSelected(next);
					}}
					disabled={false}
					labels={labels}
				/>
			);
		}
		render(<Harness />);

		fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Camera C" }));
		fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Camera B" }));

		expect(onChange).toHaveBeenLastCalledWith([choice("C"), choice("B")]);
		expect(screen.getByRole("menuitemcheckbox", { name: "Camera C" })).toHaveAttribute(
			"aria-checked",
			"true",
		);
	});

	it("unchecks a camera that is already selected", () => {
		const onChange = vi.fn();
		render(
			<AdditionalCamerasList
				devices={[device("A"), device("B"), device("C")]}
				primaryDeviceId="A"
				selected={[choice("B"), choice("C")]}
				onChange={onChange}
				disabled={false}
				labels={labels}
			/>,
		);

		fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Camera B" }));

		expect(onChange).toHaveBeenLastCalledWith([choice("C")]);
	});

	it("caps at three", () => {
		const onChange = vi.fn();
		render(
			<AdditionalCamerasList
				devices={[device("P"), device("B"), device("C"), device("D"), device("E")]}
				primaryDeviceId="P"
				selected={[choice("B"), choice("C"), choice("D")]}
				onChange={onChange}
				disabled={false}
				labels={labels}
			/>,
		);

		const fourth = screen.getByRole("menuitemcheckbox", { name: "Camera E" });
		expect(fourth).toBeDisabled();
		expect(screen.getByRole("menuitemcheckbox", { name: "Camera B" })).toBeEnabled();
		fireEvent.click(fourth);
		expect(onChange).not.toHaveBeenCalled();
	});

	it("is disabled with a hint without native Windows recording", () => {
		const onChange = vi.fn();
		render(
			<AdditionalCamerasList
				devices={[device("A"), device("B")]}
				primaryDeviceId="A"
				selected={[]}
				onChange={onChange}
				disabled
				labels={labels}
			/>,
		);

		const item = screen.getByRole("menuitemcheckbox", { name: "Camera B" });
		expect(item).toBeDisabled();
		expect(screen.getByText(labels.hint)).toBeInTheDocument();
		fireEvent.click(item);
		expect(onChange).not.toHaveBeenCalled();
	});

	it("shows no hint while it is usable", () => {
		render(
			<AdditionalCamerasList
				devices={[device("A"), device("B")]}
				primaryDeviceId="A"
				selected={[]}
				onChange={vi.fn()}
				disabled={false}
				labels={labels}
			/>,
		);

		expect(screen.queryByText(labels.hint)).not.toBeInTheDocument();
	});
});
