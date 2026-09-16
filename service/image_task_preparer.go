package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/aliyun/alibabacloud-oss-go-sdk-v2/oss"
	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/repository"
	"github.com/google/uuid"
)

const imageTaskCopySettleWindow = 30 * time.Second

type permanentImagePreparationError struct{ message string }

func (err permanentImagePreparationError) Error() string { return err.message }

func runImageTaskPreparer(ctx context.Context, concurrency int) {
	if concurrency < 1 {
		concurrency = 1
	}
	semaphore := make(chan struct{}, concurrency)
	var active sync.Map
	var children sync.WaitGroup
	defer children.Wait()
	for {
		items, err := repository.ListPreparingImageGenerationTasks()
		if err != nil {
			log.Printf("image task preparer scan failed: %v", err)
		} else {
			for _, item := range items {
				if _, loaded := active.LoadOrStore(item.ID, struct{}{}); loaded {
					continue
				}
				select {
				case semaphore <- struct{}{}:
					children.Add(1)
					go func(task model.ImageGenerationTask) {
						defer children.Done()
						defer func() { <-semaphore; active.Delete(task.ID) }()
						prepareImageGenerationTask(ctx, task)
					}(item)
				case <-ctx.Done():
					active.Delete(item.ID)
					return
				}
			}
		}
		if !waitForImageTask(ctx, time.Second) {
			return
		}
	}
}

func prepareImageGenerationTask(ctx context.Context, task model.ImageGenerationTask) {
	store, err := taskInputStoreFactory()
	if err != nil {
		log.Printf("image task %s prepare store failed: %v", task.ID, err)
		return
	}
	versioned, ok := store.(versionedImageStore)
	if !ok {
		failImageTaskPreparation(task.ID, errors.New("当前存储不支持版本化图片快照"))
		return
	}
	if err := versioned.EnsureVersioningEnabled(ctx); err != nil {
		if errors.Is(err, errOSSVersioningRequired) {
			failImageTaskPreparation(task.ID, permanentImagePreparationError{message: err.Error()})
			return
		}
		log.Printf("image task %s prepare versioning check failed: %v", task.ID, err)
		return
	}
	inputs, err := repository.ListImageGenerationTaskInputs(task.ID)
	if err != nil {
		log.Printf("image task %s prepare inputs failed: %v", task.ID, err)
		return
	}
	if len(inputs) == 0 {
		failImageTaskPreparation(task.ID, errors.New("图片任务输入不存在"))
		return
	}
	for index := range inputs {
		if err := prepareImageGenerationTaskInput(ctx, versioned, &inputs[index]); err != nil {
			var permanent permanentImagePreparationError
			if errors.As(err, &permanent) {
				failImageTaskPreparation(task.ID, err)
			} else if ctx.Err() == nil {
				log.Printf("image task %s input %d prepare deferred: %v", task.ID, inputs[index].Position, err)
			}
			return
		}
	}
	legacy := make([]ImageTaskInput, 0, len(inputs))
	for _, input := range inputs {
		legacy = append(legacy, ImageTaskInput{ObjectKey: input.SnapshotObjectKey, VersionID: input.SnapshotVersionID, Name: input.Name, ContentType: input.ContentType, Purpose: input.Purpose})
	}
	encoded, err := json.Marshal(legacy)
	if err != nil {
		failImageTaskPreparation(task.ID, err)
		return
	}
	if err := repository.QueuePreparedImageGenerationTask(task.ID, string(encoded), now()); err != nil && ctx.Err() == nil {
		log.Printf("image task %s queue prepared task failed: %v", task.ID, err)
	}
}

func prepareImageGenerationTaskInput(ctx context.Context, store versionedImageStore, input *model.ImageGenerationTaskInput) error {
	if input.PreparationStatus == "ready" {
		metadata, err := store.HeadVersion(ctx, input.SnapshotObjectKey, input.SnapshotVersionID, input.SnapshotETag)
		if err == nil {
			return markPreparedSnapshotReady(input, metadata)
		}
		if imageObjectPreconditionFailed(err) {
			return permanentImagePreparationError{message: "任务图片快照校验失败"}
		}
		if !imageObjectMissing(err) {
			return err
		}
	}
	if input.SourceVersionID == "" || input.SourceETag == "" {
		metadata, err := store.Head(ctx, input.SourceObjectKey)
		if err != nil {
			if imageObjectMissing(err) || imageObjectPreconditionFailed(err) {
				return permanentImagePreparationError{message: "参考图片文件不存在或不可访问"}
			}
			return err
		}
		if metadata.VersionID == "" || metadata.ETag == "" || metadata.Bytes <= 0 || metadata.Bytes > maxMediaBytes {
			return permanentImagePreparationError{message: "参考图片版本信息无效"}
		}
		updates := map[string]any{"source_version_id": metadata.VersionID, "source_etag": metadata.ETag, "updated_at": now()}
		if err := repository.UpdatePreparingImageGenerationTaskInput(input.TaskID, input.ID, updates); err != nil {
			return err
		}
		input.SourceVersionID, input.SourceETag = metadata.VersionID, metadata.ETag
	}
	sourceMetadata, err := store.HeadVersion(ctx, input.SourceObjectKey, input.SourceVersionID, input.SourceETag)
	if err != nil {
		if imageObjectMissing(err) || imageObjectPreconditionFailed(err) {
			return permanentImagePreparationError{message: "参考图片版本校验失败"}
		}
		return err
	}
	if sourceMetadata.VersionID == "" || sourceMetadata.ETag == "" || sourceMetadata.Bytes <= 0 || sourceMetadata.Bytes > maxMediaBytes || (input.Bytes > 0 && sourceMetadata.Bytes != input.Bytes) {
		return permanentImagePreparationError{message: "参考图片版本信息无效"}
	}
	prefix, err := store.ReadPrefixVersion(ctx, input.SourceObjectKey, input.SourceVersionID, input.SourceETag, 512)
	if err != nil {
		if imageObjectMissing(err) || imageObjectPreconditionFailed(err) {
			return permanentImagePreparationError{message: "参考图片版本校验失败"}
		}
		return err
	}
	contentType, _, err := normalizeImage(prefix, sourceMetadata.ContentType)
	if err != nil {
		return permanentImagePreparationError{message: "参考图片格式无效"}
	}
	if input.ContentType != "" && !strings.EqualFold(strings.TrimSpace(input.ContentType), contentType) {
		return permanentImagePreparationError{message: "参考图片类型与已校验媒体不一致"}
	}
	if input.Purpose == "mask" && contentType != "image/png" {
		return permanentImagePreparationError{message: "遮罩必须为 PNG 图片"}
	}
	if input.ContentType == "" || input.Bytes == 0 {
		if err := repository.UpdatePreparingImageGenerationTaskInput(input.TaskID, input.ID, map[string]any{"content_type": contentType, "bytes": sourceMetadata.Bytes, "updated_at": now()}); err != nil {
			return err
		}
		input.ContentType, input.Bytes = contentType, sourceMetadata.Bytes
	}
	if input.SnapshotObjectKey != "" {
		metadata, err := headPreparedSnapshot(ctx, store, *input)
		if err == nil {
			return markPreparedSnapshotReady(input, metadata)
		}
		if !imageObjectMissing(err) {
			return err
		}
		if input.CopyStartedAt != nil && time.Since(input.CopyStartedAt.UTC()) < imageTaskCopySettleWindow {
			return errors.New("等待 OSS Copy 结果收敛")
		}
		cleanupKeys := imageTaskCleanupKeys(input.CleanupKeysJSON)
		cleanupKeys = append(cleanupKeys, input.SnapshotObjectKey)
		encoded, _ := json.Marshal(cleanupKeys)
		input.CleanupKeysJSON = string(encoded)
		input.SnapshotObjectKey, input.SnapshotVersionID, input.SnapshotETag = "", "", ""
	}
	if input.SnapshotObjectKey == "" {
		extension := imageTaskInputExtension(input.ContentType)
		input.SnapshotObjectKey = imageTaskInputPrefix(input.TaskID) + "inputs/" + fmt.Sprintf("%03d-%s.%s", input.Position, uuid.NewString(), extension)
		started := time.Now().UTC()
		input.CopyStartedAt = &started
		if err := repository.UpdatePreparingImageGenerationTaskInput(input.TaskID, input.ID, map[string]any{
			"snapshot_object_key": input.SnapshotObjectKey, "snapshot_version_id": "", "snapshot_etag": "",
			"copy_started_at": started, "preparation_status": "copying", "cleanup_keys_json": input.CleanupKeysJSON, "updated_at": now(),
		}); err != nil {
			return err
		}
	}
	metadata, err := store.CopyVersion(ctx, input.SourceObjectKey, input.SourceVersionID, input.SourceETag, input.SnapshotObjectKey)
	if err != nil {
		if imageObjectMissing(err) || imageObjectPreconditionFailed(err) {
			return permanentImagePreparationError{message: "参考图片版本校验失败"}
		}
		return err
	}
	return markPreparedSnapshotReady(input, metadata)
}

func headPreparedSnapshot(ctx context.Context, store versionedImageStore, input model.ImageGenerationTaskInput) (imageObjectMetadata, error) {
	if input.SnapshotVersionID != "" {
		return store.HeadVersion(ctx, input.SnapshotObjectKey, input.SnapshotVersionID, input.SnapshotETag)
	}
	return store.Head(ctx, input.SnapshotObjectKey)
}

func markPreparedSnapshotReady(input *model.ImageGenerationTaskInput, metadata imageObjectMetadata) error {
	if metadata.VersionID == "" || metadata.ETag == "" || metadata.Bytes != input.Bytes {
		return permanentImagePreparationError{message: "任务图片快照校验失败"}
	}
	if err := repository.UpdatePreparingImageGenerationTaskInput(input.TaskID, input.ID, map[string]any{
		"snapshot_version_id": metadata.VersionID, "snapshot_etag": metadata.ETag, "preparation_status": "ready", "updated_at": now(),
	}); err != nil {
		return err
	}
	input.SnapshotVersionID, input.SnapshotETag, input.PreparationStatus = metadata.VersionID, metadata.ETag, "ready"
	return nil
}

func failImageTaskPreparation(taskID string, err error) {
	message := "参考图片准备失败"
	var safe safeMessageError
	var permanent permanentImagePreparationError
	if errors.As(err, &safe) {
		message = safe.Error()
	} else if errors.As(err, &permanent) {
		message = permanent.Error()
	}
	if updateErr := repository.FailPreparingImageGenerationTask(taskID, message, now()); updateErr != nil {
		log.Printf("image task %s mark preparation failed: %v", taskID, updateErr)
		return
	}
	if cleanupErr := cleanupImageTaskSnapshotPrefix(context.Background(), taskID); cleanupErr != nil {
		log.Printf("image task %s failed preparation cleanup deferred: %v", taskID, cleanupErr)
	}
}

func imageTaskCleanupKeys(encoded string) []string {
	var keys []string
	_ = json.Unmarshal([]byte(encoded), &keys)
	return keys
}

func imageTaskInputExtension(contentType string) string {
	extensions, _ := mime.ExtensionsByType(contentType)
	if len(extensions) > 0 {
		return strings.TrimPrefix(extensions[0], ".")
	}
	return "png"
}

func imageObjectMissing(err error) bool {
	if errors.Is(err, os.ErrNotExist) {
		return true
	}
	var serviceError *oss.ServiceError
	return errors.As(err, &serviceError) && (serviceError.Code == "NoSuchKey" || serviceError.StatusCode == http.StatusNotFound)
}

func imageObjectPreconditionFailed(err error) bool {
	var serviceError *oss.ServiceError
	return errors.As(err, &serviceError) && serviceError.StatusCode == http.StatusPreconditionFailed
}

func cleanupImageTaskSnapshotPrefix(ctx context.Context, taskID string) error {
	store, err := taskInputStoreFactory()
	if err != nil {
		return err
	}
	versioned, ok := store.(versionedImageStore)
	if !ok {
		return errors.New("当前存储不支持版本化图片快照")
	}
	return versioned.DeletePrefixVersions(ctx, imageTaskInputPrefix(filepath.Base(taskID)))
}
