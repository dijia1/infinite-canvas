package service

import (
	"context"
	"errors"
	"github.com/basketikun/infinite-canvas/config"
	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/repository"
	"gorm.io/gorm"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"
)

func TestMaskUploadIsTemporaryAndHidden(t *testing.T) {
	owner := PortalUser{UID: newID("mask-owner")}
	before := time.Now().UTC()
	access, err := SaveUploadedImage(context.Background(), owner, "mask.png", "image/png", tinyPNG, "mask")
	if err != nil {
		t.Fatal(err)
	}
	item, found, err := repository.GetMedia(access.MediaID)
	if err != nil || !found || item.Source != model.MediaSource("mask") || item.ExpiresAt == nil {
		t.Fatalf("not a temporary mask: %+v %v", item, err)
	}
	if item.ExpiresAt.Before(before.Add(24*time.Hour)) || item.ExpiresAt.After(time.Now().Add(24*time.Hour)) {
		t.Fatalf("incorrect mask expiry: %v", item.ExpiresAt)
	}
	if _, err := repository.SetPrivateMediaExpiry(item.ID, owner.UID, nil); err != nil {
		t.Fatal(err)
	}
	library, err := repository.ListPrivateMedia(owner.UID, repository.PrivateMediaKindImage)
	if err != nil || len(library) != 0 {
		t.Fatalf("mask entered library: %+v %v", library, err)
	}
	stored, _, _ := repository.GetMedia(item.ID)
	if stored.ExpiresAt == nil {
		t.Fatal("temporary mask was promoted")
	}
	ordinary, err := SaveUploadedImage(context.Background(), owner, "mask.png", "image/png", tinyPNG, "canvas")
	if err != nil {
		t.Fatal(err)
	}
	normal, _, _ := repository.GetMedia(ordinary.MediaID)
	if normal.ExpiresAt != nil || normal.Source != model.MediaSourceUpload {
		t.Fatal("filename changed normal image lifecycle")
	}
}

func createMaskPreparingTask(item model.Media) (model.ImageGenerationTask, error) {
	task := model.ImageGenerationTask{ID: newID("mask-task"), OwnerUID: item.OwnerUID, ClientRequestID: newID("request"), Status: model.ImageTaskPreparing, OperationLogID: newID("operation"), CreatedAt: now(), UpdatedAt: now()}
	input := model.ImageGenerationTaskInput{ID: newID("mask-input"), TaskID: task.ID, SourceMediaID: item.ID, Purpose: "mask", PreparationStatus: "ready"}
	_, _, err := repository.CreateImageGenerationTaskWithInputsAndOperationLog(task, model.OperationLog{ID: task.OperationLogID, ActorUID: item.OwnerUID, Status: model.OperationStatusSubmitted}, []model.ImageGenerationTaskInput{input})
	return task, err
}

func TestMaskPreparationRetainsExpiryAndSchedulesLastRelease(t *testing.T) {
	expiry := time.Now().UTC().Add(-time.Minute)
	item := model.Media{ID: newID("mask"), OwnerUID: newID("owner"), Source: model.MediaSource("mask"), ObjectKey: newID("mask-key"), ExpiresAt: &expiry, ContentType: "image/png"}
	if _, err := repository.SaveMedia(item); err != nil {
		t.Fatal(err)
	}
	a, err := createMaskPreparingTask(item)
	if err != nil {
		t.Fatal(err)
	}
	b, err := createMaskPreparingTask(item)
	if err != nil {
		t.Fatal(err)
	}
	current := time.Now().UTC()
	claimed, err := repository.ClaimCanvasMediaCleanupBatch([]string{item.ID}, current, 2*time.Minute)
	if err != nil || len(claimed) != 0 {
		t.Fatalf("preparing mask claimed: %+v %v", claimed, err)
	}
	stored, _, _ := repository.GetMedia(item.ID)
	if stored.ExpiresAt == nil || !stored.ExpiresAt.After(current) {
		t.Fatal("preparing reference made mask permanent")
	}
	if err := repository.QueuePreparedImageGenerationTask(a.ID, "[]", current.Format(time.RFC3339Nano)); err != nil {
		t.Fatal(err)
	}
	// Even after the first delay expires, the other preparing task protects it.
	later := current.Add(6 * time.Minute)
	claimed, err = repository.ClaimCanvasMediaCleanupBatch([]string{item.ID}, later, 2*time.Minute)
	if err != nil || len(claimed) != 0 {
		t.Fatalf("second preparation lost protection: %+v %v", claimed, err)
	}
	if err := repository.FailPreparingImageGenerationTask(b.ID, "preparation rejected", later.Format(time.RFC3339Nano)); err != nil {
		t.Fatal(err)
	}
	stored, _, _ = repository.GetMedia(item.ID)
	if stored.ExpiresAt == nil || stored.ExpiresAt.Sub(later.Add(5*time.Minute)) > time.Millisecond || stored.ExpiresAt.Before(later.Add(5*time.Minute-time.Millisecond)) {
		t.Fatalf("last release expiry %v", stored.ExpiresAt)
	}
	claimed, err = repository.ClaimCanvasMediaCleanupBatch([]string{item.ID}, later.Add(6*time.Minute), 2*time.Minute)
	if err != nil || len(claimed) != 1 {
		t.Fatalf("released mask never eligible: %+v %v", claimed, err)
	}
}

func TestMaskFinalizeKeepsInitialExpiry(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "image/png")
		w.Header().Set("Content-Length", strconv.Itoa(len(tinyPNG)))
		w.Header().Set("ETag", "mask-etag")
		w.Header().Set("x-oss-version-id", "mask-version")
		if r.Method == http.MethodGet {
			_, _ = w.Write(tinyPNG)
		}
	}))
	defer server.Close()
	previous := config.Cfg
	t.Cleanup(func() { config.Cfg = previous })
	config.Cfg.MediaStorage = "oss"
	config.Cfg.OSSRegion, config.Cfg.OSSBucket = "cn-test", "test"
	config.Cfg.OSSInternalEndpoint, config.Cfg.OSSPublicEndpoint = server.URL, server.URL
	config.Cfg.OSSAccessKeyID, config.Cfg.OSSAccessKeySecret = "fake", "fake"
	config.Cfg.OSSSignedURLTTL = "15m"
	ctx := context.Background()
	user := PortalUser{UID: newID("mask-owner")}
	current := time.Now().UTC()
	intent := model.MediaUploadIntent{ID: newID("mask-upload"), OwnerUID: user.UID, ObjectKey: newID("mask-key") + ".png", Filename: "mask.png", ContentType: "image/png", ExpectedBytes: int64(len(tinyPNG)), Intent: "mask", ExpiresAt: current.Add(time.Hour).Format(time.RFC3339Nano), CreatedAt: now()}
	if err := repository.SaveMediaUploadIntent(intent); err != nil {
		t.Fatal(err)
	}
	first, created, err := CompleteMediaUploadIntent(ctx, user, intent.ID)
	if err != nil || !created {
		t.Fatalf("finalize: %+v %v", first, err)
	}
	item, _, _ := repository.GetMedia(first.MediaID)
	if item.Source != model.MediaSourceMask || item.ExpiresAt == nil || item.ExpiresAt.Before(current.Add(24*time.Hour)) {
		t.Fatalf("mask lifetime: %+v", item)
	}
	second, created, err := CompleteMediaUploadIntent(ctx, user, intent.ID)
	if err != nil || created || second.MediaID != first.MediaID || !second.MediaExpiresAt.Equal(*item.ExpiresAt) {
		t.Fatalf("repeated finalize changed lifetime: %+v %v", second, err)
	}
	_, _, _, err = validateMediaUploadIntentInput(MediaUploadIntentInput{Filename: "mask.mp4", ContentType: "video/mp4", Bytes: 100, Intent: "mask"})
	if err == nil {
		t.Fatal("mask intent accepted video")
	}
}

func TestMaskCreationAndCleanupInterleave(t *testing.T) {
	for _, cleanupFirst := range []bool{false, true} {
		t.Run(map[bool]string{false: "creation-first", true: "cleanup-first"}[cleanupFirst], func(t *testing.T) {
			expiry := time.Now().UTC().Add(-time.Minute)
			item, err := repository.SaveMedia(model.Media{ID: newID("mask"), OwnerUID: newID("owner"), Source: model.MediaSourceMask, ObjectKey: newID("key"), ContentType: "image/png", ExpiresAt: &expiry})
			if err != nil {
				t.Fatal(err)
			}
			var claimed []model.Media
			create := func() error { _, err := createMaskPreparingTask(item); return err }
			cleanup := func() error {
				var err error
				claimed, err = repository.ClaimCanvasMediaCleanupBatch([]string{item.ID}, time.Now().UTC(), time.Minute)
				return err
			}
			first, second := create, cleanup
			if cleanupFirst {
				first, second = cleanup, create
			}
			a, b := runMediaUploadIntentRace(t, first, second, func(tx *gorm.DB) bool {
				_, media := tx.Statement.Dest.(*[]model.Media)
				_, locked := tx.Statement.Clauses["FOR"]
				return media && locked
			})
			if a.err != nil {
				t.Fatal(a.err)
			}
			if cleanupFirst {
				if len(claimed) != 1 || !errors.Is(b.err, repository.ErrCanvasMediaUnavailable) {
					t.Fatalf("cleanup did not fence creation: %v %v", claimed, b.err)
				}
			} else {
				if b.err != nil || len(claimed) != 0 {
					t.Fatalf("preparing media deleted: %v %v", claimed, b.err)
				}
				saved, _, _ := repository.GetMedia(item.ID)
				if saved.ExpiresAt == nil {
					t.Fatal("preparation promoted mask")
				}
			}
		})
	}
}
