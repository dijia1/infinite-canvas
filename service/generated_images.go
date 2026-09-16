package service

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"path/filepath"
	"strings"
	"time"

	"github.com/basketikun/infinite-canvas/ai"
	"github.com/basketikun/infinite-canvas/model"
)

var generatedImageClient = &http.Client{Timeout: 30 * time.Second}

type preparedImageTaskResults struct {
	media []model.Media
	keys  []string
	store imageStore
}

// prepareImageTaskResultMedia writes immutable result objects but deliberately
// leaves database publication to CompleteImageGenerationTask, which verifies
// the worker lease and commits every media row with the task terminal state.
func prepareImageTaskResultMedia(ctx context.Context, images []ai.ImageResult) (preparedImageTaskResults, error) {
	user, ok := PortalUserFromContext(ctx)
	if !ok || strings.TrimSpace(user.UID) == "" {
		return preparedImageTaskResults{}, errors.New("未经过 Portal Gateway 身份验证")
	}
	store, err := newImageStore()
	if err != nil {
		return preparedImageTaskResults{}, err
	}
	prepared := preparedImageTaskResults{media: make([]model.Media, 0, len(images)), keys: make([]string, 0, len(images)), store: store}
	for _, image := range images {
		data, filename, contentType, err := generatedImagePayload(ctx, image)
		if err != nil {
			prepared.cleanup(ctx)
			return preparedImageTaskResults{}, err
		}
		if len(data) == 0 || len(data) > maxMediaBytes {
			prepared.cleanup(ctx)
			return preparedImageTaskResults{}, errors.New("图片大小无效")
		}
		contentType, extension, err := normalizeImage(data, contentType)
		if err != nil {
			prepared.cleanup(ctx)
			return preparedImageTaskResults{}, err
		}
		createdAt := time.Now().UTC()
		key := privateImageObjectKey(user.UID, model.MediaSourceGenerated, extension, createdAt)
		prepared.keys = append(prepared.keys, key)
		if err := store.Put(ctx, key, data, contentType); err != nil {
			prepared.cleanup(ctx)
			return preparedImageTaskResults{}, fmt.Errorf("保存图片失败: %w", err)
		}
		metadata, err := store.Head(ctx, key)
		if err != nil {
			prepared.cleanup(ctx)
			return preparedImageTaskResults{}, fmt.Errorf("读取已保存图片版本失败: %w", err)
		}
		width, height := imageDimensions(data)
		base := filepath.Base(filename)
		prepared.media = append(prepared.media, model.Media{
			ID: newID("media"), OwnerUID: user.UID, Source: model.MediaSourceGenerated,
			ObjectKey: key, ObjectVersionID: metadata.VersionID, ObjectETag: metadata.ETag,
			ContentType: contentType, Bytes: int64(len(data)), Width: width, Height: height,
			Filename: base, Title: strings.TrimSuffix(base, filepath.Ext(base)), CreatedAt: createdAt.Format(time.RFC3339),
		})
	}
	if len(prepared.media) == 0 {
		return preparedImageTaskResults{}, errors.New("生成图片内容为空")
	}
	return prepared, nil
}

func (prepared preparedImageTaskResults) cleanup(ctx context.Context) {
	if prepared.store == nil {
		return
	}
	cleanupContext, cancel := context.WithTimeout(context.WithoutCancel(ctx), 15*time.Second)
	defer cancel()
	for _, key := range prepared.keys {
		if err := prepared.store.Delete(cleanupContext, key); err != nil && !isMissingImageObjectError(err) {
			// A later retention pass cannot find an unpublished object, so retain
			// enough context for an operator to remove it manually.
			log.Printf("cleanup unpublished image task object %s failed: %v", key, err)
		}
	}
}

func generatedImagePayload(ctx context.Context, image ai.ImageResult) ([]byte, string, string, error) {
	data, contentType := image.Data, image.ContentType
	filename := "generated.png"
	if len(data) > 0 {
		return data, filename, contentType, nil
	}
	if strings.TrimSpace(image.URL) == "" {
		return nil, "", "", errors.New("生成图片内容为空")
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, image.URL, nil)
	if err != nil {
		return nil, "", "", fmt.Errorf("下载生成图片失败: %w", err)
	}
	response, err := generatedImageClient.Do(request)
	if err != nil {
		return nil, "", "", fmt.Errorf("下载生成图片失败: %w", err)
	}
	defer response.Body.Close()
	data, err = io.ReadAll(io.LimitReader(response.Body, maxMediaBytes+1))
	if err != nil || response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices || len(data) > maxMediaBytes {
		return nil, "", "", errors.New("下载生成图片失败")
	}
	filename = filepath.Base(strings.Split(image.URL, "?")[0])
	return data, filename, response.Header.Get("Content-Type"), nil
}
