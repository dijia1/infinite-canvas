import type { AIModelChoice } from "@/lib/model-selection";

// Isolated capability fixture matching the registered Flash contract.
export const flashVideoModel: AIModelChoice = {
    id: "flash", name: "Seedance 2.5 Flash", type: "maizi-video-seedance-2-5-flash",
    videoRequestSchema: {
        resolutions: [{ value: "480p", label: "480p", price: "0.4" }, { value: "720p", label: "720p", price: "0.9" }],
        aspectRatios: ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9", "adaptive"],
        defaultResolution: "480p", defaultAspectRatio: "16:9",
        minDuration: 4, maxDuration: 30, defaultDuration: 5,
        maxReferenceImages: 6, maxReferenceVideos: 3, maxReferenceMedia: 6, maxReferenceVideoDuration: 15,
        supportsAudio: true,
    },
};
