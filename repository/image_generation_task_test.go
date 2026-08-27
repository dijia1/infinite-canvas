package repository

import (
	"sync"
	"testing"

	"github.com/basketikun/infinite-canvas/config"
	"github.com/basketikun/infinite-canvas/model"
)

func useImageTaskTestDB(t *testing.T) {
	t.Helper()
	previousConfig, previousDB, previousErr, previousOnce := config.Cfg, db, dbErr, dbOnce
	config.Cfg = config.Config{StorageDriver: "sqlite", DatabaseDSN: ":memory:"}
	db = nil
	dbErr = nil
	dbOnce = sync.Once{}
	t.Cleanup(func() {
		config.Cfg = previousConfig
		db = previousDB
		dbErr = previousErr
		dbOnce = previousOnce
	})
}

func TestCreateImageGenerationTaskIsIdempotentPerOwnerAndClientRequest(t *testing.T) {
	useImageTaskTestDB(t)
	item := model.ImageGenerationTask{ID: "task-1", OwnerUID: "user-1", ClientRequestID: "client-1", Status: model.ImageTaskQueued, CreatedAt: "2026-08-24T10:00:00Z", UpdatedAt: "2026-08-24T10:00:00Z"}

	created, inserted, err := CreateImageGenerationTask(item)
	if err != nil || !inserted || created.ID != "task-1" {
		t.Fatalf("first CreateImageGenerationTask() = %#v, %v, %v", created, inserted, err)
	}
	repeated, inserted, err := CreateImageGenerationTask(model.ImageGenerationTask{ID: "task-2", OwnerUID: "user-1", ClientRequestID: "client-1", Status: model.ImageTaskQueued})
	if err != nil || inserted || repeated.ID != "task-1" {
		t.Fatalf("repeated CreateImageGenerationTask() = %#v, %v, %v", repeated, inserted, err)
	}
	if _, inserted, err := CreateImageGenerationTask(model.ImageGenerationTask{ID: "task-3", OwnerUID: "user-2", ClientRequestID: "client-1", Status: model.ImageTaskQueued}); err != nil || !inserted {
		t.Fatalf("different owner task creation = inserted %v, err %v", inserted, err)
	}
}

func TestImageGenerationTaskLookupAndClaimAreOwnerScoped(t *testing.T) {
	useImageTaskTestDB(t)
	item := model.ImageGenerationTask{ID: "task-1", OwnerUID: "user-1", ClientRequestID: "client-1", Status: model.ImageTaskQueued, CreatedAt: "2026-08-24T10:00:00Z", UpdatedAt: "2026-08-24T10:00:00Z"}
	if _, _, err := CreateImageGenerationTask(item); err != nil {
		t.Fatalf("CreateImageGenerationTask() error = %v", err)
	}
	if _, found, err := GetImageGenerationTaskForOwner("task-1", "user-2"); err != nil || found {
		t.Fatalf("cross-owner lookup = found %v, err %v", found, err)
	}
	claimed, found, err := ClaimNextImageGenerationTask("2026-08-24T09:59:00Z", "2026-08-24T10:01:00Z")
	if err != nil || !found || claimed.ID != "task-1" || claimed.Status != model.ImageTaskSubmitting {
		t.Fatalf("ClaimNextImageGenerationTask() = %#v, %v, %v", claimed, found, err)
	}
	if _, found, err := ClaimNextImageGenerationTask("2026-08-24T09:59:00Z", "2026-08-24T10:02:00Z"); err != nil || found {
		t.Fatalf("second claim = found %v, err %v", found, err)
	}
}

func TestRenewImageGenerationTaskLeasePreventsASecondWorkerFromReclaimingAnActiveTask(t *testing.T) {
	useImageTaskTestDB(t)
	item := model.ImageGenerationTask{
		ID:              "task-active",
		OwnerUID:        "user-1",
		ClientRequestID: "client-active",
		Status:          model.ImageTaskSubmitting,
		CreatedAt:       "2026-08-27T10:00:00Z",
		UpdatedAt:       "2026-08-27T10:00:00Z",
	}
	if _, _, err := CreateImageGenerationTask(item); err != nil {
		t.Fatalf("CreateImageGenerationTask() error = %v", err)
	}

	renewed, err := RenewImageGenerationTaskLease(item.ID, "2026-08-27T10:00:40Z")
	if err != nil || !renewed {
		t.Fatalf("RenewImageGenerationTaskLease() = %v, %v", renewed, err)
	}

	if _, claimed, err := ClaimNextImageGenerationTask("2026-08-27T10:00:20Z", "2026-08-27T10:01:00Z"); err != nil || claimed {
		t.Fatalf("ClaimNextImageGenerationTask() reclaimed an active task: claimed=%v, err=%v", claimed, err)
	}
}
