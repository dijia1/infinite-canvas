package repository

import (
	"errors"
	"testing"
	"time"

	"github.com/basketikun/infinite-canvas/model"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

func TestWorkflowMediaReferencesProtectAndRelease(t *testing.T) {
	useRepositoryTestDB(t, newRepositoryTestConfig(t, "workflow_media"))
	db, err := DB()
	if err != nil {
		t.Fatal(err)
	}
	expired := time.Now().UTC().Add(-time.Hour)
	item, err := SaveMedia(model.Media{ID: "workflow-media", OwnerUID: "owner", ObjectKey: "workflow/media", ContentType: "image/png", ExpiresAt: &expired})
	if err != nil {
		t.Fatal(err)
	}
	replace := func(scope, id string, ids []string) error {
		return db.Transaction(func(tx *gorm.DB) error { return ReplaceWorkflowMediaRefs(tx, "owner", scope, id, ids) })
	}
	if err := replace("definition", "flow", []string{item.ID, item.ID}); err != nil {
		t.Fatal(err)
	}
	if err := replace("run", "run", []string{item.ID}); err != nil {
		t.Fatal(err)
	}
	var count int64
	db.Model(&model.WorkflowMediaRef{}).Count(&count)
	if count != 2 {
		t.Fatalf("reference count=%d", count)
	}
	if _, err := PreparePrivateMediaDeletion(item.ID, "owner", time.Now()); err == nil {
		t.Fatal("manual deletion bypassed workflow hold")
	}
	// Even a stale expiry cannot make a referenced media eligible for cleanup.
	db.Model(&model.Media{}).Where("id = ?", item.ID).Update("expires_at", expired)
	if _, claimed, err := ClaimCanvasMediaCleanup(item.ID, time.Now(), time.Minute); err != nil || claimed {
		t.Fatalf("cleanup claimed=%v err=%v", claimed, err)
	}
	if err := replace("definition", "flow", nil); err != nil {
		t.Fatal(err)
	}
	current, _, _ := GetMedia(item.ID)
	if current.ExpiresAt != nil {
		t.Fatal("run reference lost on definition deletion")
	}
	if err := replace("run", "run", nil); err != nil {
		t.Fatal(err)
	}
	current, _, _ = GetMedia(item.ID)
	if current.ExpiresAt == nil || !current.ExpiresAt.After(time.Now()) {
		t.Fatal("last release did not schedule retention")
	}
}

func TestDeletingAWorkflowPreservesItsRunUntilTheRunReleasesMedia(t *testing.T) {
	useRepositoryTestDB(t, newRepositoryTestConfig(t, "workflow_delete_lifecycle"))
	current := time.Now().UTC().Truncate(time.Microsecond)
	media, err := SaveMedia(model.Media{ID: "workflow-delete-media", OwnerUID: "workflow-delete-owner", ObjectKey: "workflow/delete-media", ContentType: "image/png"})
	if err != nil {
		t.Fatal(err)
	}
	graph := model.WorkflowGraph{Version: 1, Nodes: []model.WorkflowNode{{ID: "input", Type: model.WorkflowNodeImageInput, MediaID: media.ID}}, Connections: []model.WorkflowConnection{}}
	definition := model.Workflow{ID: "workflow-delete-definition", OwnerUID: media.OwnerUID, Name: "删除保留运行", Graph: graph, Revision: 1, CreatedAt: current.Format(time.RFC3339Nano), UpdatedAt: current.Format(time.RFC3339Nano)}
	if _, err := CreateWorkflow(definition); err != nil {
		t.Fatal(err)
	}
	run := model.WorkflowRun{ID: "workflow-delete-run", OwnerUID: media.OwnerUID, RequestID: "workflow-delete-request", WorkflowID: definition.ID, Revision: definition.Revision, Snapshot: `{"version":1}`, Status: "completed", StateVersion: 1, CreatedAt: current, UpdatedAt: current, FinishedAt: &current}
	if _, inserted, err := CreateWorkflowRun(run, nil, nil, []string{media.ID}); err != nil || !inserted {
		t.Fatalf("create run = inserted %t, err %v", inserted, err)
	}
	if deleted, err := DeleteWorkflow(media.OwnerUID, definition.ID, definition.Revision); err != nil || !deleted {
		t.Fatalf("delete definition = %t, %v", deleted, err)
	}
	if _, found, err := GetWorkflow(media.OwnerUID, definition.ID); err != nil || found {
		t.Fatalf("deleted definition found=%t err=%v", found, err)
	}
	if _, found, err := GetWorkflowRun(media.OwnerUID, run.ID); err != nil || !found {
		t.Fatalf("historical run found=%t err=%v", found, err)
	}
	retained, _, err := GetMedia(media.ID)
	if err != nil || retained.ExpiresAt != nil {
		t.Fatalf("run did not retain media: expires=%v err=%v", retained.ExpiresAt, err)
	}
	if err := DeleteWorkflowRun(media.OwnerUID, run.ID); err != nil {
		t.Fatal(err)
	}
	if _, found, err := GetWorkflowRun(media.OwnerUID, run.ID); err != nil || found {
		t.Fatalf("deleted run found=%t err=%v", found, err)
	}
	released, _, err := GetMedia(media.ID)
	if err != nil || released.ExpiresAt == nil || !released.ExpiresAt.After(current) {
		t.Fatalf("terminal run release = expires %v err=%v", released.ExpiresAt, err)
	}
}

func TestWorkflowMediaReferencesValidateAtomically(t *testing.T) {
	useRepositoryTestDB(t, newRepositoryTestConfig(t, "workflow_media_validation"))
	db, err := DB()
	if err != nil {
		t.Fatal(err)
	}
	_, err = SaveMedia(model.Media{ID: "owned", OwnerUID: "owner", ObjectKey: "workflow/owned", ContentType: "image/png"})
	if err != nil {
		t.Fatal(err)
	}
	_, err = SaveMedia(model.Media{ID: "foreign", OwnerUID: "other", ObjectKey: "workflow/foreign", ContentType: "image/png"})
	if err != nil {
		t.Fatal(err)
	}
	replace := func(ids []string) error {
		return db.Transaction(func(tx *gorm.DB) error { return ReplaceWorkflowMediaRefs(tx, "owner", "definition", "flow", ids) })
	}
	if err := replace([]string{"owned"}); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"foreign", "missing"} {
		if err := replace([]string{id}); err == nil {
			t.Fatalf("accepted unavailable %s", id)
		}
	}
	var refs []model.WorkflowMediaRef
	db.Find(&refs)
	if len(refs) != 1 || refs[0].MediaID != "owned" {
		t.Fatalf("failed update mutated references: %+v", refs)
	}
	if _, err := PreparePrivateMediaDeletion("foreign", "other", time.Now()); err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&model.PublicImage{ID: "public", MediaID: "foreign"}).Error; err != nil {
		t.Fatal(err)
	}
	if err := replace([]string{"foreign"}); err == nil {
		t.Fatal("public deleting media accepted")
	}
}

func TestWorkflowSaveSerializesWithCleanup(t *testing.T) {
	useRepositoryTestDB(t, newRepositoryTestConfig(t, "workflow_media_race"))
	db, err := DB()
	if err != nil {
		t.Fatal(err)
	}
	expired := time.Now().UTC().Add(-time.Hour)
	_, err = SaveMedia(model.Media{ID: "racing", OwnerUID: "owner", ObjectKey: "workflow/racing", ExpiresAt: &expired})
	if err != nil {
		t.Fatal(err)
	}
	tx := db.Begin()
	if tx.Error != nil {
		t.Fatal(tx.Error)
	}
	defer tx.Rollback()
	var media model.Media
	if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).First(&media, "id = ?", "racing").Error; err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() {
		_, claimed, err := ClaimCanvasMediaCleanup("racing", time.Now(), time.Minute)
		if claimed {
			err = errors.New("cleanup claimed media after a saved reference")
		}
		done <- err
	}()
	if err := ReplaceWorkflowMediaRefs(tx, "owner", "definition", "flow", []string{"racing"}); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit().Error; err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("cleanup deadlocked against workflow save")
	}
}

func TestPublicWorkflowInputCannotBeRemovedWhileReferenced(t *testing.T) {
	useRepositoryTestDB(t, newRepositoryTestConfig(t, "workflow_public_media"))
	db, err := DB()
	if err != nil {
		t.Fatal(err)
	}
	_, err = SaveMedia(model.Media{ID: "shared", OwnerUID: "publisher", ObjectKey: "workflow/shared", ContentType: "image/png"})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&model.PublicImage{ID: "public-shared", MediaID: "shared"}).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Transaction(func(tx *gorm.DB) error {
		return ReplaceWorkflowMediaRefs(tx, "consumer", "definition", "flow", []string{"shared"})
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := PreparePublicImageDeletion("public-shared", time.Now()); err == nil {
		t.Fatal("public deletion bypassed another user's workflow reference")
	}
	if err := DeletePublicImageAndMedia("public-shared", "shared"); err == nil {
		t.Fatal("direct public deletion bypassed workflow reference")
	}
	if _, found, err := GetPublicImage("public-shared"); err != nil || !found {
		t.Fatalf("rejected deletion mutated public entry: %v %v", found, err)
	}
}
