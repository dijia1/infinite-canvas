package service

import (
	"context"
	"io"
	"path/filepath"
	"strings"
	"unicode/utf8"

	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/repository"
)

func normalizePublicTitle(value string) (string, error) {
	value = strings.TrimSpace(value)
	if length := utf8.RuneCountInString(value); length < 1 || length > 64 {
		return "", safeMessageError{message: "名称长度应为 1-64 个字符"}
	}
	return value, nil
}

func CreatePublicFolder(title, parentID string) (model.PublicFolder, error) {
	name, err := normalizePublicTitle(title)
	if err != nil {
		return model.PublicFolder{}, err
	}
	parentID = strings.TrimSpace(parentID)
	if parentID != "" {
		_, found, err := repository.GetPublicFolder(parentID)
		if err != nil {
			return model.PublicFolder{}, err
		}
		if !found {
			return model.PublicFolder{}, safeMessageError{message: "父文件夹不存在"}
		}
	}
	item := model.PublicFolder{ID: newID("public-folder"), ParentID: parentID, Title: name, CreatedAt: now()}
	saved, err := repository.SavePublicFolder(item)
	if err != nil && strings.Contains(strings.ToLower(err.Error()), "unique") {
		return model.PublicFolder{}, safeMessageError{message: "同级文件夹名称已存在"}
	}
	return saved, err
}

func ListPublicFolders() (model.PublicFolderList, error) {
	items, err := repository.ListPublicFolders()
	if err != nil {
		return model.PublicFolderList{}, err
	}
	return model.PublicFolderList{Items: items, Total: len(items)}, nil
}

func RenamePublicFolder(id, title string) (model.PublicFolder, error) {
	name, err := normalizePublicTitle(title)
	if err != nil {
		return model.PublicFolder{}, err
	}
	_, found, err := repository.GetPublicFolder(id)
	if err != nil {
		return model.PublicFolder{}, err
	}
	if !found {
		return model.PublicFolder{}, safeMessageError{message: "文件夹不存在"}
	}
	updated, found, err := repository.UpdatePublicFolderTitle(id, name)
	if err != nil {
		if strings.Contains(strings.ToLower(err.Error()), "unique") {
			return model.PublicFolder{}, safeMessageError{message: "同级文件夹名称已存在"}
		}
		return model.PublicFolder{}, err
	}
	if !found {
		return model.PublicFolder{}, safeMessageError{message: "文件夹不存在"}
	}
	return updated, nil
}

func DeletePublicFolder(id string) error {
	_, found, err := repository.GetPublicFolder(id)
	if err != nil {
		return err
	}
	if !found {
		return safeMessageError{message: "文件夹不存在"}
	}
	hasContents, err := repository.PublicFolderHasContents(id)
	if err != nil {
		return err
	}
	if hasContents {
		return safeMessageError{message: "文件夹包含图片或子文件夹，请先整理内容"}
	}
	deleted, err := repository.DeletePublicFolder(id)
	if err != nil {
		return err
	}
	if !deleted {
		return safeMessageError{message: "文件夹不存在"}
	}
	return nil
}

func validatePublicFolderID(folderID string) (string, error) {
	folderID = strings.TrimSpace(folderID)
	if folderID == "" {
		return "", nil
	}
	_, found, err := repository.GetPublicFolder(folderID)
	if err != nil {
		return "", err
	}
	if !found {
		return "", safeMessageError{message: "文件夹不存在"}
	}
	return folderID, nil
}

func canAccessPublicMedia(user PortalUser, _ model.Media) bool {
	return strings.TrimSpace(user.UID) != ""
}

func SavePublicImage(ctx context.Context, user PortalUser, filename, contentType string, data []byte, title, folderID string) (model.PublicImage, MediaAccess, error) {
	title = strings.TrimSpace(title)
	if title == "" {
		title = filepath.Base(filename)
	}
	var err error
	title, err = normalizePublicTitle(title)
	if err != nil {
		return model.PublicImage{}, MediaAccess{}, err
	}
	folderID, err = validatePublicFolderID(folderID)
	if err != nil {
		return model.PublicImage{}, MediaAccess{}, err
	}
	access, err := saveImage(ctx, user, model.MediaSourceUpload, filename, contentType, data, true)
	if err != nil {
		return model.PublicImage{}, MediaAccess{}, err
	}
	item := model.PublicImage{
		ID:          newID("public-image"),
		MediaID:     access.MediaID,
		FolderID:    folderID,
		Title:       title,
		UploaderUID: user.UID,
		CreatedAt:   now(),
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

func UpdatePublicImage(id string, title *string, folderID *string) (model.PublicImage, error) {
	if title == nil && folderID == nil {
		return model.PublicImage{}, safeMessageError{message: "请提供要更新的名称或文件夹"}
	}
	if title != nil {
		name, err := normalizePublicTitle(*title)
		if err != nil {
			return model.PublicImage{}, err
		}
		*title = name
	}
	if folderID != nil {
		validatedFolderID, err := validatePublicFolderID(*folderID)
		if err != nil {
			return model.PublicImage{}, err
		}
		*folderID = validatedFolderID
	}
	item, found, err := repository.UpdatePublicImage(id, title, folderID)
	if err != nil {
		return model.PublicImage{}, err
	}
	if !found {
		return model.PublicImage{}, safeMessageError{message: "公共图片不存在"}
	}
	return item, nil
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
		return nil
	}
	store, err := newImageStore()
	if err != nil {
		return err
	}
	if err := deleteImageObject(ctx, store, item.Media.ObjectKey); err != nil {
		return err
	}
	return repository.DeletePublicImageAndMedia(item.ID, item.MediaID)
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
	if err := deleteImageObject(ctx, store, item.ObjectKey); err != nil {
		return err
	}
	return repository.DeleteMedia(id)
}
