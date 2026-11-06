package service

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/repository"
	"gorm.io/gorm"
)

type cleanupTaskInputStore struct {
	*versionedTaskInputStore
	cleanupErr   error
	deleteCalls  int
	beforeDelete func(context.Context)
}

func (store *cleanupTaskInputStore) deleting(ctx context.Context) error {
	store.deleteCalls++
	if store.beforeDelete != nil {
		store.beforeDelete(ctx)
	}
	return store.cleanupErr
}

func (store *cleanupTaskInputStore) Delete(ctx context.Context, key string) error {
	if err := store.deleting(ctx); err != nil {
		return err
	}
	return store.versionedTaskInputStore.Delete(ctx, key)
}

func (store *cleanupTaskInputStore) DeletePrefixVersions(ctx context.Context, prefix string) error {
	if err := store.deleting(ctx); err != nil {
		return err
	}
	return store.versionedTaskInputStore.DeletePrefixVersions(ctx, prefix)
}

func useTaskCleanupStore(t *testing.T) *cleanupTaskInputStore {
	t.Helper()
	store := &cleanupTaskInputStore{versionedTaskInputStore: &versionedTaskInputStore{objects: map[string][]versionedTestObject{}}}
	previous := taskInputStoreFactory
	taskInputStoreFactory = func() (imageStore, error) { return store, nil }
	t.Cleanup(func() { taskInputStoreFactory = previous })
	return store
}

func imageTaskCleanupFixture(t *testing.T, store *cleanupTaskInputStore, status model.ImageGenerationTaskStatus, legacy bool) model.ImageGenerationTask {
	t.Helper()
	taskID := newID("cleanup-task")
	prefix := imageTaskInputPrefix(taskID)
	key := prefix + "inputs/reference.png"
	if legacy {
		key = "previous-prefix/tasks/" + taskID + "/inputs/reference.png"
	}
	references, err := json.Marshal([]ImageTaskInput{{ObjectKey: key, ContentType: "image/png", Purpose: "image"}})
	if err != nil {
		t.Fatal(err)
	}
	item := model.ImageGenerationTask{
		ID: taskID, OwnerUID: newID("owner"), ClientRequestID: newID("request"),
		Status: status, ProviderConfig: "saved-provider-config", ProviderTaskID: "original-upstream",
		ReferencesJSON: string(references), OperationLogID: newID("operation"), CreatedAt: now(), UpdatedAt: now(),
	}
	db, _ := repository.DB()
	if err := db.Create(&item).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&model.OperationLog{ID: item.OperationLogID, TargetID: item.ID, Status: model.OperationStatusSubmitted}).Error; err != nil {
		t.Fatal(err)
	}
	if !legacy {
		input := model.ImageGenerationTaskInput{ID: newID("cleanup-input"), TaskID: item.ID, Position: 0, SourceObjectKey: "images/source.png", SnapshotObjectKey: key, SnapshotVersionID: "snapshot", PreparationStatus: "ready", CleanupKeysJSON: "[]"}
		if err := db.Create(&input).Error; err != nil {
			t.Fatal(err)
		}
	}
	for _, objectKey := range []string{key, prefix + "inputs/orphan.png", "images/source.png", "public/source.png", "shared/source.png", imageTaskInputPrefix(taskID+"-neighbor") + "inputs/reference.png"} {
		store.objects[objectKey] = []versionedTestObject{{data: tinyPNG, versionID: "old"}, {data: tinyPNG, versionID: "current"}}
	}
	t.Cleanup(func() {
		_ = repository.DeleteImageGenerationTask(item.ID)
		db.Where("target_id = ? OR id = ?", item.ID, item.OperationLogID).Delete(&model.OperationLog{})
	})
	return item
}

func assertTaskCleanupObjects(t *testing.T, store *cleanupTaskInputStore, item model.ImageGenerationTask, cleaned bool) {
	t.Helper()
	inputs, err := imageTaskInputs(item)
	if err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{inputs[0].ObjectKey, imageTaskInputPrefix(item.ID) + "inputs/orphan.png"} {
		if (len(store.objects[key]) == 0) != cleaned {
			t.Fatalf("task object %q cleaned=%v, want %v", key, len(store.objects[key]) == 0, cleaned)
		}
	}
	for _, key := range []string{"images/source.png", "public/source.png", "shared/source.png", imageTaskInputPrefix(item.ID+"-neighbor") + "inputs/reference.png"} {
		if len(store.objects[key]) != 2 {
			t.Fatalf("cleanup removed another resource or its versions: %s", key)
		}
	}
}

func TestResolveImageTaskCleansResourcesOnlyAfterCommittedClose(t *testing.T) {
	for _, legacy := range []bool{false, true} {
		t.Run(map[bool]string{false: "prepared", true: "legacy"}[legacy], func(t *testing.T) {
			store := useTaskCleanupStore(t)
			item := imageTaskCleanupFixture(t, store, model.ImageTaskPaused, legacy)
			db, _ := repository.DB()
			store.beforeDelete = func(ctx context.Context) {
				deadline, bounded := ctx.Deadline()
				if !bounded || deadline.After(time.Now().Add(5*time.Second)) {
					t.Fatal("close cleanup has no bounded deadline")
				}
				stored, found, err := repository.GetImageGenerationTask(item.ID)
				if err != nil || !found || stored.Status != model.ImageTaskFailed || stored.ProviderConfig != "" || stored.FinishedAt == "" {
					t.Fatalf("cleanup preceded committed close: task=%+v err=%v", stored, err)
				}
				var audits int64
				if err := db.Model(&model.OperationLog{}).Where("target_id = ? AND action = ?", item.ID, "generation_task_resolution").Count(&audits).Error; err != nil || audits != 1 {
					t.Fatalf("cleanup preceded audit commit: audits=%d err=%v", audits, err)
				}
			}
			ctx := WithPortalUser(context.Background(), PortalUser{UID: newID("admin"), Roles: []string{"portal-admin"}})
			if err := ResolveGenerationTask(ctx, "image", item.ID, GenerationTaskResolutionRequest{Action: "close", Reason: "供应商确认失败"}); err != nil {
				t.Fatal(err)
			}
			assertTaskCleanupObjects(t, store, item, true)
		})
	}
}

func TestResolveImageTaskAuditFailurePreservesResourcesAndState(t *testing.T) {
	store := useTaskCleanupStore(t)
	item := imageTaskCleanupFixture(t, store, model.ImageTaskUncertain, false)
	db, _ := repository.DB()
	hook := newID("test:reject-resolution-audit")
	if err := db.Callback().Create().Before("gorm:create").Register(hook, func(tx *gorm.DB) {
		if tx.Statement.Table == "operation_logs" {
			tx.AddError(errors.New("audit unavailable"))
		}
	}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Callback().Create().Remove(hook) })
	ctx := WithPortalUser(context.Background(), PortalUser{UID: newID("admin"), Roles: []string{"portal-admin"}})
	if err := ResolveGenerationTask(ctx, "image", item.ID, GenerationTaskResolutionRequest{Action: "close", Reason: "供应商确认失败"}); err == nil {
		t.Fatal("close succeeded without its audit")
	}
	stored, found, err := repository.GetImageGenerationTask(item.ID)
	if err != nil || !found || stored.Status != item.Status || stored.ProviderConfig != item.ProviderConfig || stored.FinishedAt != "" || store.deleteCalls != 0 {
		t.Fatalf("failed close changed state/resources: task=%+v deletes=%d err=%v", stored, store.deleteCalls, err)
	}
	var operation model.OperationLog
	if err := db.First(&operation, "id = ?", item.OperationLogID).Error; err != nil || operation.Status != model.OperationStatusSubmitted {
		t.Fatalf("failed close changed original audit: %+v err=%v", operation, err)
	}
	assertTaskCleanupObjects(t, store, item, false)
}

func TestResolveImageTaskCleanupFailureRetriesForPreparedAndLegacyTasks(t *testing.T) {
	for _, legacy := range []bool{false, true} {
		t.Run(map[bool]string{false: "prepared", true: "legacy"}[legacy], func(t *testing.T) {
			store := useTaskCleanupStore(t)
			item := imageTaskCleanupFixture(t, store, model.ImageTaskUncertain, legacy)
			store.cleanupErr = errors.New("temporary storage failure")
			ctx := WithPortalUser(context.Background(), PortalUser{UID: newID("admin"), Roles: []string{"portal-admin"}})
			if err := ResolveGenerationTask(ctx, "image", item.ID, GenerationTaskResolutionRequest{Action: "close", Reason: "供应商确认失败"}); err != nil {
				t.Fatalf("cleanup failure undid committed close: %v", err)
			}
			stored, found, err := repository.GetImageGenerationTask(item.ID)
			if err != nil || !found || stored.Status != model.ImageTaskFailed || stored.ProviderConfig != "" {
				t.Fatalf("closed task=%+v err=%v", stored, err)
			}
			assertTaskCleanupObjects(t, store, item, false)
			store.cleanupErr = nil
			cleanupImageTasks(context.Background(), time.Now())
			assertTaskCleanupObjects(t, store, item, true)
			if _, found, err := repository.GetImageGenerationTask(item.ID); err != nil || !found {
				t.Fatalf("daily cleanup removed retained task: found=%v err=%v", found, err)
			}
		})
	}
}

func TestImageTaskRetentionWaitsForResourceCleanupBeforeDeletingRecords(t *testing.T) {
	store := useTaskCleanupStore(t)
	item := imageTaskCleanupFixture(t, store, model.ImageTaskFailed, true)
	db, _ := repository.DB()
	current := time.Now().UTC()
	if err := db.Model(&item).Update("finished_at", current.Add(-31*24*time.Hour).Format(time.RFC3339Nano)).Error; err != nil {
		t.Fatal(err)
	}
	store.cleanupErr = errors.New("temporary storage failure")
	cleanupImageTasks(context.Background(), current)
	if _, found, err := repository.GetImageGenerationTask(item.ID); err != nil || !found {
		t.Fatalf("failed cleanup lost retry record: found=%v err=%v", found, err)
	}
	assertTaskCleanupObjects(t, store, item, false)
	store.cleanupErr = nil
	cleanupImageTasks(context.Background(), current)
	if _, found, err := repository.GetImageGenerationTask(item.ID); err != nil || found {
		t.Fatalf("expired task not removed after successful cleanup: found=%v err=%v", found, err)
	}
	assertTaskCleanupObjects(t, store, item, true)
}
