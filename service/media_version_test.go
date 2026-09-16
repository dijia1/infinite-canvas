package service

import (
	"context"
	"errors"
	"fmt"
	"github.com/aliyun/alibabacloud-oss-go-sdk-v2/oss"
	"github.com/aliyun/alibabacloud-oss-go-sdk-v2/oss/credentials"
	"net/url"
	"os"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/repository"
)

func versionIdentityFixture(t *testing.T, version string) (*versionedTaskInputStore, model.Media) {
	t.Helper()
	key := newID("version-source")
	store := &versionedTaskInputStore{objects: map[string][]versionedTestObject{key: {
		{data: tinyPNG, contentType: "image/png", etag: "etag-A", versionID: "null"},
		{data: append(append([]byte{}, tinyPNG...), 'B'), contentType: "image/png", etag: "etag-B", versionID: "B"},
	}}}
	item, err := repository.SaveMedia(model.Media{ID: newID("media"), OwnerUID: newID("owner"), ObjectKey: key, ObjectVersionID: version, ObjectETag: "etag-A", ContentType: "image/png", Filename: "source.png", Bytes: int64(len(tinyPNG))})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = repository.DeleteMedia(item.ID) })
	return store, item
}

func TestMediaURLsAndShareUseBoundVersion(t *testing.T) {
	ctx := context.Background()
	store, item := versionIdentityFixture(t, "null")
	access, err := mediaAccess(ctx, store, item)
	if err != nil {
		t.Fatal(err)
	}
	for _, address := range []string{access.URL, access.PreviewURL} {
		parsed, err := url.Parse(address)
		if err != nil || parsed.Query().Get("versionId") != "null" {
			t.Fatalf("URL not bound to null version: %q / %v", address, err)
		}
	}
	parsed, _ := url.Parse(access.PreviewURL)
	if parsed.Query().Get("x-oss-process") != mediaPreviewProcess {
		t.Fatalf("preview processing lost: %s", access.PreviewURL)
	}
	copy, err := copyCanvasShareMedia(ctx, store, item, newID("recipient"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = repository.DeleteMedia(copy.ID) })
	if copy.ObjectVersionID == "" || copy.ObjectETag == "" {
		t.Fatalf("share identity missing: %+v", copy)
	}
	object, err := store.version(copy.ObjectKey, copy.ObjectVersionID)
	if err != nil || string(object.data) != string(tinyPNG) {
		t.Fatalf("shared current object B instead of A: %v", err)
	}
}

func TestMissingMediaVersionDoesNotFallBackToCurrent(t *testing.T) {
	store, item := versionIdentityFixture(t, "gone")
	_, err := mediaAccess(context.Background(), store, item)
	if !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("missing version silently accepted: %v", err)
	}
	if _, err = copyCanvasShareMedia(context.Background(), store, item, newID("recipient")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("share missing version: %v", err)
	}
}

func TestConcurrentLegacyMediaBindingKeepsWinner(t *testing.T) {
	store, item := versionIdentityFixture(t, "")
	// An existing ETag must not silently bind to changed current content.
	if _, err := mediaAccess(context.Background(), store, item); err == nil {
		t.Fatal("legacy ETag mismatch accepted")
	}
	db, _ := repository.DB()
	if err := db.Model(&model.Media{}).Where("id = ?", item.ID).Update("object_etag", "").Error; err != nil {
		t.Fatal(err)
	}
	item.ObjectETag = ""
	var wg sync.WaitGroup
	errs := make(chan error, 2)
	for range 2 {
		wg.Add(1)
		go func() { defer wg.Done(); _, err := mediaAccess(context.Background(), store, item); errs <- err }()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	saved, _, err := repository.GetMedia(item.ID)
	if err != nil || saved.ObjectVersionID != "B" || saved.ObjectETag != "etag-B" {
		t.Fatalf("legacy identity not bound: %+v / %v", saved, err)
	}
}

func TestOSSMediaSignaturesCarryVersionAndProcessing(t *testing.T) {
	client := oss.NewClient(oss.LoadDefaultConfig().WithRegion("cn-hongkong").WithCredentialsProvider(credentials.NewStaticCredentialsProvider("test-id", "test-secret")))
	store := &ossImageStore{public: client, bucket: "test", ttl: time.Hour}
	for _, process := range []string{"", mediaPreviewProcess, videoSnapshotProcess(5)} {
		for _, disposition := range []string{"", VideoDownloadDisposition("clip.mp4")} {
			address, _, err := store.SignedMediaURL(context.Background(), "media.png", "null", process, disposition)
			if err != nil {
				t.Fatal(err)
			}
			parsed, _ := url.Parse(address)
			q := parsed.Query()
			if q.Get("versionId") != "null" || q.Get("x-oss-process") != process || q.Get("response-content-disposition") != disposition {
				t.Fatalf("bad signature: %s", address)
			}
		}
	}
}

type racingMediaHeadStore struct {
	*versionedTaskInputStore
	calls   atomic.Int32
	first   chan struct{}
	release chan struct{}
}

func (s *racingMediaHeadStore) Head(ctx context.Context, key string) (imageObjectMetadata, error) {
	if s.calls.Add(1) == 1 {
		old, _ := s.version(key, "null")
		close(s.first)
		select {
		case <-s.release:
		case <-ctx.Done():
			return imageObjectMetadata{}, ctx.Err()
		}
		return testObjectMetadata(old), nil
	}
	return s.versionedTaskInputStore.Head(ctx, key)
}
func TestConcurrentLegacyBindingUsesOtherCallersVersion(t *testing.T) {
	store, item := versionIdentityFixture(t, "")
	db, _ := repository.DB()
	if err := db.Model(&model.Media{}).Where("id = ?", item.ID).Update("object_etag", "").Error; err != nil {
		t.Fatal(err)
	}
	item.ObjectETag = ""
	race := &racingMediaHeadStore{versionedTaskInputStore: store, first: make(chan struct{}), release: make(chan struct{})}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	done := make(chan error, 1)
	go func() {
		access, err := mediaAccess(ctx, race, item)
		if err == nil {
			parsed, _ := url.Parse(access.URL)
			if parsed.Query().Get("versionId") != "B" {
				err = errors.New("losing reader used stale version A")
			}
		}
		done <- err
	}()
	select {
	case <-race.first:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	_, err := mediaAccess(ctx, race, item)
	close(race.release)
	if err != nil {
		t.Fatal(err)
	}
	if err = <-done; err != nil {
		t.Fatal(err)
	}
}

func TestPreparationBindsLegacyMediaAndRejectsChangedETag(t *testing.T) {
	for _, changed := range []bool{false, true} {
		t.Run(fmt.Sprint(changed), func(t *testing.T) {
			store, item := versionIdentityFixture(t, "")
			db, _ := repository.DB()
			if !changed {
				if err := db.Model(&model.Media{}).Where("id = ?", item.ID).Updates(map[string]any{"object_etag": "", "bytes": len(tinyPNG) + 1}).Error; err != nil {
					t.Fatal(err)
				}
			}
			task := model.ImageGenerationTask{ID: newID("task"), OwnerUID: item.OwnerUID, ClientRequestID: newID("request"), Status: model.ImageTaskPreparing, CreatedAt: now(), UpdatedAt: now()}
			input := model.ImageGenerationTaskInput{ID: newID("input"), TaskID: task.ID, SourceMediaID: item.ID, SourceObjectKey: item.ObjectKey, Purpose: "image", ContentType: "image/png", PreparationStatus: "pending", CleanupKeysJSON: "[]"}
			if err := db.Create(&task).Error; err != nil {
				t.Fatal(err)
			}
			if err := db.Create(&input).Error; err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = repository.DeleteImageGenerationTask(task.ID) })
			err := prepareImageGenerationTaskInput(context.Background(), store, &input)
			if changed {
				var permanent permanentImagePreparationError
				if !errors.As(err, &permanent) {
					t.Fatalf("ETag change must fail permanently: %v", err)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			saved, _, _ := repository.GetMedia(item.ID)
			if input.SourceVersionID != "B" || saved.ObjectVersionID != input.SourceVersionID || saved.ObjectETag != input.SourceETag {
				t.Fatal("media and task input use different identities")
			}
		})
	}
}
