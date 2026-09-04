package repository

import (
	"bytes"
	"log"
	"strings"
	"testing"

	"github.com/basketikun/infinite-canvas/config"
	"github.com/basketikun/infinite-canvas/model"
	"github.com/shopspring/decimal"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

func useImageTaskTestDB(t *testing.T) {
	t.Helper()
	useRepositoryTestDB(t, config.Config{StorageDriver: "sqlite", DatabaseDSN: ":memory:"})
}

func TestListSucceededImageGenerationTasksFinishedBetweenReturnsOnlyCompletedTasks(t *testing.T) {
	useImageTaskTestDB(t)
	items := []model.ImageGenerationTask{
		{ID: "before", OwnerUID: "user", ClientRequestID: "before", Status: model.ImageTaskSucceeded, FinishedAt: "2026-09-02T15:59:59Z"},
		{ID: "included", OwnerUID: "user", ClientRequestID: "included", Status: model.ImageTaskSucceeded, FinishedAt: "2026-09-02T16:00:00Z", Amount: decimal.RequireFromString("0.1234"), AmountRecorded: true},
		{ID: "failed", OwnerUID: "user", ClientRequestID: "failed", Status: model.ImageTaskFailed, FinishedAt: "2026-09-02T20:00:00Z"},
		{ID: "after", OwnerUID: "user", ClientRequestID: "after", Status: model.ImageTaskSucceeded, FinishedAt: "2026-09-03T16:00:00Z"},
	}
	for _, item := range items {
		if _, _, err := CreateImageGenerationTask(item); err != nil {
			t.Fatal(err)
		}
	}

	result, err := ListSucceededImageGenerationTasksFinishedBetween("2026-09-02T16:00:00Z", "2026-09-03T16:00:00Z")
	if err != nil || len(result) != 1 || result[0].ID != "included" || !result[0].Amount.Equal(decimal.RequireFromString("0.1234")) || !result[0].AmountRecorded {
		t.Fatalf("ListSucceededImageGenerationTasksFinishedBetween() = %#v, %v", result, err)
	}
}

func TestSucceededImageGenerationTaskCostSummariesUseRecordedAmountsOnly(t *testing.T) {
	useImageTaskTestDB(t)
	for _, item := range []model.ImageGenerationTask{
		{ID: "priced-a", OwnerUID: "user", ClientRequestID: "priced-a", Status: model.ImageTaskSucceeded, ProviderID: "provider", ProviderName: "模型", Amount: decimal.RequireFromString("0.1234"), AmountRecorded: true, FinishedAt: "2026-09-02T16:00:00Z"},
		{ID: "priced-b", OwnerUID: "user", ClientRequestID: "priced-b", Status: model.ImageTaskSucceeded, ProviderID: "provider", ProviderName: "模型", Amount: decimal.RequireFromString("0.2000"), AmountRecorded: true, FinishedAt: "2026-09-02T16:01:00Z"},
		{ID: "legacy", OwnerUID: "user", ClientRequestID: "legacy", Status: model.ImageTaskSucceeded, ProviderID: "provider", ProviderName: "模型", Amount: decimal.RequireFromString("9.9999"), AmountRecorded: false, FinishedAt: "2026-09-02T16:02:00Z"},
	} {
		if _, _, err := CreateImageGenerationTask(item); err != nil {
			t.Fatal(err)
		}
	}

	rows, err := ListSucceededImageGenerationTaskCostSummariesFinishedBetween("2026-09-02T16:00:00Z", "2026-09-03T16:00:00Z")
	if err != nil || len(rows) != 1 || rows[0].ProviderID != "provider" || rows[0].SuccessfulCalls != 3 || !rows[0].Amount.Equal(decimal.RequireFromString("0.3234")) {
		t.Fatalf("ListSucceededImageGenerationTaskCostSummariesFinishedBetween() = %#v, %v", rows, err)
	}
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

func TestClaimNextImageGenerationTaskDoesNotLogAnEmptyQueueAsAnError(t *testing.T) {
	useImageTaskTestDB(t)
	var logs bytes.Buffer
	database, err := DB()
	if err != nil {
		t.Fatal(err)
	}
	db = database.Session(&gorm.Session{Logger: logger.New(log.New(&logs, "", 0), logger.Config{LogLevel: logger.Warn})})

	_, found, err := ClaimNextImageGenerationTask("2026-09-02T12:00:00Z", "2026-09-02T12:00:01Z")
	if err != nil || found {
		t.Fatalf("empty claim = found %v, err %v", found, err)
	}
	if strings.Contains(logs.String(), "record not found") {
		t.Fatalf("idle claim logged an error: %s", logs.String())
	}
}

func TestClaimNextImageGenerationTaskOrdersEqualCreatedAtByID(t *testing.T) {
	useImageTaskTestDB(t)
	createdAt := "2026-09-02T12:00:00Z"
	for _, item := range []model.ImageGenerationTask{
		{ID: "task-z", OwnerUID: "user-1", ClientRequestID: "client-z", Status: model.ImageTaskQueued, CreatedAt: createdAt, UpdatedAt: createdAt},
		{ID: "task-a", OwnerUID: "user-1", ClientRequestID: "client-a", Status: model.ImageTaskQueued, CreatedAt: createdAt, UpdatedAt: createdAt},
	} {
		if _, _, err := CreateImageGenerationTask(item); err != nil {
			t.Fatalf("CreateImageGenerationTask(%q) error = %v", item.ID, err)
		}
	}

	claimed, found, err := ClaimNextImageGenerationTask("", "2026-09-02T12:00:01Z")
	if err != nil || !found || claimed.ID != "task-a" {
		t.Fatalf("ClaimNextImageGenerationTask() = %#v, %v, %v", claimed, found, err)
	}
}

func TestClaimNextImageGenerationTaskDoesNotOverwriteALeaseRenewedAfterSelection(t *testing.T) {
	useImageTaskTestDB(t)
	item := model.ImageGenerationTask{
		ID:              "task-stale",
		OwnerUID:        "user-1",
		ClientRequestID: "client-stale",
		Status:          model.ImageTaskSubmitting,
		CreatedAt:       "2026-09-02T11:00:00Z",
		UpdatedAt:       "2026-09-02T11:00:00Z",
	}
	if _, _, err := CreateImageGenerationTask(item); err != nil {
		t.Fatalf("CreateImageGenerationTask() error = %v", err)
	}

	database, err := DB()
	if err != nil {
		t.Fatal(err)
	}
	const callbackName = "test:renew_image_task_lease_after_claim_selection"
	const renewedAt = "2026-09-02T12:00:05Z"
	var callbackErr error
	callbackFired := false
	if err := database.Callback().Query().After("gorm:query").Register(callbackName, func(transaction *gorm.DB) {
		if callbackFired || transaction.Statement.Table != "image_generation_tasks" {
			return
		}
		candidate, ok := transaction.Statement.Dest.(*model.ImageGenerationTask)
		if !ok || candidate.ID != item.ID {
			return
		}
		callbackFired = true
		callbackErr = transaction.Session(&gorm.Session{NewDB: true}).Exec(
			"UPDATE image_generation_tasks SET updated_at = ? WHERE id = ?",
			renewedAt,
			item.ID,
		).Error
	}); err != nil {
		t.Fatalf("register query callback: %v", err)
	}

	claimed, found, err := ClaimNextImageGenerationTask("2026-09-02T11:30:00Z", "2026-09-02T12:00:10Z")
	if err != nil {
		t.Fatalf("ClaimNextImageGenerationTask() error = %v", err)
	}
	if callbackErr != nil {
		t.Fatalf("simulated lease renewal error = %v", callbackErr)
	}
	if !callbackFired {
		t.Fatal("simulated lease renewal did not run")
	}
	if found {
		t.Fatalf("ClaimNextImageGenerationTask() overwrote a renewed lease: %#v", claimed)
	}

	stored, found, err := GetImageGenerationTask(item.ID)
	if err != nil || !found {
		t.Fatalf("GetImageGenerationTask() = %#v, %v, %v", stored, found, err)
	}
	if stored.UpdatedAt != renewedAt {
		t.Fatalf("renewed lease updated_at = %q, want %q", stored.UpdatedAt, renewedAt)
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
