package service

import (
	"encoding/json"
	"sort"
	"strings"
	"time"

	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/repository"
	"github.com/shopspring/decimal"
)

const statisticsTimezone = "Asia/Shanghai"

type TodayImageStatistics struct {
	Date               string                      `json:"date"`
	Timezone           string                      `json:"timezone"`
	Amount             decimal.Decimal             `json:"amount"`
	ImageCount         int                         `json:"imageCount"`
	UnpricedImageCount int                         `json:"unpricedImageCount"`
	Models             []TodayImageModelStatistics `json:"models"`
}

type TodayImageModelStatistics struct {
	ProviderID         string          `json:"providerId"`
	ProviderName       string          `json:"providerName"`
	SuccessfulCalls    int             `json:"successfulCalls"`
	ImageCount         int             `json:"imageCount"`
	Amount             decimal.Decimal `json:"amount"`
	UnpricedImageCount int             `json:"unpricedImageCount"`
}

func TodayStatistics(reference time.Time) (TodayImageStatistics, error) {
	location, err := time.LoadLocation(statisticsTimezone)
	if err != nil {
		return TodayImageStatistics{}, err
	}
	localNow := reference.In(location)
	start := time.Date(localNow.Year(), localNow.Month(), localNow.Day(), 0, 0, 0, 0, location)
	end := start.AddDate(0, 0, 1)
	items, err := repository.ListSucceededImageGenerationTasksFinishedBetween(start.UTC().Format(time.RFC3339), end.UTC().Format(time.RFC3339))
	if err != nil {
		return TodayImageStatistics{}, err
	}
	costs, err := repository.ListSucceededImageGenerationTaskCostSummariesFinishedBetween(start.UTC().Format(time.RFC3339), end.UTC().Format(time.RFC3339))
	if err != nil {
		return TodayImageStatistics{}, err
	}
	result := aggregateTodayImageTaskStatistics(items)
	applyImageTaskCostSummaries(&result, costs)
	result.Date = start.Format("2006-01-02")
	result.Timezone = statisticsTimezone
	return result, nil
}

func applyImageTaskCostSummaries(result *TodayImageStatistics, summaries []repository.ImageGenerationTaskCostSummary) {
	byProvider := make(map[string]*TodayImageModelStatistics, len(result.Models))
	for index := range result.Models {
		item := &result.Models[index]
		byProvider[item.ProviderID+"\x00"+item.ProviderName] = item
	}
	result.Amount = decimal.Zero
	for _, summary := range summaries {
		providerName := strings.TrimSpace(summary.ProviderName)
		if providerName == "" {
			providerName = strings.TrimSpace(summary.ProviderID)
		}
		if item := byProvider[summary.ProviderID+"\x00"+providerName]; item != nil {
			item.SuccessfulCalls = summary.SuccessfulCalls
			item.Amount = summary.Amount
		}
		result.Amount = result.Amount.Add(summary.Amount)
	}
}

func AdminTodayStatistics() (TodayImageStatistics, error) {
	return TodayStatistics(time.Now())
}

func aggregateTodayImageTaskStatistics(tasks []model.ImageGenerationTask) TodayImageStatistics {
	result := TodayImageStatistics{Amount: decimal.Zero, Models: make([]TodayImageModelStatistics, 0)}
	byProvider := make(map[string]*TodayImageModelStatistics)
	for _, task := range tasks {
		imageCount := imageTaskResultCount(task.ResultMediaIDsJSON)
		providerID := strings.TrimSpace(task.ProviderID)
		providerName := strings.TrimSpace(task.ProviderName)
		if providerName == "" {
			providerName = providerID
		}
		key := providerID + "\x00" + providerName
		group := byProvider[key]
		if group == nil {
			group = &TodayImageModelStatistics{ProviderID: providerID, ProviderName: providerName, Amount: decimal.Zero}
			byProvider[key] = group
		}
		group.SuccessfulCalls++
		group.ImageCount += imageCount
		result.ImageCount += imageCount
		if task.AmountRecorded {
			group.Amount = group.Amount.Add(task.Amount)
			result.Amount = result.Amount.Add(task.Amount)
		} else {
			group.UnpricedImageCount += imageCount
			result.UnpricedImageCount += imageCount
		}
	}
	for _, group := range byProvider {
		result.Models = append(result.Models, *group)
	}
	sort.Slice(result.Models, func(i, j int) bool {
		if result.Models[i].ProviderName == result.Models[j].ProviderName {
			return result.Models[i].ProviderID < result.Models[j].ProviderID
		}
		return result.Models[i].ProviderName < result.Models[j].ProviderName
	})
	return result
}

func imageTaskResultCount(raw string) int {
	var ids []string
	if err := json.Unmarshal([]byte(raw), &ids); err != nil {
		return 0
	}
	count := 0
	for _, id := range ids {
		if strings.TrimSpace(id) != "" {
			count++
		}
	}
	return count
}
