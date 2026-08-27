export type AIModelChoice = {
	id: string;
	name: string;
	type: string;
	imageRequestSchema?: import("./image-request-schema").ImageRequestSchema;
};

export function resolveSelectedModel<T extends AIModelChoice>(models: T[] | undefined, selectedID: string | undefined, defaultID: string | undefined): T | undefined {
	const available = models || [];
	return available.find((model) => model.id === selectedID) || available.find((model) => model.id === defaultID) || available[0];
}
