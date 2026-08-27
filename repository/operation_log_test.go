package repository

import (
	"testing"
	"time"

	"github.com/basketikun/infinite-canvas/model"
)

func TestUpdateOperationLogCompletesSubmittedImageTask(t *testing.T) {
	useImageTaskTestDB(t)
	createdAt := time.Now().UTC().Add(-time.Minute)
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
	if items[0].Status != model.OperationStatusSuccess || len(items[0].MediaIDs) != 1 || items[0].MediaIDs[0] != "media-1" || items[0].ProviderTaskID != "maizi-task-123" || !items[0].CreatedAt.Equal(createdAt) {
		t.Fatalf("updated operation log = %#v", items[0])
	}
}

func TestSetImageGenerationTaskProviderTaskIDUpdatesLinkedOperationLog(t *testing.T) {
	useImageTaskTestDB(t)
	createdAt := time.Now().UTC()
	task := model.ImageGenerationTask{
		ID:              "task-provider-id",
		OwnerUID:        "user-1",
		ClientRequestID: "request-provider-id",
		Status:          model.ImageTaskSubmitting,
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

	if err := SetImageGenerationTaskProviderTaskID(task.ID, task.OperationLogID, "maizi-task-456", "2026-08-27T09:20:00Z"); err != nil {
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
