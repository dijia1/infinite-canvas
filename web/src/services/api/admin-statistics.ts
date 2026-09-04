import { apiGet } from "./request";

export type TodayStatisticsModel = {
    providerId: string;
    providerName: string;
    successfulCalls: number;
    imageCount: number;
    amount: string;
    unpricedImageCount: number;
};

export type TodayStatistics = {
    date: string;
    timezone: string;
    amount: string;
    imageCount: number;
    unpricedImageCount: number;
    models: TodayStatisticsModel[];
};

export async function fetchTodayStatistics(token: string) {
    return apiGet<TodayStatistics>("/api/admin/statistics/today", undefined, token);
}
