package service

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/repository"
)

func testValidCanvasDocument(mediaIDs ...string) []byte {
	nodes := make([]map[string]any, 0, len(mediaIDs))
	for index, mediaID := range mediaIDs {
		nodes = append(nodes, map[string]any{
			"id":       "image-" + string(rune('a'+index)),
			"type":     "image",
			"title":    "image",
			"position": map[string]any{"x": 0, "y": 0},
			"width":    100,
			"height":   100,
			"metadata": map[string]any{"mediaId": mediaID},
		})
	}
	document, _ := json.Marshal(map[string]any{
		"nodes":          nodes,
		"maskResources":  map[string]any{},
		"connections":    []any{},
		"backgroundMode": "lines",
		"showImageInfo":  false,
		"viewport":       map[string]any{"x": 0, "y": 0, "k": 1},
	})
	return document
}

func saveTestPrivateMedia(t *testing.T, id, ownerUID string, expiresAt *time.Time) model.Media {
	t.Helper()
	item := model.Media{ID: id, OwnerUID: ownerUID, Source: model.MediaSourceUpload, ObjectKey: "canvas-cleanup/" + id, ExpiresAt: expiresAt}
	if _, err := repository.SaveMedia(item); err != nil {
		t.Fatalf("SaveMedia(): %v", err)
	}
	return item
}

func saveTestCanvasProject(t *testing.T, id, ownerUID string, document []byte) {
	t.Helper()
	if _, inserted, err := repository.CreateCanvasProject(model.CanvasProject{ID: id, OwnerUID: ownerUID, Title: id, Document: model.CanvasProjectDocument(document), Revision: 1, CreatedAt: now(), UpdatedAt: now()}); err != nil || !inserted {
		t.Fatalf("CreateCanvasProject() inserted=%t err=%v", inserted, err)
	}
}

func TestUpdateCanvasProjectSchedulesOnlyRemovedUnreferencedMedia(t *testing.T) {
	const ownerUID = "canvas-media-removal-owner"
	const mediaID = "canvas-media-removal-media"
	saveTestPrivateMedia(t, mediaID, ownerUID, nil)
	saveTestCanvasProject(t, "canvas-media-removal-project", ownerUID, testValidCanvasDocument(mediaID))
	before := time.Now().UTC()

	if _, _, err := UpdateCanvasProject(context.Background(), PortalUser{UID: ownerUID}, "canvas-media-removal-project", CanvasProjectUpdateInput{Revision: 1, Title: "canvas-media-removal-project", Document: testValidCanvasDocument()}, ""); err != nil {
		t.Fatalf("UpdateCanvasProject(): %v", err)
	}
	after := time.Now().UTC()
	stored, found, err := repository.GetMedia(mediaID)
	if err != nil || !found || stored.ExpiresAt == nil {
		t.Fatalf("pending media = %#v, found=%t, err=%v", stored, found, err)
	}
	if stored.ExpiresAt.Before(before.Add(5*time.Minute).Truncate(time.Microsecond)) || stored.ExpiresAt.After(after.Add(5*time.Minute)) {
		t.Fatalf("expires_at = %s, want between %s and %s", stored.ExpiresAt, before.Add(5*time.Minute), after.Add(5*time.Minute))
	}
	items, err := repository.ListPrivateMedia(ownerUID, repository.PrivateMediaKindImage)
	if err != nil || len(items) != 0 {
		t.Fatalf("ListPrivateMedia() = %#v, %v; pending media must be hidden", items, err)
	}
}

func TestUpdateCanvasProjectKeepsMediaUsedByAnotherCanvas(t *testing.T) {
	const ownerUID = "canvas-media-retained-owner"
	const mediaID = "canvas-media-retained-media"
	saveTestPrivateMedia(t, mediaID, ownerUID, nil)
	saveTestCanvasProject(t, "canvas-media-retained-current", ownerUID, testValidCanvasDocument(mediaID))
	saveTestCanvasProject(t, "canvas-media-retained-other", ownerUID, testValidCanvasDocument(mediaID))

	if _, _, err := UpdateCanvasProject(context.Background(), PortalUser{UID: ownerUID}, "canvas-media-retained-current", CanvasProjectUpdateInput{Revision: 1, Title: "canvas-media-retained-current", Document: testValidCanvasDocument()}, ""); err != nil {
		t.Fatalf("UpdateCanvasProject(): %v", err)
	}
	stored, found, err := repository.GetMedia(mediaID)
	if err != nil || !found || stored.ExpiresAt != nil {
		t.Fatalf("referenced media = %#v, found=%t, err=%v", stored, found, err)
	}
}

func TestUpdateCanvasProjectKeepsPublicMedia(t *testing.T) {
	const ownerUID = "canvas-media-public-owner"
	const mediaID = "canvas-media-public-media"
	saveTestPrivateMedia(t, mediaID, ownerUID, nil)
	saveTestCanvasProject(t, "canvas-media-public-project", ownerUID, testValidCanvasDocument(mediaID))
	if _, err := repository.SavePublicImage(model.PublicImage{ID: "canvas-media-public-image", MediaID: mediaID, Title: "public", UploaderUID: ownerUID, CreatedAt: now()}); err != nil {
		t.Fatalf("SavePublicImage(): %v", err)
	}

	if _, _, err := UpdateCanvasProject(context.Background(), PortalUser{UID: ownerUID}, "canvas-media-public-project", CanvasProjectUpdateInput{Revision: 1, Title: "canvas-media-public-project", Document: testValidCanvasDocument()}, ""); err != nil {
		t.Fatalf("UpdateCanvasProject(): %v", err)
	}
	stored, found, err := repository.GetMedia(mediaID)
	if err != nil || !found || stored.ExpiresAt != nil {
		t.Fatalf("public media = %#v, found=%t, err=%v", stored, found, err)
	}
}

func TestUpdateCanvasProjectRestoresMediaReaddedByUndo(t *testing.T) {
	const ownerUID = "canvas-media-undo-owner"
	const mediaID = "canvas-media-undo-media"
	pendingAt := time.Now().UTC().Add(time.Minute)
	saveTestPrivateMedia(t, mediaID, ownerUID, nil)
	saveTestCanvasProject(t, "canvas-media-undo-project", ownerUID, testValidCanvasDocument())
	if _, err := repository.SetPrivateMediaExpiry(mediaID, ownerUID, &pendingAt); err != nil {
		t.Fatalf("SetPrivateMediaExpiry(): %v", err)
	}

	if _, _, err := UpdateCanvasProject(context.Background(), PortalUser{UID: ownerUID}, "canvas-media-undo-project", CanvasProjectUpdateInput{Revision: 1, Title: "canvas-media-undo-project", Document: testValidCanvasDocument(mediaID)}, ""); err != nil {
		t.Fatalf("UpdateCanvasProject(): %v", err)
	}
	stored, found, err := repository.GetMedia(mediaID)
	if err != nil || !found || stored.ExpiresAt != nil {
		t.Fatalf("restored media = %#v, found=%t, err=%v", stored, found, err)
	}
}

func TestUpdateCanvasProjectDoesNotReprocessAnIdempotentSave(t *testing.T) {
	const ownerUID = "canvas-media-idempotent-owner"
	const mediaID = "canvas-media-idempotent-media"
	const projectID = "canvas-media-idempotent-project"
	saveTestPrivateMedia(t, mediaID, ownerUID, nil)
	saveTestCanvasProject(t, projectID, ownerUID, testValidCanvasDocument(mediaID))
	input := CanvasProjectUpdateInput{Revision: 1, Title: projectID, Document: testValidCanvasDocument()}
	requestID := "2c3aeaf5-a6f8-4d6b-b21b-166f47cd09d5"

	if _, deduplicated, err := UpdateCanvasProject(context.Background(), PortalUser{UID: ownerUID}, projectID, input, requestID); err != nil || deduplicated != CanvasSaveWritten {
		t.Fatalf("first UpdateCanvasProject() deduplicated=%s err=%v", deduplicated, err)
	}
	if _, err := repository.SetPrivateMediaExpiry(mediaID, ownerUID, nil); err != nil {
		t.Fatalf("SetPrivateMediaExpiry(): %v", err)
	}
	if _, deduplicated, err := UpdateCanvasProject(context.Background(), PortalUser{UID: ownerUID}, projectID, input, requestID); err != nil || deduplicated != CanvasSaveReceiptReplay {
		t.Fatalf("retry UpdateCanvasProject() deduplicated=%s err=%v", deduplicated, err)
	}
	stored, found, err := repository.GetMedia(mediaID)
	if err != nil || !found || stored.ExpiresAt != nil {
		t.Fatalf("idempotent retry unexpectedly changed media = %#v, found=%t, err=%v", stored, found, err)
	}
}

func TestUpdateCanvasProjectConflictDoesNotScheduleMediaCleanup(t *testing.T) {
	const ownerUID = "canvas-media-conflict-owner"
	const mediaID = "canvas-media-conflict-media"
	const projectID = "canvas-media-conflict-project"
	saveTestPrivateMedia(t, mediaID, ownerUID, nil)
	saveTestCanvasProject(t, projectID, ownerUID, testValidCanvasDocument(mediaID))
	if _, accepted, err := repository.UpdateCanvasProject(ownerUID, projectID, 1, projectID, testValidCanvasDocument(mediaID), now()); err != nil || !accepted {
		t.Fatalf("advance project revision accepted=%t err=%v", accepted, err)
	}

	_, _, err := UpdateCanvasProject(context.Background(), PortalUser{UID: ownerUID}, projectID, CanvasProjectUpdateInput{Revision: 1, Title: projectID, Document: testValidCanvasDocument()}, "")
	if !errors.Is(err, ErrCanvasProjectConflict) {
		t.Fatalf("UpdateCanvasProject() error = %v, want revision conflict", err)
	}
	stored, found, err := repository.GetMedia(mediaID)
	if err != nil || !found || stored.ExpiresAt != nil {
		t.Fatalf("conflicted media = %#v, found=%t, err=%v", stored, found, err)
	}
}

func TestCleanupExpiredCanvasMediaDeletesOnlyUnreferencedObject(t *testing.T) {
	const ownerUID = "canvas-media-cleanup-owner"
	const mediaID = "canvas-media-cleanup-media"
	expiredAt := time.Now().UTC().Add(-time.Minute)
	item := saveTestPrivateMedia(t, mediaID, ownerUID, &expiredAt)
	store, err := newImageStore()
	if err != nil {
		t.Fatalf("newImageStore(): %v", err)
	}
	if err := store.Put(context.Background(), item.ObjectKey, []byte("image"), "image/png"); err != nil {
		t.Fatalf("store.Put(): %v", err)
	}

	if err := CleanupExpiredCanvasMedia(time.Now()); err != nil {
		t.Fatalf("CleanupExpiredCanvasMedia(): %v", err)
	}
	if _, found, err := repository.GetMedia(mediaID); err != nil || found {
		t.Fatalf("GetMedia() found=%t err=%v, want deleted", found, err)
	}
	if reader, err := store.Get(context.Background(), item.ObjectKey); !errors.Is(err, os.ErrNotExist) {
		if reader != nil {
			_ = reader.Close()
		}
		t.Fatalf("store.Get() error = %v, want not exist", err)
	}
}
