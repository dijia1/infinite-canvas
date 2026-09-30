package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/google/uuid"
	"testing"
	"time"

	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/repository"
	"gorm.io/gorm"
)

func publicCanvasFixture(t *testing.T, public model.PublicImage) (PortalUser, model.CanvasProject) {
	t.Helper()
	user := PortalUser{UID: newID("canvas-reader")}
	doc := map[string]any{"nodes": []any{
		map[string]any{"id": "n1", "type": "image", "title": "图一", "position": map[string]any{"x": 10, "y": 20}, "width": 300, "height": 200, "metadata": map[string]any{"mediaId": public.MediaID, "publicImageId": public.ID, "assetId": "public-asset", "maskResourceId": "mask-1", "imageGenerationTaskId": "old-task"}},
		map[string]any{"id": "n2", "type": "image", "position": map[string]any{"x": 400, "y": 20}, "width": 300, "height": 200, "metadata": map[string]any{"mediaId": public.MediaID, "publicImageId": public.ID}},
	}, "connections": []any{}, "maskResources": map[string]any{"mask-1": map[string]any{"strokes": []any{}}}, "viewport": map[string]any{"x": 0, "y": 0, "k": 1}, "backgroundMode": "lines", "showImageInfo": false}
	raw, _ := json.Marshal(doc)
	item := model.CanvasProject{ID: newID("canvas-public"), OwnerUID: user.UID, Title: "画板", Document: raw, Revision: 1, CreatedAt: now(), UpdatedAt: now()}
	_, _, err := repository.CreateCanvasProject(item)
	if err != nil {
		t.Fatal(err)
	}
	return user, item
}
func TestCanvasPublicImportConvertsOneCopyAndPreservesGraph(t *testing.T) {
	public, store := publicCopyFixture(t)
	user, project := publicCanvasFixture(t, public)
	if _, err := repository.PreparePublicImageDeletion(public.ID, time.Now()); !errors.Is(err, repository.ErrPublicImageCanvasReferenced) {
		t.Fatalf("legacy source was deletable: %v", err)
	}
	result, err := importCanvasPublicImages(context.Background(), store, user, project.ID, 1)
	if err != nil {
		t.Fatal(err)
	}
	if result.Project.Revision != 2 || len(result.MissingNodeIDs) != 0 || store.copyCalls != 1 {
		t.Fatalf("result=%+v copies=%d", result, store.copyCalls)
	}
	var document struct {
		Nodes []struct {
			ID       string
			Position map[string]any
			Metadata map[string]any
		}
		MaskResources map[string]any
	}
	if err := json.Unmarshal(result.Project.Document, &document); err != nil {
		t.Fatal(err)
	}
	if document.Nodes[0].ID != "n1" || document.Nodes[0].Position["x"] != float64(10) || document.Nodes[0].Metadata["maskResourceId"] != "mask-1" || document.Nodes[0].Metadata["imageGenerationTaskId"] != "old-task" || document.MaskResources["mask-1"] == nil {
		t.Fatalf("graph changed: %+v", document)
	}
	if document.Nodes[0].Metadata["mediaId"] != document.Nodes[1].Metadata["mediaId"] || document.Nodes[0].Metadata["mediaId"] == public.MediaID || document.Nodes[0].Metadata["publicImageId"] != nil || document.Nodes[0].Metadata["assetId"] != nil {
		t.Fatalf("references not rewritten: %+v", document)
	}
	if _, err := repository.PreparePublicImageDeletion(public.ID, time.Now()); err != nil {
		t.Fatal(err)
	}
	replay, err := importCanvasPublicImages(context.Background(), store, user, project.ID, 2)
	if err != nil || replay.Project.Revision != 2 || store.copyCalls != 1 {
		t.Fatalf("replay=%+v / %v", replay, err)
	}
	if _, err := importCanvasPublicImages(context.Background(), store, PortalUser{UID: newID("other")}, project.ID, 2); err == nil {
		t.Fatal("another user migrated the canvas")
	}
}

func TestCanvasMissingLegacyReferenceCanSaveButCannotBeCopiedOrChanged(t *testing.T) {
	public, store := publicCopyFixture(t)
	user, project := publicCanvasFixture(t, public)
	db, _ := repository.DB()
	db.Delete(&model.PublicImage{}, "id = ?", public.ID)
	db.Delete(&model.Media{}, "id = ?", public.MediaID)
	result, err := importCanvasPublicImages(context.Background(), store, user, project.ID, 1)
	if err != nil || len(result.MissingNodeIDs) != 2 || result.Project.Revision != 1 {
		t.Fatalf("missing result=%+v err=%v", result, err)
	}
	saved, accepted, err := repository.UpdateCanvasProject(user.UID, project.ID, 1, "只改名称", project.Document, now())
	if err != nil || !accepted {
		t.Fatalf("unchanged historical reference blocked: %v", err)
	}
	var doc map[string]any
	json.Unmarshal(saved.Document, &doc)
	nodes := doc["nodes"].([]any)
	copied := map[string]any{}
	for k, v := range nodes[0].(map[string]any) {
		copied[k] = v
	}
	copied["id"] = "new-node"
	doc["nodes"] = append(nodes, copied)
	raw, _ := json.Marshal(doc)
	if _, _, err := repository.UpdateCanvasProject(user.UID, project.ID, 2, "copy", raw, now()); !errors.Is(err, repository.ErrCanvasMediaUnavailable) {
		t.Fatalf("new missing reference accepted: %v", err)
	}
	nodes[0].(map[string]any)["metadata"].(map[string]any)["mediaId"] = "different-missing-media"
	doc["nodes"] = nodes
	raw, _ = json.Marshal(doc)
	if _, _, err := repository.UpdateCanvasProject(user.UID, project.ID, 2, "changed", raw, now()); !errors.Is(err, repository.ErrCanvasMediaUnavailable) {
		t.Fatalf("changed missing reference accepted: %v", err)
	}
}

type concurrentCanvasEditCopyStore struct {
	*versionedTaskInputStore
	edit func()
}

func (s *concurrentCanvasEditCopyStore) CopyVersion(ctx context.Context, k, v, e, target string) (imageObjectMetadata, error) {
	s.edit()
	return s.versionedTaskInputStore.CopyVersion(ctx, k, v, e, target)
}
func TestCanvasPublicImportRevisionConflictDoesNotOverwriteAndReusesCopies(t *testing.T) {
	public, store := publicCopyFixture(t)
	user, project := publicCanvasFixture(t, public)
	updated := false
	wrapped := &concurrentCanvasEditCopyStore{store, func() {
		if updated {
			return
		}
		updated = true
		var doc map[string]any
		json.Unmarshal(project.Document, &doc)
		doc["nodes"].([]any)[0].(map[string]any)["position"] = map[string]any{"x": 999, "y": 888}
		raw, _ := json.Marshal(doc)
		_, ok, err := repository.UpdateCanvasProject(user.UID, project.ID, 1, "newer edit", raw, now())
		if err != nil || !ok {
			t.Fatalf("interleaved save: %v", err)
		}
	}}
	if _, err := importCanvasPublicImages(context.Background(), wrapped, user, project.ID, 1); !errors.Is(err, ErrCanvasProjectConflict) {
		t.Fatalf("stale conversion accepted: %v", err)
	}
	current, _, _ := repository.GetCanvasProject(user.UID, project.ID)
	if current.Title != "newer edit" || current.Revision != 2 {
		t.Fatalf("edit lost: %+v", current)
	}
	result, err := importCanvasPublicImages(context.Background(), store, user, project.ID, 2)
	if err != nil || result.Project.Title != "newer edit" || store.copyCalls != 1 {
		t.Fatalf("retry=%+v err=%v copies=%d", result, err, store.copyCalls)
	}
}

func TestCanvasPublicReferenceAndDeletionInterleave(t *testing.T) {
	for _, publicOnly := range []bool{false, true} {
		for _, deletionFirst := range []bool{false, true} {
			t.Run(fmt.Sprintf("publicOnly=%v/deleteFirst=%v", publicOnly, deletionFirst), func(t *testing.T) {
				public, _ := publicCopyFixture(t)
				metadata := map[string]any{"publicImageId": public.ID}
				if !publicOnly {
					metadata["mediaId"] = public.MediaID
				}
				raw, _ := json.Marshal(map[string]any{"nodes": []any{map[string]any{"id": "new-node", "type": "image", "metadata": metadata}}})
				project := model.CanvasProject{ID: newID("canvas-race"), OwnerUID: newID("canvas-owner"), Document: raw, Revision: 1}
				save := func() error { _, _, err := repository.CreateCanvasProject(project); return err }
				remove := func() error { _, err := repository.PreparePublicImageDeletion(public.ID, time.Now()); return err }
				first, second := save, remove
				if deletionFirst {
					first, second = remove, save
				}
				a, b := runMediaUploadIntentRace(t, first, second, func(tx *gorm.DB) bool {
					_, one := tx.Statement.Dest.(*model.Media)
					_, many := tx.Statement.Dest.(*[]model.Media)
					_, locking := tx.Statement.Clauses["FOR"]
					return (one || many) && locking
				})
				if a.err != nil {
					t.Fatal(a.err)
				}
				expected := repository.ErrPublicImageCanvasReferenced
				if deletionFirst {
					expected = repository.ErrCanvasMediaUnavailable
				}
				if !errors.Is(b.err, expected) {
					t.Fatalf("loser=%v want=%v", b.err, expected)
				}
				_, found, err := repository.GetCanvasProject(project.OwnerUID, project.ID)
				if err != nil || found == deletionFirst {
					t.Fatalf("canvas exists=%v err=%v", found, err)
				}
				_, found, err = repository.GetPublicImage(public.ID)
				if err != nil || found == deletionFirst {
					t.Fatalf("public exists=%v err=%v", found, err)
				}
			})
		}
	}
}

func TestCanvasPublicImportDistinguishesMissingVersionFromTemporaryFailure(t *testing.T) {
	for _, missing := range []bool{false, true} {
		t.Run(fmt.Sprintf("missing=%v", missing), func(t *testing.T) {
			public, store := publicCopyFixture(t)
			user, project := publicCanvasFixture(t, public)
			if missing {
				store.objects[public.Media.ObjectKey] = store.objects[public.Media.ObjectKey][1:]
			} else {
				store.headVersionErr = errors.New("temporary network failure")
			}
			result, err := importCanvasPublicImages(context.Background(), store, user, project.ID, 1)
			if err != nil {
				t.Fatal(err)
			}
			missingCount, pendingCount := 0, 2
			if missing {
				missingCount, pendingCount = 2, 0
			}
			if len(result.MissingNodeIDs) != missingCount || len(result.PendingNodeIDs) != pendingCount || store.copyCalls != 0 || result.Project.Revision != 1 {
				t.Fatalf("result=%+v", result)
			}
		})
	}
}

func TestCanvasPublicImportRenewsOnlyExpiredOrDeletedCopies(t *testing.T) {
	public, store := publicCopyFixture(t)
	user, project := publicCanvasFixture(t, public)
	request, err := canvasPublicImportRequest(user.UID, project.ID, public.MediaID)
	if err != nil {
		t.Fatal(err)
	}
	_, err = importPublicImage(context.Background(), &lostPublicCopyResponseStore{store}, user, public.ID, request)
	if err == nil {
		t.Fatal("lost response reported success")
	}
	same, err := canvasPublicImportRequest(user.UID, project.ID, public.MediaID)
	if err != nil || same != request {
		t.Fatalf("ambiguous reservation changed: %s %v", same, err)
	}
	db, _ := repository.DB()
	parsed, _ := uuid.Parse(request)
	oldID := publicImageImportIntentID(user.UID, parsed)
	if err := db.Model(&model.MediaUploadIntent{}).Where("id = ?", oldID).Updates(map[string]any{"expires_at": time.Now().Add(-time.Hour).Format(time.RFC3339Nano), "finalize_lease_until": nil}).Error; err != nil {
		t.Fatal(err)
	}
	next, err := canvasPublicImportRequest(user.UID, project.ID, public.MediaID)
	if err != nil || next == request {
		t.Fatalf("expired reservation not renewed: %s %v", next, err)
	}
	copy, err := importPublicImage(context.Background(), store, user, public.ID, next)
	if err != nil || store.copyCalls != 2 {
		t.Fatalf("new copy=%+v err=%v count=%d", copy, err, store.copyCalls)
	}
	old, found, err := repository.GetMediaUploadIntentForOwner(oldID, user.UID)
	if err != nil || !found || old.ObjectKey == copy.ObjectKey {
		t.Fatalf("lost old cleanup identity %+v %v", old, err)
	}
	if err := db.Model(&model.Media{}).Where("id = ?", copy.ID).Update("cleanup_status", model.MediaCleanupDeleting).Error; err != nil {
		t.Fatal(err)
	}
	renewed, err := canvasPublicImportRequest(user.UID, project.ID, public.MediaID)
	if err != nil || renewed == next {
		t.Fatalf("deleted copy not renewed: %s %v", renewed, err)
	}
}

func TestCanvasPublicImportFindsMediaOnlyAndPublicOnlyReferences(t *testing.T) {
	for _, mediaOnly := range []bool{false, true} {
		t.Run(fmt.Sprintf("mediaOnly=%v", mediaOnly), func(t *testing.T) {
			public, store := publicCopyFixture(t)
			user, project := publicCanvasFixture(t, public)
			var doc map[string]any
			if err := json.Unmarshal(project.Document, &doc); err != nil {
				t.Fatal(err)
			}
			for _, raw := range doc["nodes"].([]any) {
				metadata := raw.(map[string]any)["metadata"].(map[string]any)
				if mediaOnly {
					delete(metadata, "publicImageId")
				} else {
					delete(metadata, "mediaId")
				}
			}
			raw, _ := json.Marshal(doc)
			_, accepted, err := repository.UpdateCanvasProject(user.UID, project.ID, 1, project.Title, raw, now())
			if err != nil || !accepted {
				t.Fatalf("fixture save %v", err)
			}
			result, err := importCanvasPublicImages(context.Background(), store, user, project.ID, 2)
			if err != nil || len(result.Replacements) != 2 || store.copyCalls != 1 {
				t.Fatalf("result=%+v err=%v", result, err)
			}
			for _, replacement := range result.Replacements {
				if replacement.SourcePublicImageID != public.ID || replacement.SourceMediaID != public.MediaID || replacement.MediaID == public.MediaID {
					t.Fatalf("missing source identity: %+v", replacement)
				}
			}
		})
	}
}

func TestCanvasPublicImportKeepsOwnedPrivateContentWithStaleOrigin(t *testing.T) {
	public, store := publicCopyFixture(t)
	user, project := publicCanvasFixture(t, public)
	private := public.Media
	private.ID = newID("personal-media")
	private.OwnerUID = user.UID
	private.ObjectKey = newID("personal-key")
	db, _ := repository.DB()
	if err := db.Create(&private).Error; err != nil {
		t.Fatal(err)
	}
	var doc map[string]any
	if err := json.Unmarshal(project.Document, &doc); err != nil {
		t.Fatal(err)
	}
	for _, raw := range doc["nodes"].([]any) {
		raw.(map[string]any)["metadata"].(map[string]any)["mediaId"] = private.ID
	}
	raw, _ := json.Marshal(doc)
	_, accepted, err := repository.UpdateCanvasProject(user.UID, project.ID, 1, project.Title, raw, now())
	if err != nil || !accepted {
		t.Fatalf("fixture save %v", err)
	}
	result, err := importCanvasPublicImages(context.Background(), store, user, project.ID, 2)
	if err != nil || len(result.Replacements) != 2 || len(result.MissingNodeIDs) != 0 || store.copyCalls != 0 {
		t.Fatalf("owned content replaced or marked missing: result=%+v err=%v", result, err)
	}
	for _, replacement := range result.Replacements {
		if replacement.MediaID != private.ID {
			t.Fatalf("changed owned content %+v", replacement)
		}
	}
}
