package service

import (
	"context"
	"io"
	"path/filepath"
	"strings"

	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/repository"
)

func canAccessPublicMedia(user PortalUser, _ model.Media) bool {
	return strings.TrimSpace(user.UID) != ""
}

func SavePublicImage(ctx context.Context, user PortalUser, filename, contentType string, data []byte, title string) (model.PublicImage, MediaAccess, error) {
	access, err := saveImage(ctx, user, model.MediaSourceUpload, filename, contentType, data, true)
	if err != nil {
		return model.PublicImage{}, MediaAccess{}, err
	}
	item := model.PublicImage{
		ID:          newID("public-image"),
		MediaID:     access.MediaID,
		Title:       strings.TrimSpace(title),
		UploaderUID: user.UID,
		CreatedAt:   now(),
	}
	if item.Title == "" {
		item.Title = filepath.Base(filename)
	}
	saved, err := repository.SavePublicImage(item)
	if err != nil {
		_ = deleteMedia(ctx, access.MediaID)
		return model.PublicImage{}, MediaAccess{}, err
	}
	media, found, err := repository.GetMedia(access.MediaID)
	if err != nil {
		return model.PublicImage{}, MediaAccess{}, err
	}
	if !found {
		return model.PublicImage{}, MediaAccess{}, safeMessageError{message: "公共图片保存失败"}
	}
	saved.Media = media
	publicAccess, err := publicImageAccess(ctx, saved)
	if err != nil {
		return model.PublicImage{}, MediaAccess{}, err
	}
	return saved, publicAccess, nil
}

func ListPublicImages(q model.Query) (model.PublicImageList, error) {
	items, total, err := repository.ListPublicImages(q)
	if err != nil {
		return model.PublicImageList{}, err
	}
	return model.PublicImageList{Items: items, Total: int(total)}, nil
}

func PublicImageAccessURL(ctx context.Context, user PortalUser, id string) (MediaAccess, error) {
	if strings.TrimSpace(user.UID) == "" {
		return MediaAccess{}, safeMessageError{message: "未经过 Portal Gateway 身份验证"}
	}
	item, found, err := repository.GetPublicImage(id)
	if err != nil {
		return MediaAccess{}, err
	}
	if !found || !canAccessPublicMedia(user, item.Media) {
		return MediaAccess{}, safeMessageError{message: "公共图片不存在"}
	}
	return publicImageAccess(ctx, item)
}

func publicImageAccess(ctx context.Context, item model.PublicImage) (MediaAccess, error) {
	store, err := newImageStore()
	if err != nil {
		return MediaAccess{}, err
	}
	access, err := mediaAccess(ctx, store, item.Media)
	if err != nil {
		return MediaAccess{}, err
	}
	if _, local := store.(localImageStore); local {
		access.URL = "/api/v1/public-images/" + item.ID + "/content"
	}
	return access, nil
}

func OpenPublicImage(ctx context.Context, user PortalUser, id string) (io.ReadCloser, string, error) {
	if strings.TrimSpace(user.UID) == "" {
		return nil, "", safeMessageError{message: "未经过 Portal Gateway 身份验证"}
	}
	item, found, err := repository.GetPublicImage(id)
	if err != nil {
		return nil, "", err
	}
	if !found || !canAccessPublicMedia(user, item.Media) {
		return nil, "", safeMessageError{message: "公共图片不存在"}
	}
	store, err := newImageStore()
	if err != nil {
		return nil, "", err
	}
	local, ok := store.(localImageStore)
	if !ok {
		return nil, "", safeMessageError{message: "当前存储不支持本地文件访问"}
	}
	file, err := local.Open(item.Media.ObjectKey)
	return file, item.Media.ContentType, err
}

func DeletePublicImage(ctx context.Context, id string) error {
	item, found, err := repository.GetPublicImage(id)
	if err != nil {
		return err
	}
	if !found {
		return safeMessageError{message: "公共图片不存在"}
	}
	if err := repository.DeletePublicImage(id); err != nil {
		return err
	}
	return deleteMedia(ctx, item.MediaID)
}

func deleteMedia(ctx context.Context, id string) error {
	item, found, err := repository.GetMedia(id)
	if err != nil || !found {
		return err
	}
	store, err := newImageStore()
	if err != nil {
		return err
	}
	if err := store.Delete(ctx, item.ObjectKey); err != nil {
		return err
	}
	return repository.DeleteMedia(id)
}
