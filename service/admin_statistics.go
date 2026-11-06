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
	Video              VideoStatistics        `json:"video"`
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
	ProviderID         string                      `json:"providerId"`
	ProviderName       string                      `json:"providerName"`
	SuccessfulCalls    int                         `json:"successfulCalls"`
	ImageCount         int                         `json:"imageCount"`
	Amount             decimal.Decimal             `json:"amount"`
	UnpricedImageCount int                         `json:"unpricedImageCount"`
	Resolutions        []ImageResolutionStatistics `json:"resolutions"`
}

type ImageResolutionStatistics struct {
	Resolution         string          `json:"resolution"`
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
	tasks, err := repository.ListSucceededImageGenerationTasksFinishedBetween(period.StartUTC, period.EndUTC)
	if err != nil {
		return ImageStatistics{}, err
	}
	videoTasks, err := repository.ListSucceededVideoGenerationTasksFinishedBetween(period.StartUTC, period.EndUTC)
	if err != nil {
		return ImageStatistics{}, err
	}
	userUIDs := make([]string, 0, len(tasks)+len(videoTasks))
	for _, task := range videoTasks {
		userUIDs = append(userUIDs, task.OwnerUID)
	}
	for _, task := range tasks {
		userUIDs = append(userUIDs, task.OwnerUID)
	}
	displayNames, err := repository.PortalMemberDisplayNames(userUIDs)
	if err != nil {
		return ImageStatistics{}, err
	}
	result := aggregateImageTaskStatistics(tasks, displayNames)
	result.Video = aggregateVideoTaskStatistics(videoTasks, displayNames)
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
	modelResolutions := make(map[string]map[string]*ImageResolutionStatistics)
	byUser := make(map[string]*ImageUserStatistics)
	userModels := make(map[string]map[string]*ImageModelStatistics)
	userModelResolutions := make(map[string]map[string]map[string]*ImageResolutionStatistics)
	for _, task := range tasks {
		imageCount := imageTaskResultCount(task.ResultMediaIDsJSON)
		providerID := strings.TrimSpace(task.ProviderID)
		providerName := strings.TrimSpace(task.ProviderName)
		if providerName == "" {
			providerName = providerID
		}
		modelKey := providerID + "\x00" + providerName
		modelGroup := statisticsModelGroup(byModel, modelKey, providerID, providerName)
		modelResolutionGroup := statisticsResolutionGroup(modelResolutions, modelKey, task.Resolution)

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
			userModelResolutions[userUID] = make(map[string]map[string]*ImageResolutionStatistics)
		}
		userModelGroup := statisticsModelGroup(userModels[userUID], modelKey, providerID, providerName)
		userResolutionGroup := statisticsResolutionGroup(userModelResolutions[userUID], modelKey, task.Resolution)

		for _, group := range []*ImageModelStatistics{modelGroup, userModelGroup} {
			group.SuccessfulCalls++
			group.ImageCount += imageCount
		}
		for _, group := range []*ImageResolutionStatistics{modelResolutionGroup, userResolutionGroup} {
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
			for _, group := range []*ImageResolutionStatistics{modelResolutionGroup, userResolutionGroup} {
				group.Amount = group.Amount.Add(task.Amount)
			}
			userGroup.Amount = userGroup.Amount.Add(task.Amount)
			result.Amount = result.Amount.Add(task.Amount)
		} else {
			for _, group := range []*ImageModelStatistics{modelGroup, userModelGroup} {
				group.UnpricedImageCount += imageCount
			}
			for _, group := range []*ImageResolutionStatistics{modelResolutionGroup, userResolutionGroup} {
				group.UnpricedImageCount += imageCount
			}
			userGroup.UnpricedImageCount += imageCount
			result.UnpricedImageCount += imageCount
		}
	}
	for modelKey, group := range byModel {
		group.Resolutions = resolutionStatistics(modelResolutions[modelKey])
		result.Models = append(result.Models, *group)
	}
	sortImageModelStatistics(result.Models)
	for userUID, group := range byUser {
		for modelKey, modelGroup := range userModels[userUID] {
			modelGroup.Resolutions = resolutionStatistics(userModelResolutions[userUID][modelKey])
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
		group = &ImageModelStatistics{ProviderID: providerID, ProviderName: providerName, Amount: decimal.Zero, Resolutions: make([]ImageResolutionStatistics, 0)}
		groups[key] = group
	}
	return group
}

func statisticsResolutionGroup(groups map[string]map[string]*ImageResolutionStatistics, modelKey, resolution string) *ImageResolutionStatistics {
	resolution = strings.TrimSpace(resolution)
	resolutionKey := strings.ToLower(resolution)
	modelGroups := groups[modelKey]
	if modelGroups == nil {
		modelGroups = make(map[string]*ImageResolutionStatistics)
		groups[modelKey] = modelGroups
	}
	group := modelGroups[resolutionKey]
	if group == nil {
		group = &ImageResolutionStatistics{Resolution: resolution, Amount: decimal.Zero}
		modelGroups[resolutionKey] = group
	}
	return group
}

func resolutionStatistics(groups map[string]*ImageResolutionStatistics) []ImageResolutionStatistics {
	items := make([]ImageResolutionStatistics, 0, len(groups))
	for _, group := range groups {
		items = append(items, *group)
	}
	sort.Slice(items, func(i, j int) bool {
		if items[i].Amount.Equal(items[j].Amount) {
			return strings.ToLower(items[i].Resolution) < strings.ToLower(items[j].Resolution)
		}
		return items[i].Amount.GreaterThan(items[j].Amount)
	})
	return items
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
