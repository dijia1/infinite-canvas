package service

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/basketikun/infinite-canvas/config"
	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/repository"
)

func TestConfirmedWorkflowRetryUsesCorrectedModelAndContinuesDependents(t *testing.T) {
	clearWorkflowRuntimeTables(t)
	previousConfig := config.Cfg
	config.Cfg.WorkflowEnabled = true
	t.Cleanup(func() { config.Cfg = previousConfig })
	original, err := AdminSettings()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if _, err := saveGenerationSettingsForTest(t, original); err != nil {
			t.Error(err)
		}
	})
	settings := original
	settings.AI = model.AISettings{ImageProviderID: "frozen-image-provider", Providers: []model.AIProvider{{ID: "frozen-image-provider", Name: "Corrected model", Type: "maizi-image", Enabled: true, AspectRatios: []string{"1:1"}, ImagePrices: []model.ImageResolutionPrice{{Resolution: "1K"}}, Config: json.RawMessage(`{"apiKey":"isolated-test-key","model":"gpt-image-2.6"}`)}}}
	if _, err := saveGenerationSettingsForTest(t, settings); err != nil {
		t.Fatal(err)
	}
	cleanupStore := useTaskCleanupStore(t)
	owner := "self-retry-owner"
	seedWorkflowMember(t, owner, true)
	run := seedWorkflowMixedRun(t, "self-retry-run", owner)
	db, _ := repository.DB()
	current := time.Now().UTC()
	task := model.ImageGenerationTask{ID: "old-uncertain-image", OwnerUID: owner, ClientRequestID: "old-image-request", Status: model.ImageTaskUncertain, ProviderID: "frozen-image-provider", ProviderConfig: `{"model":"gpt-image-6"}`, CreatedAt: now(), UpdatedAt: now()}
	attempt := model.WorkflowOutputAttempt{ID: "old-attempt", RunID: run.ID, NodeID: "image", SlotID: "image-output", Attempt: 1, OwnerUID: owner, RequestID: task.ClientRequestID, TaskType: "image", TaskID: task.ID, Status: "uncertain", CreatedAt: current, UpdatedAt: current}
	if err := db.Create(&task).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&attempt).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Model(&model.WorkflowOutputExecution{}).Where("run_id = ? AND node_id = 'image'", run.ID).Update("status", "uncertain").Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Model(&model.WorkflowRun{}).Where("id = ?", run.ID).Update("status", "attention_required").Error; err != nil {
		t.Fatal(err)
	}
	input := RetryWorkflowOutputInput{RequestID: "confirmed-retry", NodeID: attempt.NodeID, SlotID: attempt.SlotID, ConfirmUncertain: true}
	user := PortalUser{UID: owner}
	for click := 0; click < 2; click++ {
		if _, err := RetryWorkflowOutput(context.Background(), user, run.ID, input); err != nil {
			t.Fatal(err)
		}
	}
	if cleanupStore.deleteCalls != 1 {
		t.Fatalf("closed task cleanup calls=%d", cleanupStore.deleteCalls)
	}
	if _, err := RunWorkflowSchedulerOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	record, _, err := repository.GetWorkflowRun(owner, run.ID)
	if err != nil {
		t.Fatal(err)
	}
	var replacement model.WorkflowOutputAttempt
	for _, item := range record.Attempts {
		if item.NodeID == "image" && item.Attempt == 2 {
			replacement = item
		}
	}
	if replacement.TaskID == "" || replacement.TaskID == task.ID || replacement.RequestID == task.ClientRequestID {
		t.Fatalf("replacement not created: %+v", record)
	}
	created, found, err := repository.GetImageGenerationTask(replacement.TaskID)
	if err != nil || !found {
		t.Fatalf("new task: %+v %v %v", created, found, err)
	}
	var providerConfig struct {
		Model string `json:"model"`
	}
	if err := json.Unmarshal([]byte(created.ProviderConfig), &providerConfig); err != nil || providerConfig.Model != "gpt-image-2.6" {
		t.Fatalf("stale model reused: %q %v", providerConfig.Model, err)
	}
	previousGet, previousVideo := workflowGetImageTask, workflowCreateVideoTask
	t.Cleanup(func() { workflowGetImageTask, workflowCreateVideoTask = previousGet, previousVideo })
	workflowGetImageTask = func(_ context.Context, requestID string) (ImageTaskView, error) {
		return ImageTaskView{ID: created.ID, ClientRequestID: requestID, Status: "succeeded", Images: []MediaAccess{{MediaID: "new-image"}}}, nil
	}
	videoCalls := 0
	workflowCreateVideoTask = func(_ context.Context, request CreateVideoTaskRequest) (VideoTaskView, error) {
		videoCalls++
		if len(request.ImageMediaIDs) != 1 || request.ImageMediaIDs[0] != "new-image" {
			t.Fatalf("stale downstream input: %+v", request)
		}
		return VideoTaskView{ID: "new-video", ClientRequestID: request.ClientRequestID, Status: "succeeded", ResultMediaIDs: []string{"new-video-media"}}, nil
	}
	if err := db.Model(&replacement).Update("next_poll_at", current.Add(-time.Second)).Error; err != nil {
		t.Fatal(err)
	}
	if _, err := RunWorkflowSchedulerOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	record, _, _ = repository.GetWorkflowRun(owner, run.ID)
	if record.Run.Status != "completed" || videoCalls != 1 {
		t.Fatalf("dependents did not continue: %+v calls=%d", record, videoCalls)
	}
}
