export type ImageMaskPoint = { x: number; y: number };

export type ImageMaskStroke = {
    id: string;
    tool: "paint" | "erase";
    radius: number;
    points: ImageMaskPoint[];
};

export type ImageMask = {
    version: 1;
    strokes: ImageMaskStroke[];
};

export type ReferenceImage = {
    id: string;
    name: string;
    type: string;
    dataUrl: string;
    url?: string;
    storageKey?: string;
	mediaId?: string;
	width?: number;
	height?: number;
	mask?: ImageMask;
};
