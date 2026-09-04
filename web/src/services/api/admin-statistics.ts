import type { StatisticsRange } from "@/lib/statistics-range";

import { apiGet } from "./request";

export type StatisticsModel = {
    providerId: string;
    providerName: string;
    successfulCalls: number;
    imageCount: number;
    amount: string;
    unpricedImageCount: number;
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
    startDate: string;
    endDate: string;
    timezone: string;
    amount: string;
    imageCount: number;
    unpricedImageCount: number;
    models: StatisticsModel[];
    users: StatisticsUser[];
};

export async function fetchStatistics(token: string, range: StatisticsRange) {
    return apiGet<Statistics>("/api/admin/statistics", range, token);
}
