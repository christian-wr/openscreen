// Minimal declarations for js-aruco2 2.0.0, which ships no types. Only what this app uses.
// The package is CommonJS: `src/aruco.js` assigns `this.AR`, so the default import is
// `{ AR }`; each dictionary file registers itself in `AR.DICTIONARIES` as a side effect.

declare module "js-aruco2" {
	export interface ArucoPoint {
		x: number;
		y: number;
	}

	export interface ArucoMarker {
		id: number;
		/** Four corners, clockwise from the marker's own top-left. */
		corners: ArucoPoint[];
		hammingDistance: number;
	}

	export interface ArucoDictionaryDefinition {
		nBits: number;
		/** Minimum distance between codes; null lets the library compute it. */
		tau: number | null;
		/** Codes as numbers, hex strings or byte arrays (row-major bits). */
		codeList: Array<number | string | number[]>;
	}

	export interface ArucoDictionary {
		/** Each code as a string of `nBits` "0"/"1", row-major. */
		codeList: string[];
		nBits: number;
		/** Side in cells including the black border (4x4 → 6). */
		markSize: number;
		tau: number;
		generateSVG(id: number): string;
	}

	export interface ArucoDetector {
		detectImage(width: number, height: number, data: ArrayLike<number>): ArucoMarker[];
	}

	export interface ArucoNamespace {
		DICTIONARIES: Record<string, ArucoDictionaryDefinition>;
		Dictionary: new (name: string) => ArucoDictionary;
		Detector: new (config?: {
			dictionaryName?: string;
			maxHammingDistance?: number;
		}) => ArucoDetector;
	}

	const aruco: { AR: ArucoNamespace };
	export default aruco;
}

declare module "js-aruco2/src/dictionaries/aruco_4x4_1000.js" {}
