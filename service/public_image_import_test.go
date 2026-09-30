package service

import (
	"bytes"
	"context"
	"errors"
	"testing"
	"time"

	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/repository"
	"github.com/google/uuid"
	"gorm.io/gorm"
)

func publicCopyFixture(t *testing.T) (model.PublicImage, *versionedTaskInputStore) {
	t.Helper()
	key := newID("public-source")
	media := model.Media{ID: newID("public-media"), OwnerUID: newID("admin"), ObjectKey: key, ObjectVersionID: "null", ObjectETag: "source-a", ContentType: "image/png", Bytes: int64(len(tinyPNG)), Width: 1, Height: 1, Filename: "source.png", CreatedAt: now()}
	db, _ := repository.DB()
	if err := db.Create(&media).Error; err != nil {
		t.Fatal(err)
	}
	item := model.PublicImage{ID: newID("public-image"), MediaID: media.ID, Title: "公共图片", Media: media}
	if _, err := repository.SavePublicImage(item); err != nil {
		t.Fatal(err)
	}
	store := &versionedTaskInputStore{objects: map[string][]versionedTestObject{key: {{data: tinyPNG, contentType: "image/png", etag: "source-a", versionID: "null"}, {data: append(append([]byte{}, tinyPNG...), byte(1)), contentType: "image/png", etag: "source-b", versionID: "b"}}}}
	return item, store
}

func TestPublicImageImportCopiesBoundVersionAndReplaysAfterPublicDeletion(t *testing.T) {
	public, store := publicCopyFixture(t)
	user := PortalUser{UID: newID("reader")}
	request := uuid.NewString()
	imported, err := importPublicImage(context.Background(), store, user, public.ID, request)
	if err != nil {
		t.Fatal(err)
	}
	if imported.ID == public.MediaID || imported.OwnerUID != user.UID || imported.ObjectVersionID == "" {
		t.Fatalf("not a private version-bound copy: %+v", imported)
	}
	object, err := store.version(imported.ObjectKey, imported.ObjectVersionID)
	if err != nil || !bytes.Equal(object.data, tinyPNG) {
		t.Fatalf("copied wrong version: %v", err)
	}
	if _, err := repository.PreparePublicImageDeletion(public.ID, time.Now()); err != nil {
		t.Fatal(err)
	}
	replay, err := importPublicImage(context.Background(), store, user, public.ID, request)
	if err != nil || replay.ID != imported.ID || store.copyCalls != 1 {
		t.Fatalf("replay=%+v err=%v copies=%d", replay, err, store.copyCalls)
	}
	_, err = importPublicImage(context.Background(), store, user, "different-public-id", request)
	if err == nil {
		t.Fatal("request UUID accepted another source")
	}
}

type lostPublicCopyResponseStore struct{ *versionedTaskInputStore }

func (store *lostPublicCopyResponseStore) CopyVersion(ctx context.Context, k, v, e, target string) (imageObjectMetadata, error) {
	_, err := store.versionedTaskInputStore.CopyVersion(ctx, k, v, e, target)
	if err != nil {
		return imageObjectMetadata{}, err
	}
	return imageObjectMetadata{}, errors.New("lost Copy response")
}
func TestPublicImageImportRecoversCopyWithoutSubmittingAgain(t *testing.T) {
	public, store := publicCopyFixture(t)
	user := PortalUser{UID: newID("reader")}
	request := uuid.NewString()
	_, err := importPublicImage(context.Background(), &lostPublicCopyResponseStore{store}, user, public.ID, request)
	if err == nil {
		t.Fatal("lost response reported success")
	}
	db, _ := repository.DB()
	if err := db.Model(&model.MediaUploadIntent{}).Where("owner_uid = ?", user.UID).Update("finalize_lease_until", time.Now().Add(-time.Minute)).Error; err != nil {
		t.Fatal(err)
	}
	imported, err := importPublicImage(context.Background(), store, user, public.ID, request)
	if err != nil || imported.ID == "" || store.copyCalls != 1 {
		t.Fatalf("recovery=%+v err=%v copies=%d", imported, err, store.copyCalls)
	}
}
func TestPublicImageImportRejectsMissingVersionWithoutPublishing(t *testing.T) {
	public, store := publicCopyFixture(t)
	store.objects[public.Media.ObjectKey] = store.objects[public.Media.ObjectKey][1:]
	user := PortalUser{UID: newID("reader")}
	if _, err := importPublicImage(context.Background(), store, user, public.ID, uuid.NewString()); err == nil {
		t.Fatal("missing source version accepted")
	}
	db, _ := repository.DB()
	var count int64
	db.Model(&model.Media{}).Where("owner_uid = ?", user.UID).Count(&count)
	if count != 0 || store.copyCalls != 0 {
		t.Fatalf("published %d copies %d", count, store.copyCalls)
	}
}
func TestPublicImageImportAndDeletionLockInterleave(t *testing.T) {
	for _, deletionFirst := range []bool{false, true} {
		t.Run(map[bool]string{false: "import-first", true: "delete-first"}[deletionFirst], func(t *testing.T) {
			public, _ := publicCopyFixture(t)
			current := time.Now().UTC()
			intent := model.MediaUploadIntent{ID: newID("copy-intent"), OwnerUID: newID("reader"), Intent: repository.PublicImageImportIntent, ObjectKey: newID("copy-key"), ExpiresAt: current.Add(time.Hour).Format(time.RFC3339Nano), SourcePublicImageID: public.ID, SourceMediaID: public.MediaID, SourceObjectKey: public.Media.ObjectKey, SourceVersionID: "null", SourceETag: "source-a"}
			register := func() error { _, err := repository.ReservePublicImageImport(context.Background(), intent); return err }
			remove := func() error { _, err := repository.PreparePublicImageDeletion(public.ID, current); return err }
			first, second := register, remove
			if deletionFirst {
				first, second = remove, register
			}
			a, b := runMediaUploadIntentRace(t, first, second, func(tx *gorm.DB) bool {
				_, media := tx.Statement.Dest.(*model.Media)
				_, locking := tx.Statement.Clauses["FOR"]
				return media && locking
			})
			if a.err != nil || b.err == nil {
				t.Fatalf("first=%v second=%v", a.err, b.err)
			}
		})
	}
}

func TestPublicImageImportPublicationAndCleanupInterleave(t *testing.T) {
	for _, cleanupFirst := range []bool{false, true} {
		t.Run(map[bool]string{false: "publish-first", true: "cleanup-first"}[cleanupFirst], func(t *testing.T) {
			current := time.Now().UTC()
			owner := newID("reader")
			intent := model.MediaUploadIntent{ID: newID("copy-intent"), OwnerUID: owner, Intent: repository.PublicImageImportIntent, ObjectKey: newID("copy-key"), ExpiresAt: current.Add(-time.Hour).Format(time.RFC3339Nano), FinalizeClaimID: "publisher", FinalizeLeaseUntil: &current}
			if err := repository.SaveMediaUploadIntent(intent); err != nil {
				t.Fatal(err)
			}
			item := model.Media{ID: newID("copy-media"), OwnerUID: owner, ObjectKey: intent.ObjectKey, ObjectVersionID: "v", ObjectETag: "e"}
			publish := func() error {
				_, err := repository.PublishPublicImageImport(context.Background(), intent, item, current.Add(-time.Second))
				return err
			}
			var keys []string
			cleanup := func() error {
				_, k, _, err := repository.ClaimMediaUploadCleanup(context.Background(), intent.ID, current)
				keys = k
				return err
			}
			first, second := publish, cleanup
			if cleanupFirst {
				first, second = cleanup, publish
			}
			a, b := runMediaUploadIntentRace(t, first, second)
			if a.err != nil {
				t.Fatal(a.err)
			}
			if cleanupFirst {
				if b.err == nil || len(keys) != 1 {
					t.Fatalf("late publish=%v keys=%v", b.err, keys)
				}
			} else if b.err != nil || len(keys) != 0 {
				t.Fatalf("published key deleted: %v keys=%v", b.err, keys)
			}
		})
	}
}
func TestPublicImageImportCannotUseBrowserFinalizeAndCannotRecopyUnknownResult(t *testing.T) {
	public, store := publicCopyFixture(t)
	user := PortalUser{UID: newID("reader")}
	request := uuid.NewString()
	_, err := importPublicImage(context.Background(), &lostPublicCopyResponseStore{store}, user, public.ID, request)
	if err == nil {
		t.Fatal("expected unknown response")
	}
	db, _ := repository.DB()
	var intent model.MediaUploadIntent
	if err := db.Where("owner_uid = ? AND intent = ?", user.UID, repository.PublicImageImportIntent).First(&intent).Error; err != nil {
		t.Fatal(err)
	}
	if _, _, err := CompleteMediaUploadIntent(context.Background(), user, intent.ID); err == nil {
		t.Fatal("browser finalized a server reservation")
	}
	delete(store.objects, intent.ObjectKey)
	db.Model(&intent).Update("finalize_lease_until", time.Now().Add(-time.Minute))
	if _, err := importPublicImage(context.Background(), store, user, public.ID, request); err == nil {
		t.Fatal("missing ambiguous target published")
	}
	if store.copyCalls != 1 {
		t.Fatalf("duplicated Copy: %d", store.copyCalls)
	}
}
