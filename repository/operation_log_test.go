package repository

import (
	"testing"
	"time"

	"github.com/basketikun/infinite-canvas/model"
)

func TestUpdateOperationLogCompletesSubmittedImageTask(t *testing.T) {
	useImageTaskTestDB(t)
	createdAt := time.Date(2026, time.September, 7, 9, 53, 58, 925680123, time.UTC)
	item := model.OperationLog{
		ID:         "operation-image-task",
		ActorUID:   "user-1",
		Action:     "image_generate",
		Status:     model.OperationStatusSubmitted,
		TargetType: "image_generation",
		TargetID:   "task-1",
		CreatedAt:  createdAt,
	}
	created, inserted, err := CreateImageGenerationTaskWithOperationLog(
		model.ImageGenerationTask{ID: "task-1", OwnerUID: "user-1", ClientRequestID: "request-1", Status: model.ImageTaskQueued, OperationLogID: item.ID, CreatedAt: createdAt.Format(time.RFC3339), UpdatedAt: createdAt.Format(time.RFC3339)},
		item,
	)
	if err != nil || !inserted || created.OperationLogID != item.ID {
		t.Fatalf("CreateImageGenerationTaskWithOperationLog() = %#v, %t, %v", created, inserted, err)
	}
	items, _, err := ListOperationLogs(model.OperationLogQuery{Action: "image_generate"})
	if err != nil || len(items) != 1 || items[0].Status != model.OperationStatusSubmitted {
		t.Fatalf("submitted operation log = %#v, %v", items, err)
	}
	// PostgreSQL stores microseconds; compare persisted values across the update.
	persistedCreatedAt := items[0].CreatedAt
	if !persistedCreatedAt.Equal(createdAt.Truncate(time.Microsecond)) {
		t.Fatalf("persisted created_at = %s, input = %s", persistedCreatedAt.Format(time.RFC3339Nano), createdAt.Format(time.RFC3339Nano))
	}

	if err := UpdateOperationLog(item.ID, map[string]any{
		"status":           model.OperationStatusSuccess,
		"media_ids":        []string{"media-1"},
		"provider_task_id": "maizi-task-123",
		"error_message":    "",
	}); err != nil {
		t.Fatal(err)
	}

	items, _, err = ListOperationLogs(model.OperationLogQuery{Action: "image_generate"})
	if err != nil || len(items) != 1 {
		t.Fatalf("ListOperationLogs() = %#v, %v", items, err)
	}
	if items[0].Status != model.OperationStatusSuccess || len(items[0].MediaIDs) != 1 || items[0].MediaIDs[0] != "media-1" || items[0].ProviderTaskID != "maizi-task-123" {
		t.Fatalf("updated operation log = %#v", items[0])
	}
	if !items[0].CreatedAt.Equal(persistedCreatedAt) {
		t.Fatalf("update changed created_at: before = %s, after = %s", persistedCreatedAt.Format(time.RFC3339Nano), items[0].CreatedAt.Format(time.RFC3339Nano))
	}
}

func TestSetImageGenerationTaskProviderTaskIDUpdatesLinkedOperationLog(t *testing.T) {
	useImageTaskTestDB(t)
	createdAt := time.Now().UTC()
	task := model.ImageGenerationTask{
		ID:              "task-provider-id",
		OwnerUID:        "user-1",
		ClientRequestID: "request-provider-id",
		Status:          model.ImageTaskQueued,
		OperationLogID:  "operation-provider-id",
		CreatedAt:       createdAt.Format(time.RFC3339),
		UpdatedAt:       createdAt.Format(time.RFC3339),
	}
	operation := model.OperationLog{
		ID:         task.OperationLogID,
		ActorUID:   task.OwnerUID,
		Action:     "image_generate",
		Status:     model.OperationStatusSubmitted,
		TargetType: "image_generation",
		TargetID:   task.ID,
		CreatedAt:  createdAt,
	}
	if _, inserted, err := CreateImageGenerationTaskWithOperationLog(task, operation); err != nil || !inserted {
		t.Fatalf("CreateImageGenerationTaskWithOperationLog() = inserted %t, err %v", inserted, err)
	}

	claimed, found, err := ClaimNextImageGenerationTask(createdAt, 45*time.Second)
	if err != nil || !found {
		t.Fatalf("ClaimNextImageGenerationTask() = %#v, %t, %v", claimed, found, err)
	}
	if err := UpdateClaimedImageGenerationTask(claimed, map[string]any{"status": model.ImageTaskSubmitting}); err != nil {
		t.Fatalf("enter submitting state: %v", err)
	}
	if err := SetImageGenerationTaskProviderTaskID(claimed, "maizi-task-456", "2026-08-27T09:20:00Z"); err != nil {
		t.Fatalf("SetImageGenerationTaskProviderTaskID() error = %v", err)
	}
	updatedTask, found, err := GetImageGenerationTask(task.ID)
	if err != nil || !found || updatedTask.ProviderTaskID != "maizi-task-456" || updatedTask.Status != model.ImageTaskRunning {
		t.Fatalf("updated task = %#v, found %t, err %v", updatedTask, found, err)
	}
	items, _, err := ListOperationLogs(model.OperationLogQuery{Action: "image_generate"})
	if err != nil || len(items) != 1 || items[0].ProviderTaskID != "maizi-task-456" {
		t.Fatalf("updated operation log = %#v, err %v", items, err)
	}
}

func TestOperationStatusFilterMatchesLinkedImageTaskStateAndKeepsCoarseStatus(t *testing.T) {
	database := useImageTaskTestDB(t)
	createdAt := time.Now().UTC()
	task := model.ImageGenerationTask{
		ID: "uncertain-image-task", OwnerUID: "image-audit-owner", ClientRequestID: "uncertain-image-request",
		Status: model.ImageTaskUncertain, OperationLogID: "uncertain-image-operation",
		CreatedAt: createdAt.Format(time.RFC3339), UpdatedAt: createdAt.Format(time.RFC3339),
	}
	operation := model.OperationLog{
		ID: task.OperationLogID, ActorUID: task.OwnerUID, Action: "image_generate",
		Status: model.OperationStatusSubmitted, TargetType: "image_generation", TargetID: task.ID, CreatedAt: createdAt,
	}
	if err := database.Create(&task).Error; err != nil {
		t.Fatal(err)
	}
	if err := database.Create(&operation).Error; err != nil {
		t.Fatal(err)
	}

	items, total, err := ListOperationLogs(model.OperationLogQuery{Status: string(model.ImageTaskUncertain)})
	if err != nil || total != 1 || len(items) != 1 || items[0].ID != operation.ID {
		t.Fatalf("uncertain image filter = %#v, total=%d, err=%v", items, total, err)
	}
	items, total, err = ListOperationLogs(model.OperationLogQuery{Status: string(model.OperationStatusSubmitted)})
	if err != nil || total != 1 || len(items) != 1 || items[0].Status != model.OperationStatusSubmitted {
		t.Fatalf("coarse submitted filter = %#v, total=%d, err=%v", items, total, err)
	}
}
