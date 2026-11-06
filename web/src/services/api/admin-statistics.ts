import type { StatisticsRange } from "@/lib/statistics-range";

import { apiGet } from "./request";

export type StatisticsResolution = {
    resolution: string;
    successfulCalls: number;
    imageCount: number;
    amount: string;
    unpricedImageCount: number;
};

export type StatisticsModel = {
    providerId: string;
    providerName: string;
    successfulCalls: number;
    imageCount: number;
    amount: string;
    unpricedImageCount: number;
    resolutions: StatisticsResolution[];
};

export type StatisticsUser = {
    userUid: string;
    displayName: string;
    successfulCalls: number;
    imageCount: number;
    amount: string;
    unpricedImageCount: number;
    models: StatisticsModel[];
};

export type Statistics = {
    video?: VideoStatistics;
    startDate: string;
    endDate: string;
    timezone: string;
    amount: string;
    imageCount: number;
    unpricedImageCount: number;
    models: StatisticsModel[];
    users: StatisticsUser[];
};

export async function fetchStatistics(range: StatisticsRange) {
    return apiGet<Statistics>("/api/admin/statistics", range);
}

export type VideoStatisticsTotals = {
    successfulCalls: number;
    videoCount: number;
    seconds: number;
    amount: string;
    upstreamCosts: Record<string, string>;
};
export type VideoStatisticsResolution = VideoStatisticsTotals & { resolution: string };
export type VideoStatisticsModel = VideoStatisticsTotals & { providerId: string; providerName: string; resolutions: VideoStatisticsResolution[] };
export type VideoStatisticsUser = VideoStatisticsTotals & { userUid: string; displayName: string; models: VideoStatisticsModel[] };
export type VideoStatistics = VideoStatisticsTotals & { models: VideoStatisticsModel[]; users: VideoStatisticsUser[] };
