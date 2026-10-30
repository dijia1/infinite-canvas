package service

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/basketikun/infinite-canvas/ai"
	_ "github.com/basketikun/infinite-canvas/ai/providers"
	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/repository"
	"github.com/shopspring/decimal"
)

type seedreamNSFWTestTransport func(*http.Request) (*http.Response, error)

func (fn seedreamNSFWTestTransport) RoundTrip(r *http.Request) (*http.Response, error) { return fn(r) }

func TestMaiziSeedreamNSFWSettingsAndTaskRecovery(t *testing.T) {
	original, err := AdminSettings()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if _, err := saveGenerationSettingsForTest(t, original); err != nil {
			t.Error(err)
		}
	})
	ordinary := model.AIProvider{ID: newID("ordinary"), Name: "普通模型", Type: "maizi-image", Enabled: true, Config: json.RawMessage(`{"apiKey":"ordinary-key","model":"ordinary-model"}`), AspectRatios: []string{"1:1"}, ImagePrices: []model.ImageResolutionPrice{{Resolution: "1K", Amount: decimal.RequireFromString("0.1")}}}
	nsfw := model.AIProvider{ID: newID("nsfw"), Name: "Seedream Pro NSFW", Type: "maizi-seedream-5-pro-nsfw", Enabled: true, Config: json.RawMessage(`{"apiKey":"nsfw-key","model":"admin-configured-pro"}`), AspectRatios: []string{"3:4", "1:1"}, ImagePrices: []model.ImageResolutionPrice{{Resolution: "1K", Amount: decimal.RequireFromString("0.35")}, {Resolution: "2K", Amount: decimal.RequireFromString("0.65")}}}
	settings := original
	settings.AI = model.AISettings{ImageProviderID: ordinary.ID, Providers: []model.AIProvider{ordinary, nsfw}}
	if _, err = SaveSettings(settings); err != nil {
		t.Fatal(err)
	}
	status, err := PublicSettings()
	if err != nil || status.DefaultImageModelID != ordinary.ID || len(status.ImageModels) != 2 {
		t.Fatalf("public=%+v err=%v", status, err)
	}
	var schema *ai.ImageRequestSchema
	for _, choice := range status.ImageModels {
		if choice.ID == nsfw.ID {
			schema = choice.ImageRequestSchema
		}
	}
	if schema == nil || schema.SupportsMask || schema.MaxReferenceImages != 10 {
		t.Fatalf("public schema=%+v", schema)
	}
	encoded, _ := json.Marshal(status)
	if strings.Contains(string(encoded), "nsfw-key") || strings.Contains(string(encoded), "admin-configured-pro") {
		t.Fatal("public settings leaked private config")
	}
	if schema.Fields[0].Options[0].Value != "3:4" || schema.Fields[1].Options[1].Price != "0.65" {
		t.Fatalf("administrator options missing: %+v", schema.Fields)
	}

	request := CreateImageTaskRequest{ClientRequestID: newID("client"), ProviderID: nsfw.ID, Mode: ImageTaskModeGeneration, Request: ai.ImageRequest{Prompt: "产品摄影", Count: 1, Size: "3:4", Resolution: "2K"}}
	ctx := WithPortalUser(context.Background(), PortalUser{UID: newID("owner")})
	view, err := CreateImageTask(ctx, request)
	if err != nil {
		t.Fatal(err)
	}
	item, found, err := repository.GetImageGenerationTask(view.ID)
	if err != nil || !found || item.ProviderType != nsfw.Type || !item.Amount.Equal(decimal.RequireFromString("0.65")) {
		t.Fatalf("task=%+v err=%v", item, err)
	}
	var savedConfig map[string]string
	if err := json.Unmarshal([]byte(item.ProviderConfig), &savedConfig); err != nil || savedConfig["apiKey"] != "nsfw-key" || savedConfig["model"] != "admin-configured-pro" {
		t.Fatalf("provider snapshot does not match the selected configuration: %v", err)
	}
	if !strings.Contains(item.RequestSummary, `"nsfw_check":false`) || strings.Contains(item.RequestSummary, "nsfw-key") {
		t.Fatalf("summary=%s", item.RequestSummary)
	}

	// Changing live settings must not change the already-created task's provider snapshot.
	changed, err := AdminSettings()
	if err != nil {
		t.Fatal(err)
	}
	changed.AI.Providers[1].Enabled = false
	changed.AI.Providers[1].Config = json.RawMessage(`{"apiKey":"changed-key","model":"changed-model"}`)
	if _, err = SaveSettings(changed); err != nil {
		t.Fatal(err)
	}
	replay, err := CreateImageTask(ctx, request)
	if err != nil || replay.ID != view.ID {
		t.Fatalf("replay=%+v err=%v", replay, err)
	}

	originalTransport := http.DefaultTransport
	t.Cleanup(func() { http.DefaultTransport = originalTransport })
	posts, polls := 0, 0
	http.DefaultTransport = seedreamNSFWTestTransport(func(r *http.Request) (*http.Response, error) {
		if r.URL.Host != "www.maizitech.ai" || r.Header.Get("Authorization") != "Bearer nsfw-key" {
			t.Fatalf("snapshot request=%s header incorrect", r.URL)
		}
		body := `{"id":"accepted-original","status":"violation","error_msg":"上游拒绝"}`
		if r.Method == http.MethodPost {
			posts++
			var payload map[string]any
			if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
				t.Fatal(err)
			}
			if payload["model"] != "admin-configured-pro" || payload["nsfw_check"] != false || payload["size"] != "3:4" {
				t.Fatalf("payload=%+v", payload)
			}
			body = `{"data":[{"task_id":"accepted-original","status":"processing"}]}`
		} else {
			polls++
			if r.URL.Path != "/v1/tasks/accepted-original" {
				t.Fatalf("poll=%s", r.URL)
			}
		}
		return &http.Response{StatusCode: http.StatusOK, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(body))}, nil
	})
	// Simulate recovery with an upstream ID: it must only poll, never submit again.
	lease := time.Now().UTC().Add(time.Minute)
	db, _ := repository.DB()
	item.Status = model.ImageTaskRunning
	item.ProviderTaskID = "accepted-original"
	item.ClaimID = newID("claim")
	item.LeaseUntil = &lease
	if err := db.Model(&model.ImageGenerationTask{}).Where("id = ?", item.ID).Updates(map[string]any{"status": item.Status, "provider_task_id": item.ProviderTaskID, "claim_id": item.ClaimID, "lease_until": lease}).Error; err != nil {
		t.Fatal(err)
	}
	executeImageTask(ctx, item)
	saved, _, err := repository.GetImageGenerationTask(item.ID)
	if err != nil || saved.Status != model.ImageTaskFailed || saved.ErrorMessage != "上游拒绝" || saved.ProviderTaskID != "accepted-original" || saved.FinishedAt == "" || saved.ClaimID != "" || saved.LeaseUntil != nil || posts != 0 || polls != 1 {
		t.Fatalf("saved=%+v posts=%d polls=%d err=%v", saved, posts, polls, err)
	}
	var operation model.OperationLog
	if err := db.First(&operation, "id = ?", saved.OperationLogID).Error; err != nil {
		t.Fatal(err)
	}
	if operation.Status != model.OperationStatusFailure || operation.ErrorMessage != "上游拒绝" {
		t.Fatalf("operation=%+v", operation)
	}
	canvasView, err := imageTaskView(ctx, PortalUser{UID: saved.OwnerUID}, saved)
	if err != nil || canvasView.Status != "failed" || canvasView.Error != "上游拒绝" || len(canvasView.Images) != 0 {
		t.Fatalf("canvas=%+v err=%v", canvasView, err)
	}
	clearWorkflowRuntimeTables(t)
	t.Cleanup(func() { clearWorkflowRuntimeTables(t) })
	run := seedWorkflowImageRun(t, newID("nsfw-workflow-run"), saved.OwnerUID)
	if err := reevaluateWorkflowRun(run.OwnerUID, run.ID); err != nil {
		t.Fatal(err)
	}
	attempt, found, err := repository.ClaimWorkflowAttempt(4, 2, true, time.Now().UTC(), time.Minute)
	if err != nil || !found {
		t.Fatalf("claim=%t err=%v", found, err)
	}
	attempt.TaskID, attempt.TaskType = saved.ID, "image"
	if err := applyWorkflowImageView(attempt, canvasView); err != nil {
		t.Fatal(err)
	}
	record, found, err := repository.GetWorkflowRun(run.OwnerUID, run.ID)
	if err != nil || !found || len(record.Outputs) != 1 || record.Outputs[0].Status != "failed" || record.Attempts[0].Error != "上游拒绝" {
		t.Fatalf("workflow=%+v err=%v", record, err)
	}
}
