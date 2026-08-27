export type AiConfig = {
    /** @deprecated 仅兼容旧画布记录，不再参与请求。 */
    model: string;
    imageModel: string;
    videoModel: string;
    textModel: string;
    models: string[];
    systemPrompt: string;
    videoSeconds: string;
    vquality: string;
    quality: string;
    size: string;
	resolution: string;
	outputFormat: string;
	background?: string;
	count: string;
};
