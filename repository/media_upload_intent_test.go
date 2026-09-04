package repository

import (
	"testing"
	"time"

	"github.com/basketikun/infinite-canvas/config"
	"github.com/basketikun/infinite-canvas/model"
)

func TestCompleteMediaUploadIntentIsOwnerScopedAndIdempotent(t *testing.T) {
	useRepositoryTestDB(t, config.Config{StorageDriver: "sqlite", DatabaseDSN: ":memory:"})
	intent := model.MediaUploadIntent{
		ID: "upload-intent-1", OwnerUID: "owner-1", ObjectKey: "images/private/owner-1/upload.png",
		Filename: "upload.png", ContentType: "image/png", ExpectedBytes: 42, Intent: "library",
		ExpiresAt: time.Now().UTC().Add(time.Minute).Format(time.RFC3339Nano), CreatedAt: time.Now().UTC().Format(time.RFC3339Nano),
	}
	if err := SaveMediaUploadIntent(intent); err != nil {
		t.Fatal(err)
	}
	firstMedia := model.Media{ID: "media-1", OwnerUID: intent.OwnerUID, ObjectKey: intent.ObjectKey, ContentType: intent.ContentType, Bytes: intent.ExpectedBytes}
	if _, _, completed, err := FinalizeMediaUploadIntent(intent.ID, intent.OwnerUID, time.Now().UTC().Format(time.RFC3339Nano), firstMedia); err != nil || !completed {
		t.Fatalf("first completion = completed %t, err %v", completed, err)
	}
	item, media, completed, err := FinalizeMediaUploadIntent(intent.ID, intent.OwnerUID, time.Now().UTC().Format(time.RFC3339Nano), model.Media{ID: "media-2", OwnerUID: intent.OwnerUID, ObjectKey: "another-object"})
	if err != nil || completed || item.CompletedMediaID != "media-1" || media.ID != "media-1" {
		t.Fatalf("duplicate completion = %#v/%#v, completed %t, err %v", item, media, completed, err)
	}
	if _, found, err := GetMediaUploadIntentForOwner(intent.ID, "other-user"); err != nil || found {
		t.Fatalf("foreign owner lookup = found %t, err %v", found, err)
	}
}

func TestListExpiredUncompletedMediaUploadIntentsExcludesCompletedItems(t *testing.T) {
	useRepositoryTestDB(t, config.Config{StorageDriver: "sqlite", DatabaseDSN: ":memory:"})
	now := time.Now().UTC()
	for _, item := range []model.MediaUploadIntent{
		{ID: "expired-pending", OwnerUID: "owner", ObjectKey: "expired-pending", ExpiresAt: now.Add(-time.Minute).Format(time.RFC3339Nano), CreatedAt: now.Format(time.RFC3339Nano)},
		{ID: "expired-completed", OwnerUID: "owner", ObjectKey: "expired-completed", ExpiresAt: now.Add(-time.Minute).Format(time.RFC3339Nano), CompletedMediaID: "media-1", CreatedAt: now.Format(time.RFC3339Nano)},
		{ID: "active-pending", OwnerUID: "owner", ObjectKey: "active-pending", ExpiresAt: now.Add(time.Minute).Format(time.RFC3339Nano), CreatedAt: now.Format(time.RFC3339Nano)},
	} {
		if err := SaveMediaUploadIntent(item); err != nil {
			t.Fatal(err)
		}
	}
	items, err := ListExpiredUncompletedMediaUploadIntents(now.Format(time.RFC3339Nano))
	if err != nil || len(items) != 1 || items[0].ID != "expired-pending" {
		t.Fatalf("expired uncompleted = %#v, err %v", items, err)
	}
}

func TestFinalizeMediaUploadIntentCreatesOnlyOneMediaRecord(t *testing.T) {
	useRepositoryTestDB(t, config.Config{StorageDriver: "sqlite", DatabaseDSN: ":memory:"})
	now := time.Now().UTC()
	intent := model.MediaUploadIntent{ID: "upload-intent-finalize", OwnerUID: "owner", ObjectKey: "images/private/owner/finalize.png", Filename: "finalize.png", ContentType: "image/png", ExpectedBytes: 42, ExpiresAt: now.Add(time.Minute).Format(time.RFC3339Nano), CreatedAt: now.Format(time.RFC3339Nano)}
	if err := SaveMediaUploadIntent(intent); err != nil {
		t.Fatal(err)
	}
	first := model.Media{ID: "media-first", OwnerUID: "owner", ObjectKey: intent.ObjectKey, ContentType: "image/png", Bytes: 42}
	if _, media, created, err := FinalizeMediaUploadIntent(intent.ID, intent.OwnerUID, now.Format(time.RFC3339Nano), first); err != nil || !created || media.ID != first.ID {
		t.Fatalf("first finalize = %#v, created=%t, err=%v", media, created, err)
	}
	second := model.Media{ID: "media-second", OwnerUID: "owner", ObjectKey: "other-key"}
	if _, media, created, err := FinalizeMediaUploadIntent(intent.ID, intent.OwnerUID, now.Format(time.RFC3339Nano), second); err != nil || created || media.ID != first.ID {
		t.Fatalf("repeated finalize = %#v, created=%t, err=%v", media, created, err)
	}
	database, err := DB()
	if err != nil {
		t.Fatal(err)
	}
	var count int64
	if err := database.Model(&model.Media{}).Count(&count).Error; err != nil || count != 1 {
		t.Fatalf("media count = %d, err=%v", count, err)
	}
}
