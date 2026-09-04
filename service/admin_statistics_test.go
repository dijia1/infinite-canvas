package service

import (
	"testing"

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

func TestAggregateTodayImageTaskStatisticsUsesSuccessfulTaskSnapshots(t *testing.T) {
	tasks := []model.ImageGenerationTask{
		{ID: "priced-1", Status: model.ImageTaskSucceeded, ProviderID: "doubao", ProviderName: "豆包", Amount: decimal.RequireFromString("0.1234"), AmountRecorded: true, ResultMediaIDsJSON: `["media-1","media-2"]`},
		{ID: "priced-2", Status: model.ImageTaskSucceeded, ProviderID: "doubao", ProviderName: "豆包", Amount: decimal.RequireFromString("0.2000"), AmountRecorded: true, ResultMediaIDsJSON: `["media-3"]`},
		{ID: "legacy", Status: model.ImageTaskSucceeded, ProviderID: "legacy", ProviderName: "旧模型", AmountRecorded: false, ResultMediaIDsJSON: `["media-4","media-5"]`},
	}

	result := aggregateTodayImageTaskStatistics(tasks)
	if !result.Amount.Equal(decimal.RequireFromString("0.3234")) || result.ImageCount != 5 || result.UnpricedImageCount != 2 {
		t.Fatalf("summary = %#v", result)
	}
	if len(result.Models) != 2 {
		t.Fatalf("models = %#v", result.Models)
	}
	models := make(map[string]TodayImageModelStatistics, len(result.Models))
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
