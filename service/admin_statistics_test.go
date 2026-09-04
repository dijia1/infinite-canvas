package service

import (
	"testing"
	"time"

	"github.com/basketikun/infinite-canvas/model"
	"github.com/shopspring/decimal"
)

func TestValidateImageCallAmount(t *testing.T) {
	tests := []struct {
		value string
		valid bool
	}{
		{value: "0", valid: true},
		{value: "12.3456", valid: true},
		{value: "99999999.9999", valid: true},
		{value: "-0.0001", valid: false},
		{value: "1.00001", valid: false},
		{value: "100000000", valid: false},
	}
	for _, test := range tests {
		amount, err := decimal.NewFromString(test.value)
		if err != nil {
			t.Fatalf("decimal.NewFromString(%q): %v", test.value, err)
		}
		err = validateImageCallAmount(amount)
		if (err == nil) != test.valid {
			t.Errorf("validateImageCallAmount(%q) error = %v, valid = %t", test.value, err, test.valid)
		}
	}
}

func TestResolveStatisticsRangeUsesInclusiveShanghaiCalendarDates(t *testing.T) {
	reference := time.Date(2026, time.September, 4, 16, 30, 0, 0, time.UTC)

	period, err := resolveStatisticsRange("2026-08-30", "2026-09-04", reference)
	if err != nil {
		t.Fatal(err)
	}
	if period.StartDate != "2026-08-30" || period.EndDate != "2026-09-04" {
		t.Fatalf("period dates = %#v", period)
	}
	if period.StartUTC.Format(time.RFC3339) != "2026-08-29T16:00:00Z" || period.EndUTC.Format(time.RFC3339) != "2026-09-04T16:00:00Z" {
		t.Fatalf("period UTC bounds = %s to %s", period.StartUTC.Format(time.RFC3339), period.EndUTC.Format(time.RFC3339))
	}
}

func TestResolveStatisticsRangeDefaultsToShanghaiTodayAndRejectsInvalidInput(t *testing.T) {
	reference := time.Date(2026, time.September, 4, 16, 30, 0, 0, time.UTC)

	period, err := resolveStatisticsRange("", "", reference)
	if err != nil || period.StartDate != "2026-09-05" || period.EndDate != "2026-09-05" {
		t.Fatalf("default period = %#v, err = %v", period, err)
	}
	for _, input := range [][2]string{{"2026-09-01", ""}, {"2026-09-04", "2026-09-03"}, {"invalid", "2026-09-04"}} {
		if _, err := resolveStatisticsRange(input[0], input[1], reference); err == nil {
			t.Fatalf("resolveStatisticsRange(%q, %q) accepted invalid range", input[0], input[1])
		}
	}
}

func TestAggregateImageTaskStatisticsUsesSuccessfulTaskSnapshots(t *testing.T) {
	tasks := []model.ImageGenerationTask{
		{ID: "priced-1", Status: model.ImageTaskSucceeded, ProviderID: "doubao", ProviderName: "豆包", Amount: decimal.RequireFromString("0.1234"), AmountRecorded: true, ResultMediaIDsJSON: `["media-1","media-2"]`},
		{ID: "priced-2", Status: model.ImageTaskSucceeded, ProviderID: "doubao", ProviderName: "豆包", Amount: decimal.RequireFromString("0.2000"), AmountRecorded: true, ResultMediaIDsJSON: `["media-3"]`},
		{ID: "legacy", Status: model.ImageTaskSucceeded, ProviderID: "legacy", ProviderName: "旧模型", AmountRecorded: false, ResultMediaIDsJSON: `["media-4","media-5"]`},
	}

	result := aggregateImageTaskStatistics(tasks, map[string]string{})
	if !result.Amount.Equal(decimal.RequireFromString("0.3234")) || result.ImageCount != 5 || result.UnpricedImageCount != 2 {
		t.Fatalf("summary = %#v", result)
	}
	if len(result.Models) != 2 {
		t.Fatalf("models = %#v", result.Models)
	}
	models := make(map[string]ImageModelStatistics, len(result.Models))
	for _, item := range result.Models {
		models[item.ProviderID] = item
	}
	if got := models["doubao"]; got.ProviderName != "豆包" || got.SuccessfulCalls != 2 || got.ImageCount != 3 || got.UnpricedImageCount != 0 || !got.Amount.Equal(decimal.RequireFromString("0.3234")) {
		t.Fatalf("priced model = %#v", got)
	}
	if got := models["legacy"]; got.SuccessfulCalls != 1 || got.ImageCount != 2 || got.UnpricedImageCount != 2 || !got.Amount.IsZero() {
		t.Fatalf("legacy model = %#v", got)
	}
}

func TestAggregateImageTaskStatisticsGroupsUserModelsAndRetainsHistoricalMembers(t *testing.T) {
	tasks := []model.ImageGenerationTask{
		{ID: "alice-a", OwnerUID: "alice", Status: model.ImageTaskSucceeded, ProviderID: "doubao", ProviderName: "豆包", Amount: decimal.RequireFromString("0.2000"), AmountRecorded: true, ResultMediaIDsJSON: `["media-1"]`},
		{ID: "alice-b", OwnerUID: "alice", Status: model.ImageTaskSucceeded, ProviderID: "maizi", ProviderName: "麦子", Amount: decimal.RequireFromString("0.3000"), AmountRecorded: true, ResultMediaIDsJSON: `["media-2","media-3"]`},
		{ID: "former-member", OwnerUID: "removed", Status: model.ImageTaskSucceeded, ProviderID: "doubao", ProviderName: "豆包", AmountRecorded: false, ResultMediaIDsJSON: `["media-4"]`},
	}

	result := aggregateImageTaskStatistics(tasks, map[string]string{"alice": "张三", "removed": "离职成员"})
	if len(result.Users) != 2 || result.Users[0].UserUID != "alice" || !result.Users[0].Amount.Equal(decimal.RequireFromString("0.5000")) || result.Users[0].SuccessfulCalls != 2 || result.Users[0].ImageCount != 3 {
		t.Fatalf("users = %#v", result.Users)
	}
	if len(result.Users[0].Models) != 2 || result.Users[0].Models[0].ProviderName != "麦子" || result.Users[0].Models[0].SuccessfulCalls != 1 {
		t.Fatalf("alice models = %#v", result.Users[0].Models)
	}
	if result.Users[1].DisplayName != "离职成员" || result.Users[1].UnpricedImageCount != 1 || !result.Users[1].Amount.IsZero() {
		t.Fatalf("historical member = %#v", result.Users[1])
	}
}
