package service

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/aliyun/alibabacloud-oss-go-sdk-v2/oss"
	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/repository"
)

type versionedTestObject struct {
	data        []byte
	contentType string
	etag        string
	versionID   string
}

type versionedTaskInputStore struct {
	objects        map[string][]versionedTestObject
	copyCalls      int
	headVersionErr error
}

func (store *versionedTaskInputStore) current(key string) (versionedTestObject, error) {
	versions := store.objects[key]
	if len(versions) == 0 {
		return versionedTestObject{}, os.ErrNotExist
	}
	return versions[len(versions)-1], nil
}
func (store *versionedTaskInputStore) version(key, versionID string) (versionedTestObject, error) {
	for _, object := range store.objects[key] {
		if object.versionID == versionID {
			return object, nil
		}
	}
	return versionedTestObject{}, os.ErrNotExist
}
func testObjectMetadata(object versionedTestObject) imageObjectMetadata {
	return imageObjectMetadata{ContentType: object.contentType, Bytes: int64(len(object.data)), ETag: object.etag, VersionID: object.versionID}
}
func (store *versionedTaskInputStore) Put(_ context.Context, key string, data []byte, contentType string) error {
	store.objects[key] = append(store.objects[key], versionedTestObject{data: append([]byte{}, data...), contentType: contentType, etag: "put", versionID: "put-version"})
	return nil
}
func (store *versionedTaskInputStore) Get(_ context.Context, key string) (io.ReadCloser, error) {
	object, err := store.current(key)
	if err != nil {
		return nil, err
	}
	return io.NopCloser(bytes.NewReader(object.data)), nil
}
func (store *versionedTaskInputStore) Delete(_ context.Context, key string) error {
	delete(store.objects, key)
	return nil
}
func (store *versionedTaskInputStore) SignedURL(context.Context, string, string) (string, time.Time, error) {
	return "", time.Time{}, nil
}
func (store *versionedTaskInputStore) PresignPut(context.Context, string, string) (string, time.Time, error) {
	return "", time.Time{}, errDirectUploadUnsupported
}
func (store *versionedTaskInputStore) Head(_ context.Context, key string) (imageObjectMetadata, error) {
	object, err := store.current(key)
	return testObjectMetadata(object), err
}
func (store *versionedTaskInputStore) ReadPrefix(_ context.Context, key string, limit int64) ([]byte, error) {
	object, err := store.current(key)
	if err != nil {
		return nil, err
	}
	if int64(len(object.data)) > limit {
		return object.data[:limit], nil
	}
	return append([]byte{}, object.data...), nil
}
func (*versionedTaskInputStore) EnsureVersioningEnabled(context.Context) error { return nil }
func (store *versionedTaskInputStore) HeadVersion(_ context.Context, key, versionID, etag string) (imageObjectMetadata, error) {
	if store.headVersionErr != nil {
		return imageObjectMetadata{}, store.headVersionErr
	}
	object, err := store.version(key, versionID)
	if err != nil {
		return imageObjectMetadata{}, err
	}
	if etag != "" && object.etag != etag {
		return imageObjectMetadata{}, &oss.ServiceError{StatusCode: 412, Code: "PreconditionFailed"}
	}
	return testObjectMetadata(object), nil
}
func (store *versionedTaskInputStore) ReadPrefixVersion(ctx context.Context, key, versionID, etag string, limit int64) ([]byte, error) {
	if _, err := store.HeadVersion(ctx, key, versionID, etag); err != nil {
		return nil, err
	}
	object, _ := store.version(key, versionID)
	if int64(len(object.data)) > limit {
		return object.data[:limit], nil
	}
	return append([]byte{}, object.data...), nil
}
func (store *versionedTaskInputStore) CopyVersion(ctx context.Context, source, sourceVersionID, sourceETag, target string) (imageObjectMetadata, error) {
	object, err := store.version(source, sourceVersionID)
	if err != nil {
		return imageObjectMetadata{}, err
	}
	if object.etag != sourceETag {
		return imageObjectMetadata{}, &oss.ServiceError{StatusCode: 412, Code: "PreconditionFailed"}
	}
	store.copyCalls++
	copied := versionedTestObject{data: append([]byte{}, object.data...), contentType: object.contentType, etag: "snapshot-etag", versionID: "snapshot-version"}
	store.objects[target] = append(store.objects[target], copied)
	return testObjectMetadata(copied), nil
}
func (store *versionedTaskInputStore) SignedURLVersion(_ context.Context, key, versionID string, ttl time.Duration) (string, time.Time, error) {
	if _, err := store.version(key, versionID); err != nil {
		return "", time.Time{}, err
	}
	return "https://signed.example/" + key + "?versionId=" + versionID, time.Now().Add(ttl), nil
}
func (store *versionedTaskInputStore) DeleteVersion(_ context.Context, key, versionID string) error {
	versions := store.objects[key]
	for index, object := range versions {
		if object.versionID == versionID {
			store.objects[key] = append(versions[:index], versions[index+1:]...)
			return nil
		}
	}
	return nil
}
func (store *versionedTaskInputStore) DeletePrefixVersions(_ context.Context, prefix string) error {
	for key := range store.objects {
		if strings.HasPrefix(key, prefix) {
			delete(store.objects, key)
		}
	}
	return nil
}

func TestImageTaskPreparationCopiesTheValidatedSourceVersion(t *testing.T) {
	database, err := repository.DB()
	if err != nil {
		t.Fatal(err)
	}
	taskID := newID("prepare-version")
	inputID := newID("prepare-input")
	store := &versionedTaskInputStore{objects: map[string][]versionedTestObject{
		"source": {
			{data: tinyPNG, contentType: "image/png", etag: "old-etag", versionID: "null"},
			{data: append(tinyPNG, []byte("new")...), contentType: "image/png", etag: "new-etag", versionID: "new-version"},
		},
	}}
	previousFactory := taskInputStoreFactory
	taskInputStoreFactory = func() (imageStore, error) { return store, nil }
	t.Cleanup(func() { taskInputStoreFactory = previousFactory })
	task := model.ImageGenerationTask{ID: taskID, OwnerUID: newID("owner"), ClientRequestID: newID("request"), Status: model.ImageTaskPreparing, ReferencesJSON: "[]", CreatedAt: now(), UpdatedAt: now()}
	input := model.ImageGenerationTaskInput{ID: inputID, TaskID: taskID, Position: 0, Purpose: "image", Name: "source.png", SourceMediaID: newID("media"), SourceObjectKey: "source", SourceVersionID: "null", SourceETag: "old-etag", ContentType: "image/png", Bytes: int64(len(tinyPNG)), PreparationStatus: "pending", CleanupKeysJSON: "[]", CreatedAt: now(), UpdatedAt: now()}
	if err := database.Create(&task).Error; err != nil {
		t.Fatal(err)
	}
	if err := database.Create(&input).Error; err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = repository.DeleteImageGenerationTask(taskID) })

	prepareImageGenerationTask(context.Background(), task)
	stored, found, err := repository.GetImageGenerationTask(taskID)
	if err != nil || !found || stored.Status != model.ImageTaskQueued {
		t.Fatalf("prepared task = %#v, found=%t, err=%v", stored, found, err)
	}
	inputs, err := repository.ListImageGenerationTaskInputs(taskID)
	if err != nil || len(inputs) != 1 || inputs[0].SnapshotVersionID != "snapshot-version" {
		t.Fatalf("prepared inputs = %#v, err=%v", inputs, err)
	}
	copied, err := store.version(inputs[0].SnapshotObjectKey, inputs[0].SnapshotVersionID)
	if err != nil || !bytes.Equal(copied.data, tinyPNG) {
		t.Fatalf("snapshot copied current source instead of validated version: %#v, %v", copied, err)
	}
}

func TestImageTaskPreparationRecoversCopyWhoseResultWasNotPersisted(t *testing.T) {
	database, err := repository.DB()
	if err != nil {
		t.Fatal(err)
	}
	taskID := newID("prepare-recovery")
	inputID := newID("prepare-recovery-input")
	target := imageTaskInputPrefix(taskID) + "inputs/recovered.png"
	started := time.Now().UTC().Add(-time.Minute)
	store := &versionedTaskInputStore{objects: map[string][]versionedTestObject{
		"source": {{data: tinyPNG, contentType: "image/png", etag: "source-etag", versionID: "source-version"}},
		target:   {{data: tinyPNG, contentType: "image/png", etag: "target-etag", versionID: "target-version"}},
	}}
	previousFactory := taskInputStoreFactory
	taskInputStoreFactory = func() (imageStore, error) { return store, nil }
	t.Cleanup(func() { taskInputStoreFactory = previousFactory })
	task := model.ImageGenerationTask{ID: taskID, OwnerUID: newID("owner"), ClientRequestID: newID("request"), Status: model.ImageTaskPreparing, ReferencesJSON: "[]", CreatedAt: now(), UpdatedAt: now()}
	input := model.ImageGenerationTaskInput{ID: inputID, TaskID: taskID, Position: 0, Purpose: "image", Name: "source.png", SourceMediaID: newID("media"), SourceObjectKey: "source", SourceVersionID: "source-version", SourceETag: "source-etag", SnapshotObjectKey: target, ContentType: "image/png", Bytes: int64(len(tinyPNG)), CopyStartedAt: &started, PreparationStatus: "copying", CleanupKeysJSON: "[]", CreatedAt: now(), UpdatedAt: now()}
	if err := database.Create(&task).Error; err != nil {
		t.Fatal(err)
	}
	if err := database.Create(&input).Error; err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = repository.DeleteImageGenerationTask(taskID) })

	prepareImageGenerationTask(context.Background(), task)
	stored, _, _ := repository.GetImageGenerationTask(taskID)
	if stored.Status != model.ImageTaskQueued || store.copyCalls != 0 {
		t.Fatalf("recovery task = %#v, copyCalls=%d", stored, store.copyCalls)
	}
}

func TestImageTaskPreparationFailsWhenValidatedSourceETagDoesNotMatch(t *testing.T) {
	database, err := repository.DB()
	if err != nil {
		t.Fatal(err)
	}
	taskID := newID("prepare-etag-mismatch")
	store := &versionedTaskInputStore{objects: map[string][]versionedTestObject{
		"source": {{data: tinyPNG, contentType: "image/png", etag: "actual-etag", versionID: "source-version"}},
	}}
	previousFactory := taskInputStoreFactory
	taskInputStoreFactory = func() (imageStore, error) { return store, nil }
	t.Cleanup(func() { taskInputStoreFactory = previousFactory })
	task := model.ImageGenerationTask{ID: taskID, OwnerUID: newID("owner"), ClientRequestID: newID("request"), Status: model.ImageTaskPreparing, ReferencesJSON: "[]", CreatedAt: now(), UpdatedAt: now()}
	input := model.ImageGenerationTaskInput{ID: newID("prepare-input"), TaskID: taskID, Position: 0, Purpose: "image", Name: "source.png", SourceMediaID: newID("media"), SourceObjectKey: "source", SourceVersionID: "source-version", SourceETag: "validated-etag", ContentType: "image/png", Bytes: int64(len(tinyPNG)), PreparationStatus: "pending", CleanupKeysJSON: "[]", CreatedAt: now(), UpdatedAt: now()}
	if err := database.Create(&task).Error; err != nil {
		t.Fatal(err)
	}
	if err := database.Create(&input).Error; err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = repository.DeleteImageGenerationTask(taskID) })

	prepareImageGenerationTask(context.Background(), task)
	stored, found, err := repository.GetImageGenerationTask(taskID)
	if err != nil || !found || stored.Status != model.ImageTaskFailed || store.copyCalls != 0 {
		t.Fatalf("mismatched source task = %#v, found=%t, copyCalls=%d, err=%v", stored, found, store.copyCalls, err)
	}
}

func TestImageTaskPreparationRetriesTransientVersionLookupFailure(t *testing.T) {
	database, err := repository.DB()
	if err != nil {
		t.Fatal(err)
	}
	taskID := newID("prepare-transient-head")
	store := &versionedTaskInputStore{objects: map[string][]versionedTestObject{}, headVersionErr: errors.New("temporary OSS timeout")}
	previousFactory := taskInputStoreFactory
	taskInputStoreFactory = func() (imageStore, error) { return store, nil }
	t.Cleanup(func() { taskInputStoreFactory = previousFactory })
	task := model.ImageGenerationTask{ID: taskID, OwnerUID: newID("owner"), ClientRequestID: newID("request"), Status: model.ImageTaskPreparing, ReferencesJSON: "[]", CreatedAt: now(), UpdatedAt: now()}
	input := model.ImageGenerationTaskInput{ID: newID("prepare-input"), TaskID: taskID, Position: 0, Purpose: "image", SourceMediaID: newID("media"), SourceObjectKey: "source", SourceVersionID: "source-version", SourceETag: "source-etag", ContentType: "image/png", Bytes: int64(len(tinyPNG)), PreparationStatus: "pending", CleanupKeysJSON: "[]", CreatedAt: now(), UpdatedAt: now()}
	if err := database.Create(&task).Error; err != nil {
		t.Fatal(err)
	}
	if err := database.Create(&input).Error; err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = repository.DeleteImageGenerationTask(taskID) })

	prepareImageGenerationTask(context.Background(), task)
	stored, found, err := repository.GetImageGenerationTask(taskID)
	if err != nil || !found || stored.Status != model.ImageTaskPreparing {
		t.Fatalf("transient source lookup task = %#v, found=%t, err=%v", stored, found, err)
	}
}

func TestImageTaskPreparationRetainsUnknownCopyKeyWhenAllocatingRetry(t *testing.T) {
	database, err := repository.DB()
	if err != nil {
		t.Fatal(err)
	}
	taskID := newID("prepare-copy-retry")
	oldTarget := imageTaskInputPrefix(taskID) + "inputs/old.png"
	started := time.Now().UTC().Add(-imageTaskCopySettleWindow - time.Second)
	store := &versionedTaskInputStore{objects: map[string][]versionedTestObject{
		"source": {{data: tinyPNG, contentType: "image/png", etag: "source-etag", versionID: "source-version"}},
	}}
	previousFactory := taskInputStoreFactory
	taskInputStoreFactory = func() (imageStore, error) { return store, nil }
	t.Cleanup(func() { taskInputStoreFactory = previousFactory })
	task := model.ImageGenerationTask{ID: taskID, OwnerUID: newID("owner"), ClientRequestID: newID("request"), Status: model.ImageTaskPreparing, ReferencesJSON: "[]", CreatedAt: now(), UpdatedAt: now()}
	input := model.ImageGenerationTaskInput{ID: newID("prepare-input"), TaskID: taskID, Position: 0, Purpose: "image", Name: "source.png", SourceMediaID: newID("media"), SourceObjectKey: "source", SourceVersionID: "source-version", SourceETag: "source-etag", SnapshotObjectKey: oldTarget, ContentType: "image/png", Bytes: int64(len(tinyPNG)), CopyStartedAt: &started, PreparationStatus: "copying", CleanupKeysJSON: "[]", CreatedAt: now(), UpdatedAt: now()}
	if err := database.Create(&task).Error; err != nil {
		t.Fatal(err)
	}
	if err := database.Create(&input).Error; err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = repository.DeleteImageGenerationTask(taskID) })

	prepareImageGenerationTask(context.Background(), task)
	inputs, err := repository.ListImageGenerationTaskInputs(taskID)
	if err != nil || len(inputs) != 1 {
		t.Fatalf("prepared inputs = %#v, err=%v", inputs, err)
	}
	cleanupKeys := imageTaskCleanupKeys(inputs[0].CleanupKeysJSON)
	if len(cleanupKeys) != 1 || cleanupKeys[0] != oldTarget || inputs[0].SnapshotObjectKey == oldTarget {
		t.Fatalf("retry input = %#v, cleanupKeys=%#v", inputs[0], cleanupKeys)
	}
}

func TestImageTaskWorkerSignsThePreparedSnapshotVersion(t *testing.T) {
	database, err := repository.DB()
	if err != nil {
		t.Fatal(err)
	}
	taskID := newID("worker-snapshot-url")
	key := imageTaskInputPrefix(taskID) + "inputs/source.png"
	store := &versionedTaskInputStore{objects: map[string][]versionedTestObject{
		key: {{data: tinyPNG, contentType: "image/png", etag: "snapshot-etag", versionID: "snapshot-version"}},
	}}
	previousFactory := taskInputStoreFactory
	taskInputStoreFactory = func() (imageStore, error) { return store, nil }
	t.Cleanup(func() { taskInputStoreFactory = previousFactory })
	input := model.ImageGenerationTaskInput{ID: newID("worker-input"), TaskID: taskID, Position: 0, Purpose: "image", Name: "source.png", SnapshotObjectKey: key, SnapshotVersionID: "snapshot-version", SnapshotETag: "snapshot-etag", ContentType: "image/png", Bytes: int64(len(tinyPNG)), PreparationStatus: "ready", CleanupKeysJSON: "[]", CreatedAt: now(), UpdatedAt: now()}
	if err := database.Create(&input).Error; err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = database.Delete(&model.ImageGenerationTaskInput{}, "id = ?", input.ID).Error })

	loaded, err := loadProviderImageTaskInputs(context.Background(), model.ImageGenerationTask{ID: taskID}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(loaded.References) != 1 || loaded.References[0].URL != "https://signed.example/"+key+"?versionId=snapshot-version" || len(loaded.References[0].Data) != 0 {
		t.Fatalf("loaded provider input = %#v", loaded)
	}
}

func (store *versionedTaskInputStore) GetVersion(ctx context.Context, key, version, etag string) (io.ReadCloser, error) {
	if _, err := store.HeadVersion(ctx, key, version, etag); err != nil {
		return nil, err
	}
	object, _ := store.version(key, version)
	return io.NopCloser(bytes.NewReader(object.data)), nil
}
func (store *versionedTaskInputStore) SignedMediaURL(ctx context.Context, key, version, process, disposition string) (string, time.Time, error) {
	address, expires, err := store.SignedURLVersion(ctx, key, version, time.Hour)
	return address + "&x-oss-process=" + url.QueryEscape(process) + "&response-content-disposition=" + url.QueryEscape(disposition), expires, err
}
