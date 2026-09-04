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

type ImageStatistics struct {
	StartDate          string                 `json:"startDate"`
	EndDate            string                 `json:"endDate"`
	Timezone           string                 `json:"timezone"`
	Amount             decimal.Decimal        `json:"amount"`
	ImageCount         int                    `json:"imageCount"`
	UnpricedImageCount int                    `json:"unpricedImageCount"`
	Models             []ImageModelStatistics `json:"models"`
	Users              []ImageUserStatistics  `json:"users"`
}

type ImageModelStatistics struct {
	ProviderID         string          `json:"providerId"`
	ProviderName       string          `json:"providerName"`
	SuccessfulCalls    int             `json:"successfulCalls"`
	ImageCount         int             `json:"imageCount"`
	Amount             decimal.Decimal `json:"amount"`
	UnpricedImageCount int             `json:"unpricedImageCount"`
}

type ImageUserStatistics struct {
	UserUID            string                 `json:"userUid"`
	DisplayName        string                 `json:"displayName"`
	SuccessfulCalls    int                    `json:"successfulCalls"`
	ImageCount         int                    `json:"imageCount"`
	Amount             decimal.Decimal        `json:"amount"`
	UnpricedImageCount int                    `json:"unpricedImageCount"`
	Models             []ImageModelStatistics `json:"models"`
}

type statisticsRange struct {
	StartDate string
	EndDate   string
	StartUTC  time.Time
	EndUTC    time.Time
}

func AdminStatistics(startDate, endDate string) (ImageStatistics, error) {
	return Statistics(startDate, endDate, time.Now())
}

func Statistics(startDate, endDate string, reference time.Time) (ImageStatistics, error) {
	period, err := resolveStatisticsRange(startDate, endDate, reference)
	if err != nil {
		return ImageStatistics{}, err
	}
	tasks, err := repository.ListSucceededImageGenerationTasksFinishedBetween(period.StartUTC.Format(time.RFC3339), period.EndUTC.Format(time.RFC3339))
	if err != nil {
		return ImageStatistics{}, err
	}
	userUIDs := make([]string, 0, len(tasks))
	for _, task := range tasks {
		userUIDs = append(userUIDs, task.OwnerUID)
	}
	displayNames, err := repository.PortalMemberDisplayNames(userUIDs)
	if err != nil {
		return ImageStatistics{}, err
	}
	result := aggregateImageTaskStatistics(tasks, displayNames)
	result.StartDate = period.StartDate
	result.EndDate = period.EndDate
	result.Timezone = statisticsTimezone
	return result, nil
}

func resolveStatisticsRange(startDate, endDate string, reference time.Time) (statisticsRange, error) {
	location, err := time.LoadLocation(statisticsTimezone)
	if err != nil {
		return statisticsRange{}, err
	}
	startDate = strings.TrimSpace(startDate)
	endDate = strings.TrimSpace(endDate)
	if startDate == "" && endDate == "" {
		date := reference.In(location).Format("2006-01-02")
		startDate, endDate = date, date
	} else if startDate == "" || endDate == "" {
		return statisticsRange{}, safeMessageError{message: "开始日期和结束日期必须同时提供"}
	}

	start, err := time.ParseInLocation("2006-01-02", startDate, location)
	if err != nil {
		return statisticsRange{}, safeMessageError{message: "日期格式必须为 YYYY-MM-DD"}
	}
	end, err := time.ParseInLocation("2006-01-02", endDate, location)
	if err != nil {
		return statisticsRange{}, safeMessageError{message: "日期格式必须为 YYYY-MM-DD"}
	}
	if end.Before(start) {
		return statisticsRange{}, safeMessageError{message: "结束日期不能早于开始日期"}
	}
	return statisticsRange{
		StartDate: start.Format("2006-01-02"),
		EndDate:   end.Format("2006-01-02"),
		StartUTC:  start.UTC(),
		EndUTC:    end.AddDate(0, 0, 1).UTC(),
	}, nil
}

func aggregateImageTaskStatistics(tasks []model.ImageGenerationTask, displayNames map[string]string) ImageStatistics {
	result := ImageStatistics{
		Amount: decimal.Zero,
		Models: make([]ImageModelStatistics, 0),
		Users:  make([]ImageUserStatistics, 0),
	}
	byModel := make(map[string]*ImageModelStatistics)
	byUser := make(map[string]*ImageUserStatistics)
	userModels := make(map[string]map[string]*ImageModelStatistics)
	for _, task := range tasks {
		imageCount := imageTaskResultCount(task.ResultMediaIDsJSON)
		providerID := strings.TrimSpace(task.ProviderID)
		providerName := strings.TrimSpace(task.ProviderName)
		if providerName == "" {
			providerName = providerID
		}
		modelKey := providerID + "\x00" + providerName
		modelGroup := statisticsModelGroup(byModel, modelKey, providerID, providerName)

		userUID := strings.TrimSpace(task.OwnerUID)
		userGroup := byUser[userUID]
		if userGroup == nil {
			displayName := strings.TrimSpace(displayNames[userUID])
			if displayName == "" {
				displayName = userUID
			}
			userGroup = &ImageUserStatistics{UserUID: userUID, DisplayName: displayName, Amount: decimal.Zero, Models: make([]ImageModelStatistics, 0)}
			byUser[userUID] = userGroup
			userModels[userUID] = make(map[string]*ImageModelStatistics)
		}
		userModelGroup := statisticsModelGroup(userModels[userUID], modelKey, providerID, providerName)

		for _, group := range []*ImageModelStatistics{modelGroup, userModelGroup} {
			group.SuccessfulCalls++
			group.ImageCount += imageCount
		}
		userGroup.SuccessfulCalls++
		userGroup.ImageCount += imageCount
		result.ImageCount += imageCount
		if task.AmountRecorded {
			for _, group := range []*ImageModelStatistics{modelGroup, userModelGroup} {
				group.Amount = group.Amount.Add(task.Amount)
			}
			userGroup.Amount = userGroup.Amount.Add(task.Amount)
			result.Amount = result.Amount.Add(task.Amount)
		} else {
			for _, group := range []*ImageModelStatistics{modelGroup, userModelGroup} {
				group.UnpricedImageCount += imageCount
			}
			userGroup.UnpricedImageCount += imageCount
			result.UnpricedImageCount += imageCount
		}
	}
	for _, group := range byModel {
		result.Models = append(result.Models, *group)
	}
	sortImageModelStatistics(result.Models)
	for userUID, group := range byUser {
		for _, modelGroup := range userModels[userUID] {
			group.Models = append(group.Models, *modelGroup)
		}
		sortImageModelStatistics(group.Models)
		result.Users = append(result.Users, *group)
	}
	sort.Slice(result.Users, func(i, j int) bool {
		if result.Users[i].Amount.Equal(result.Users[j].Amount) {
			return result.Users[i].DisplayName < result.Users[j].DisplayName
		}
		return result.Users[i].Amount.GreaterThan(result.Users[j].Amount)
	})
	return result
}

func statisticsModelGroup(groups map[string]*ImageModelStatistics, key, providerID, providerName string) *ImageModelStatistics {
	group := groups[key]
	if group == nil {
		group = &ImageModelStatistics{ProviderID: providerID, ProviderName: providerName, Amount: decimal.Zero}
		groups[key] = group
	}
	return group
}

func sortImageModelStatistics(items []ImageModelStatistics) {
	sort.Slice(items, func(i, j int) bool {
		if items[i].Amount.Equal(items[j].Amount) {
			if items[i].ProviderName == items[j].ProviderName {
				return items[i].ProviderID < items[j].ProviderID
			}
			return items[i].ProviderName < items[j].ProviderName
		}
		return items[i].Amount.GreaterThan(items[j].Amount)
	})
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
