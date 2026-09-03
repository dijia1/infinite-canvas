package service

import (
	"context"
	"errors"
	"io"
	"path/filepath"
	"strings"

	"github.com/basketikun/infinite-canvas/ai"
	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/repository"
)

const maxImageTaskReferenceCount = 10

type imageTaskMediaLookup func(string) (model.Media, bool, error)
type imageTaskPublicLookup func(string) (model.PublicImage, bool, error)

func resolveImageTaskMediaReferences(ctx context.Context, user PortalUser, mediaIDs []string) ([]ai.ImageReference, error) {
	store, err := taskInputStoreFactory()
	if err != nil {
		return nil, err
	}
	return readImageTaskMediaReferences(ctx, user, mediaIDs, repository.GetMedia, repository.GetPublicImageByMediaID, store)
}

func readImageTaskMediaReferences(ctx context.Context, user PortalUser, mediaIDs []string, getMedia imageTaskMediaLookup, getPublic imageTaskPublicLookup, store imageStore) ([]ai.ImageReference, error) {
	if len(mediaIDs) < 1 || len(mediaIDs) > maxImageTaskReferenceCount {
		return nil, safeMessageError{message: "图像编辑需要 1–10 张参考图"}
	}
	references := make([]ai.ImageReference, 0, len(mediaIDs))
	totalBytes := 0
	for _, mediaID := range mediaIDs {
		id := strings.TrimSpace(mediaID)
		if id == "" || len(id) > 128 {
			return nil, safeMessageError{message: "参考图片无效"}
		}
		item, found, err := getMedia(id)
		if err != nil {
			return nil, err
		}
		if !found {
			return nil, safeMessageError{message: "参考图片不存在"}
		}
		_, isPublic, err := getPublic(item.ID)
		if err != nil {
			return nil, err
		}
		if !canAccessMedia(user, item) && !isPublic {
			return nil, safeMessageError{message: "无权使用该参考图片"}
		}
		reader, err := store.Get(ctx, item.ObjectKey)
		if err != nil {
			return nil, err
		}
		data, readErr := io.ReadAll(io.LimitReader(reader, maxMediaBytes+1))
		_ = reader.Close()
		if readErr != nil || len(data) == 0 || len(data) > maxMediaBytes {
			return nil, errors.New("读取参考图失败")
		}
		totalBytes += len(data)
		if totalBytes > maxMediaBytes {
			return nil, safeMessageError{message: "参考图总大小无效"}
		}
		contentType, extension, err := normalizeImage(data, item.ContentType)
		if err != nil {
			return nil, safeMessageError{message: "参考图片无效"}
		}
		name := filepath.Base(strings.TrimSpace(item.Filename))
		if name == "." || name == "" {
			name = "reference." + extension
		}
		references = append(references, ai.ImageReference{Name: name, ContentType: contentType, Data: data})
	}
	return references, nil
}
