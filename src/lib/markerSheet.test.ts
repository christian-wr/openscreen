// @vitest-environment jsdom
// jsdom for `printMarkerSheet` (iframe) and for parsing the sheet with DOMParser.
import { afterEach, describe, expect, it, vi } from "vitest";
import { markerBits } from "./arucoMarkers";
import { MARKER_SIZE_MM, markerSheetSvg, printMarkerSheet } from "./markerSheet";

function parse(svg: string): Document {
	return new DOMParser().parseFromString(svg, "image/svg+xml");
}

const num = (el: Element, name: string) => Number(el.getAttribute(name));

describe("markerSheetSvg", () => {
	it("is an A4 portrait page in millimetres", () => {
		const root = parse(markerSheetSvg()).documentElement;
		expect(root.getAttribute("width")).toBe("210mm");
		expect(root.getAttribute("height")).toBe("297mm");
		expect(root.getAttribute("viewBox")).toBe("0 0 210 297");
	});

	it("the sheet contains markers 0–3 at 40 mm", () => {
		const doc = parse(markerSheetSvg());
		const groups = [...doc.querySelectorAll("g[data-marker-id]")];
		expect(groups.map((g) => g.getAttribute("data-marker-id"))).toEqual(["0", "1", "2", "3"]);
		for (const g of groups) {
			const id = Number(g.getAttribute("data-marker-id"));
			const square = g.querySelector("rect[data-marker-size]");
			if (!square) throw new Error(`marker ${id} has no square`);
			expect(num(square, "width")).toBe(MARKER_SIZE_MM);
			expect(num(square, "height")).toBe(MARKER_SIZE_MM);
			// Read the white cells back: they are the dictionary's bits for this ID.
			const cell = MARKER_SIZE_MM / 6;
			const read = Array.from({ length: 4 }, () => Array<boolean>(4).fill(false));
			for (const r of g.querySelectorAll("rect[data-cell]")) {
				const col = Math.round((num(r, "x") - num(square, "x")) / cell) - 1;
				const row = Math.round((num(r, "y") - num(square, "y")) / cell) - 1;
				read[row][col] = true;
			}
			expect(read).toEqual(markerBits(id));
		}
	});

	it("prints the caller's texts, escaped", () => {
		const svg = markerSheetSvg({
			instruction: "Cut <here> & lay",
			labels: ["a", "b", "c", "d"],
		});
		const doc = parse(svg);
		expect(doc.querySelector("parsererror")).toBeNull();
		const texts = [...doc.querySelectorAll("text")].map((t) => t.textContent);
		expect(texts).toEqual(["Cut <here> & lay", "a", "b", "c", "d"]);
	});
});

describe("printMarkerSheet", () => {
	afterEach(() => {
		for (const f of document.querySelectorAll("iframe")) f.remove();
	});

	it("prints the sheet from a hidden iframe and removes it afterwards", () => {
		printMarkerSheet();
		const iframe = document.querySelector("iframe");
		if (!iframe?.contentWindow) throw new Error("no iframe");
		expect(iframe.srcdoc).toContain("<svg");
		const win = iframe.contentWindow;
		vi.spyOn(win, "focus").mockImplementation(() => undefined);
		const print = vi.spyOn(win, "print").mockImplementation(() => undefined);
		iframe.dispatchEvent(new Event("load"));
		expect(print).toHaveBeenCalledTimes(1);
		win.dispatchEvent(new Event("afterprint"));
		expect(document.querySelector("iframe")).toBeNull();
	});
});
