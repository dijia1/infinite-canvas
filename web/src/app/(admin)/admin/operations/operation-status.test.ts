import assert from "node:assert/strict";
import test from "node:test";

import type { OperationLog } from "@/services/api/operation-logs";

import { generationStatusOptions, operationStatusPresentation } from "./operation-status";

const operation = (overrides: Partial<OperationLog> = {}): OperationLog => ({
    id: "operation",
    actorUid: "actor",
    actorName: "Actor",
    actorRoles: [],
    action: "image_generate",
    status: "submitted",
    targetType: "image_generation",
    targetId: "task",
    targetName: "",
    prompt: "",
    mediaIds: [],
    errorMessage: "",
    createdAt: "2026-09-14T00:00:00Z",
    ...overrides,
});

test("linked generation state takes precedence over the coarse operation status", () => {
    const uncertainImage = operation({
        image: {
            taskId: "image-task",
            status: "uncertain",
            providerId: "image-provider",
            providerName: "Image Provider",
            providerTaskId: "upstream-image",
            quality: "high",
            size: "16:9",
            resolution: "2k",
            outputFormat: "png",
            background: "opaque",
            amount: "1.25",
        },
    });
    assert.deepEqual(operationStatusPresentation(uncertainImage), { status: "uncertain", label: "结果不确定", color: "orange" });

    const runningVideo = operation({
        video: {
            taskId: "video-task",
            status: "running",
            providerId: "video-provider",
            providerName: "Video Provider",
            providerTaskId: "upstream-video",
            seconds: 5,
            size: "16:9",
            resolution: "720p",
            generateAudio: false,
            amount: "2.50",
        },
    });
    assert.deepEqual(operationStatusPresentation(runningVideo), { status: "running", label: "生成中", color: "processing" });
    assert.deepEqual(operationStatusPresentation(operation()), { status: "submitted", label: "已提交", color: "blue" });
});

test("generation status filter options use the shared image and video task semantics", () => {
    assert.deepEqual(
        generationStatusOptions.find((item) => item.value === "uncertain"),
        { value: "uncertain", label: "任务 · 结果不确定" },
    );
    assert.equal(generationStatusOptions.filter((item) => item.value === "running").length, 1);
});
