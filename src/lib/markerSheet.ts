// The printable marker sheet: an A4 page with the four corner markers (IDs 0–3, 40 mm each)
// drawn from the dictionary the detector reads, cut lines around each, a label per marker and a
// one-line instruction. Printed through a hidden iframe and the browser's print dialog, which
// also offers "Save as PDF" — no file IPC needed.

import { CORNER_MARKER_IDS, MARKER_SIZE_MM, markerBits } from "./arucoMarkers";

export const SHEET_WIDTH_MM = 210;
export const SHEET_HEIGHT_MM = 297;
export { MARKER_SIZE_MM };

/** The texts printed on the sheet; the caller passes them translated. */
export interface MarkerSheetText {
	instruction: string;
	/** One label per marker, in ID order (top-left, top-right, bottom-right, bottom-left). */
	labels: [string, string, string, string];
}

const DEFAULT_TEXT: MarkerSheetText = {
	instruction: "Cut along the dashed lines. Put each marker's inner corner on its labelled corner.",
	labels: ["0 – top-left", "1 – top-right", "2 – bottom-right", "3 – bottom-left"],
};

/** Each marker's top-left on the page (mm), by ID. */
const MARKER_ORIGINS_MM: ReadonlyArray<{ x: number; y: number }> = [
	{ x: 35, y: 55 },
	{ x: 135, y: 55 },
	{ x: 135, y: 175 },
	{ x: 35, y: 175 },
];

function mm(value: number): string {
	return String(Math.round(value * 1000) / 1000);
}

function escapeXml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

function markerSvg(id: number, x: number, y: number, label: string): string {
	const bits = markerBits(id);
	const cell = MARKER_SIZE_MM / (bits.length + 2);
	const parts: string[] = [];
	// Cut line one cell outside the marker: the white quiet zone the detector needs.
	parts.push(
		`<rect x="${mm(x - cell)}" y="${mm(y - cell)}" width="${mm(MARKER_SIZE_MM + 2 * cell)}" height="${mm(MARKER_SIZE_MM + 2 * cell)}" fill="none" stroke="#888" stroke-width="0.2" stroke-dasharray="2 1.5"/>`,
	);
	parts.push(
		`<rect data-marker-size="${mm(MARKER_SIZE_MM)}" x="${mm(x)}" y="${mm(y)}" width="${mm(MARKER_SIZE_MM)}" height="${mm(MARKER_SIZE_MM)}" fill="#000"/>`,
	);
	bits.forEach((row, r) => {
		row.forEach((white, c) => {
			if (!white) return;
			parts.push(
				`<rect data-cell="${r},${c}" x="${mm(x + (c + 1) * cell)}" y="${mm(y + (r + 1) * cell)}" width="${mm(cell)}" height="${mm(cell)}" fill="#fff"/>`,
			);
		});
	});
	parts.push(
		`<text x="${mm(x + MARKER_SIZE_MM / 2)}" y="${mm(y + MARKER_SIZE_MM + 2 * cell + 5)}" font-size="4" text-anchor="middle" fill="#444">${escapeXml(label)}</text>`,
	);
	return `<g data-marker-id="${id}" shape-rendering="crispEdges">${parts.join("")}</g>`;
}

/** The sheet as an SVG document string: A4 portrait, user units are millimetres. */
export function markerSheetSvg(text: MarkerSheetText = DEFAULT_TEXT): string {
	const markers = CORNER_MARKER_IDS.map((id, i) =>
		markerSvg(id, MARKER_ORIGINS_MM[i].x, MARKER_ORIGINS_MM[i].y, text.labels[i]),
	).join("");
	return (
		`<svg xmlns="http://www.w3.org/2000/svg" width="${SHEET_WIDTH_MM}mm" height="${SHEET_HEIGHT_MM}mm" viewBox="0 0 ${SHEET_WIDTH_MM} ${SHEET_HEIGHT_MM}" font-family="sans-serif">` +
		`<rect width="${SHEET_WIDTH_MM}" height="${SHEET_HEIGHT_MM}" fill="#fff"/>` +
		`<text x="${SHEET_WIDTH_MM / 2}" y="25" font-size="3.5" text-anchor="middle" fill="#000">${escapeXml(text.instruction)}</text>` +
		markers +
		"</svg>"
	);
}

/** The page the iframe prints: the sheet at its true size, no browser margins. */
export function markerSheetHtml(text?: MarkerSheetText): string {
	return (
		'<!doctype html><html><head><meta charset="utf-8"><title>ArUco</title>' +
		"<style>@page{size:A4 portrait;margin:0}html,body{margin:0;padding:0;background:#fff}svg{display:block}</style>" +
		`</head><body>${markerSheetSvg(text)}</body></html>`
	);
}

/** Marks the iframe so a second click replaces it instead of stacking another one. */
const PRINT_FRAME_ATTR = "data-marker-sheet-print";

/**
 * Removal fallback for when `afterprint` never fires (a dialog that never opened, a print
 * cancelled in a way the frame does not report). Counted from the moment `print()` returns.
 */
export const PRINT_FRAME_FALLBACK_MS = 60_000;

/**
 * Opens the print dialog for the sheet (the OS dialog offers "Save as PDF"). A hidden iframe
 * carries the page so the editor itself is not printed; it goes away once printing is done.
 * Only one such iframe exists at a time: a repeated call replaces the previous one.
 */
export function printMarkerSheet(text?: MarkerSheetText): void {
	for (const old of document.querySelectorAll(`iframe[${PRINT_FRAME_ATTR}]`)) old.remove();
	const iframe = document.createElement("iframe");
	iframe.setAttribute(PRINT_FRAME_ATTR, "");
	iframe.setAttribute("aria-hidden", "true");
	iframe.tabIndex = -1;
	Object.assign(iframe.style, {
		position: "fixed",
		right: "0",
		bottom: "0",
		width: "0",
		height: "0",
		border: "0",
	});
	let fallback: ReturnType<typeof setTimeout> | undefined;
	const remove = () => {
		if (fallback !== undefined) clearTimeout(fallback);
		fallback = undefined;
		iframe.remove();
	};
	iframe.addEventListener(
		"load",
		() => {
			const win = iframe.contentWindow;
			if (!win) {
				remove();
				return;
			}
			win.addEventListener("afterprint", remove, { once: true });
			win.focus();
			win.print();
			fallback = setTimeout(remove, PRINT_FRAME_FALLBACK_MS);
		},
		{ once: true },
	);
	iframe.srcdoc = markerSheetHtml(text);
	document.body.appendChild(iframe);
}
