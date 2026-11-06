package service

import (
	"context"
	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/repository"
	"strings"
)

const maxImageTaskReferenceCount = 10

func resolveImageTaskMediaSources(ctx context.Context, user PortalUser, mediaIDs []string) ([]model.Media, error) {
	if len(mediaIDs) < 1 || len(mediaIDs) > maxImageTaskReferenceCount {
		return nil, safeMessageError{message: "图像编辑需要 1–10 张参考图"}
	}
	items := make([]model.Media, 0, len(mediaIDs))
	for _, mediaID := range mediaIDs {
		item, err := resolveImageTaskMediaSource(ctx, user, mediaID)
		if err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, nil
}

func resolveImageTaskMediaSource(ctx context.Context, user PortalUser, mediaID string) (model.Media, error) {
	id := strings.TrimSpace(mediaID)
	if id == "" || len(id) > 128 {
		return model.Media{}, safeMessageError{message: "参考图片无效"}
	}
	item, found, err := repository.GetMedia(id)
	if err != nil {
		return model.Media{}, err
	}
	if !found {
		return model.Media{}, safeMessageError{message: "参考图片不存在"}
	}
	_, isPublic, err := repository.GetPublicImageByMediaID(item.ID)
	if err != nil {
		return model.Media{}, err
	}
	if !isPublic {
		allowed, err := canAccessMedia(ctx, user, item)
		if err != nil {
			return model.Media{}, err
		}
		if !allowed {
			return model.Media{}, safeMessageError{message: "无权使用该参考图片"}
		}
	}
	if item.CleanupStatus != model.MediaCleanupActive || strings.TrimSpace(item.ObjectKey) == "" {
		return model.Media{}, safeMessageError{message: "参考图片不可用"}
	}
	return item, nil
}
