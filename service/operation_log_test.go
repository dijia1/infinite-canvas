package service

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/repository"
	"github.com/shopspring/decimal"
)

func TestListOperationLogsProjectsCurrentImageTaskStatesAndPreservesUnlinkedHistory(t *testing.T) {
	const actor = "task5-image-audit-owner"
	database, err := repository.DB()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = database.Where("owner_uid = ?", actor).Delete(&model.ImageGenerationTask{}).Error
		_ = database.Where("actor_uid = ?", actor).Delete(&model.OperationLog{}).Error
	})
	createdAt := time.Now().UTC()
	fixtures := []struct {
		taskID, operationID, action string
		taskStatus                  model.ImageGenerationTaskStatus
		operationStatus             model.OperationStatus
		errorMessage                string
	}{
		{"task5-image-processing", "task5-operation-processing", "image_crop", model.ImageTaskRunning, model.OperationStatusSubmitted, ""},
		{"task5-image-uncertain", "task5-operation-uncertain", "image_edit", model.ImageTaskUncertain, model.OperationStatusSubmitted, "请核对供应商任务"},
		{"task5-image-succeeded", "task5-operation-succeeded", "image_angle", model.ImageTaskSucceeded, model.OperationStatusSuccess, ""},
	}
	for _, fixture := range fixtures {
		task := model.ImageGenerationTask{
			ID: fixture.taskID, OwnerUID: actor, ClientRequestID: fixture.taskID,
			Status: fixture.taskStatus, OperationLogID: fixture.operationID,
			ProviderID: "image-provider", ProviderName: "安全图片模型", ProviderTaskID: "upstream-" + fixture.taskID,
			ProviderConfig: `{"apiKey":"task5-secret"}`, RequestSummary: `{"url":"https://signed.example/input"}`,
			Quality: "high", Size: "16:9", Resolution: "2k", OutputFormat: "png", Background: "opaque",
			Amount: decimal.RequireFromString("1.25"), AmountRecorded: true, ErrorMessage: fixture.errorMessage,
			CreatedAt: createdAt.Format(time.RFC3339Nano), UpdatedAt: createdAt.Format(time.RFC3339Nano),
		}
		operation := model.OperationLog{
			ID: fixture.operationID, ActorUID: actor, ActorName: "审计用户", Action: fixture.action,
			Status: fixture.operationStatus, TargetType: "image_generation", TargetID: fixture.taskID,
			ProviderTaskID: "stale-upstream", RequestSummary: `{"raw":"task5-secret","url":"https://signed.example/input"}`, CreatedAt: createdAt,
		}
		if _, inserted, err := repository.CreateImageGenerationTaskWithOperationLog(task, operation); err != nil || !inserted {
			t.Fatalf("seed %s inserted=%t err=%v", fixture.taskID, inserted, err)
		}
	}
	if err := repository.SaveOperationLog(model.OperationLog{
		ID: "task5-operation-unlinked", ActorUID: actor, ActorName: "历史用户", Action: "image_edit",
		Status: model.OperationStatusSubmitted, ProviderTaskID: "historical-upstream", RequestSummary: "historical-summary", CreatedAt: createdAt.Add(-time.Second),
	}); err != nil {
		t.Fatal(err)
	}

	result, err := ListOperationLogs(model.OperationLogQuery{Actor: actor, PageSize: 20})
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(result)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(encoded), "task5-secret") || strings.Contains(string(encoded), "https://signed.example") {
		t.Fatalf("linked image audit leaked raw or sensitive task data: %s", encoded)
	}
	var payload struct {
		Items []map[string]any `json:"items"`
	}
	if err := json.Unmarshal(encoded, &payload); err != nil {
		t.Fatal(err)
	}
	byID := make(map[string]map[string]any, len(payload.Items))
	for _, item := range payload.Items {
		byID[item["id"].(string)] = item
	}
	for _, fixture := range fixtures {
		item := byID[fixture.operationID]
		image, ok := item["image"].(map[string]any)
		if !ok || image["taskId"] != fixture.taskID || image["status"] != string(fixture.taskStatus) || image["providerTaskId"] != "upstream-"+fixture.taskID {
			t.Fatalf("image projection for %s = %#v", fixture.operationID, item)
		}
		if item["status"] != string(fixture.operationStatus) || item["providerTaskId"] != "upstream-"+fixture.taskID {
			t.Fatalf("coarse operation fields for %s = %#v", fixture.operationID, item)
		}
		if _, exists := item["requestSummary"]; exists {
			t.Fatalf("linked image operation exposed raw request summary: %#v", item)
		}
	}
	if uncertain := byID["task5-operation-uncertain"]; uncertain["errorMessage"] != "请核对供应商任务" {
		t.Fatalf("uncertain image error = %#v", uncertain)
	}
	unlinked := byID["task5-operation-unlinked"]
	if _, exists := unlinked["image"]; exists || unlinked["requestSummary"] != "historical-summary" || unlinked["providerTaskId"] != "historical-upstream" {
		t.Fatalf("unlinked historical operation changed: %#v", unlinked)
	}
}
