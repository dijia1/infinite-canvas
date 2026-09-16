import assert from "node:assert/strict";
import test from "node:test";
import { defaultAiConfig, normalizePersistedAiConfig } from "./ai-config";
import { reconcileVideoConfig, videoDurationOptions, videoSupportsAudio } from "./video-config";
import type { VideoModelStatus } from "./video-config";

const status: VideoModelStatus = {
    videoModels: [
        {
            id: "a",
            name: "A",
            type: "video",
            videoRequestSchema: {
                resolutions: [
                    { value: "480p", label: "480p", price: "0.1" },
                    { value: "720p", label: "720p", price: "0.2" },
                ],
                aspectRatios: ["16:9"],
                minDuration: 4,
                maxDuration: 15,
                defaultDuration: 5,
                maxReferenceImages: 9,
                maxReferenceVideos: 3,
                maxReferenceVideoDuration: 15,
                supportsAudio: true,
            },
        },
        {
            id: "b",
            name: "B",
            type: "video",
            videoRequestSchema: {
                resolutions: [
                    { value: "1080p", label: "1080p", price: "0.5" },
                    { value: "720p", label: "720p", price: "0.4" },
                ],
                aspectRatios: ["9:16"],
                minDuration: 5,
                maxDuration: 15,
                defaultDuration: 5,
                maxReferenceImages: 9,
                maxReferenceVideos: 0,
                maxReferenceVideoDuration: 0,
                supportsAudio: false,
            },
        },
    ],
};

test("video resolution initializes from administrator order and removes invalid legacy values", () => {
    for (const vquality of [null, "", "720", "removed"]) {
        assert.equal(reconcileVideoConfig({ ...defaultAiConfig, videoProviderId: "a", vquality }, status).vquality, "480p");
    }
    assert.equal(reconcileVideoConfig({ ...defaultAiConfig, videoProviderId: "a", vquality: "720p" }, status).vquality, "720p");
});
test("switching models resets even a shared valid choice and uses matching price", () => {
    const next = reconcileVideoConfig({ ...defaultAiConfig, videoProviderId: "b", vquality: "720p", videoSize: "16:9", videoSeconds: "4", generateAudio: "true" }, status, true);
    assert.equal(next.vquality, "1080p");
    assert.equal(next.videoSize, "9:16");
    assert.equal(next.videoSeconds, "5");
    assert.equal(next.generateAudio, "false");
    assert.equal(status.videoModels![1].videoRequestSchema?.resolutions.find((r) => r.value === next.vquality)?.price, "0.5");
});
test("loading preserves saved state; loaded empty options become persisted null", () => {
    const config = { ...defaultAiConfig, videoProviderId: "a", vquality: "720" };
    assert.equal(reconcileVideoConfig(config, null), config);
    assert.equal(reconcileVideoConfig(config, status).vquality, "480p");
    const next = reconcileVideoConfig(config, { videoModels: [] });
    assert.equal(next.vquality, null);
    assert.equal(normalizePersistedAiConfig(JSON.parse(JSON.stringify(next))).vquality, null);
    assert.equal(reconcileVideoConfig(next, { videoModels: [] }), next);
});

test("MiniMax H3 capability drives duration choices and hides audio", () => {
    const schema = status.videoModels![1].videoRequestSchema;
    assert.deepEqual(
        videoDurationOptions(schema).map((option) => option.value),
        ["5", "6", "7", "8", "9", "10", "11", "12", "13", "14", "15"],
    );
    assert.equal(videoSupportsAudio(schema), false);
    assert.equal(videoSupportsAudio(undefined), true);
});
