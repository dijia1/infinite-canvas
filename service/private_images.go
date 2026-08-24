package service

import (
	"context"
	"path/filepath"
	"strings"

	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/repository"
)

func privateImageTitle(item model.Media) string {
	if title := strings.TrimSpace(item.Title); title != "" {
		return title
	}
	name := strings.TrimSuffix(filepath.Base(item.Filename), filepath.Ext(item.Filename))
	if strings.TrimSpace(name) != "" {
		return name
	}
	return "图片"
}

func ListPrivateImages(_ context.Context, user PortalUser) (model.PrivateImageList, error) {
	if strings.TrimSpace(user.UID) == "" {
		return model.PrivateImageList{}, safeMessageError{message: "未经过 Portal Gateway 身份验证"}
	}
	items, err := repository.ListPrivateMedia(user.UID)
	if err != nil {
		return model.PrivateImageList{}, err
	}
	for index := range items {
		items[index].Title = privateImageTitle(items[index])
	}
	return model.PrivateImageList{Items: items, Total: len(items)}, nil
}

func UpdatePrivateImage(_ context.Context, user PortalUser, id string, title *string, folderID *string) (model.Media, error) {
	if title == nil && folderID == nil {
		return model.Media{}, safeMessageError{message: "请提供要更新的名称或文件夹"}
	}
	item, found, err := repository.GetMedia(id)
	if err != nil {
		return model.Media{}, err
	}
	if !found || item.OwnerUID != user.UID {
		return model.Media{}, safeMessageError{message: "图片不存在"}
	}
	if _, public, err := repository.GetPublicImageByMediaID(id); err != nil {
		return model.Media{}, err
	} else if public {
		return model.Media{}, safeMessageError{message: "公共图片不能在我的素材中修改"}
	}
	if title != nil {
		value, err := normalizePublicTitle(*title)
		if err != nil {
			return model.Media{}, err
		}
		*title = value
	}
	if folderID != nil {
		value := strings.TrimSpace(*folderID)
		if value != "" {
			if _, exists, err := repository.GetPrivateFolder(user.UID, value); err != nil {
				return model.Media{}, err
			} else if !exists {
				return model.Media{}, safeMessageError{message: "文件夹不存在"}
			}
		}
		*folderID = value
	}
	updated, found, err := repository.UpdatePrivateMedia(id, user.UID, title, folderID)
	if err != nil {
		return model.Media{}, err
	}
	if !found {
		return model.Media{}, safeMessageError{message: "图片不存在"}
	}
	updated.Title = privateImageTitle(updated)
	return updated, nil
}

func ListPrivateFolders(_ context.Context, user PortalUser) (model.PrivateFolderList, error) {
	if strings.TrimSpace(user.UID) == "" {
		return model.PrivateFolderList{}, safeMessageError{message: "未经过 Portal Gateway 身份验证"}
	}
	items, err := repository.ListPrivateFolders(user.UID)
	if err != nil {
		return model.PrivateFolderList{}, err
	}
	return model.PrivateFolderList{Items: items, Total: len(items)}, nil
}

func CreatePrivateFolder(_ context.Context, user PortalUser, title, parentID string) (model.PrivateFolder, error) {
	name, err := normalizePublicTitle(title)
	if err != nil {
		return model.PrivateFolder{}, err
	}
	parentID = strings.TrimSpace(parentID)
	if parentID != "" {
		if _, found, err := repository.GetPrivateFolder(user.UID, parentID); err != nil {
			return model.PrivateFolder{}, err
		} else if !found {
			return model.PrivateFolder{}, safeMessageError{message: "父文件夹不存在"}
		}
	}
	item := model.PrivateFolder{ID: newID("private-folder"), OwnerUID: user.UID, ParentID: parentID, Title: name, CreatedAt: now()}
	saved, err := repository.SavePrivateFolder(item)
	if err != nil && strings.Contains(strings.ToLower(err.Error()), "unique") {
		return model.PrivateFolder{}, safeMessageError{message: "同级文件夹名称已存在"}
	}
	return saved, err
}

func RenamePrivateFolder(_ context.Context, user PortalUser, id, title string) (model.PrivateFolder, error) {
	name, err := normalizePublicTitle(title)
	if err != nil {
		return model.PrivateFolder{}, err
	}
	if _, found, err := repository.GetPrivateFolder(user.UID, id); err != nil {
		return model.PrivateFolder{}, err
	} else if !found {
		return model.PrivateFolder{}, safeMessageError{message: "文件夹不存在"}
	}
	updated, found, err := repository.UpdatePrivateFolderTitle(user.UID, id, name)
	if err != nil {
		if strings.Contains(strings.ToLower(err.Error()), "unique") {
			return model.PrivateFolder{}, safeMessageError{message: "同级文件夹名称已存在"}
		}
		return model.PrivateFolder{}, err
	}
	if !found {
		return model.PrivateFolder{}, safeMessageError{message: "文件夹不存在"}
	}
	return updated, nil
}

func DeletePrivateFolder(_ context.Context, user PortalUser, id string) error {
	if _, found, err := repository.GetPrivateFolder(user.UID, id); err != nil {
		return err
	} else if !found {
		return safeMessageError{message: "文件夹不存在"}
	}
	hasContents, err := repository.PrivateFolderHasContents(user.UID, id)
	if err != nil {
		return err
	}
	if hasContents {
		return safeMessageError{message: "文件夹包含图片或子文件夹，请先整理内容"}
	}
	deleted, err := repository.DeletePrivateFolder(user.UID, id)
	if err != nil {
		return err
	}
	if !deleted {
		return safeMessageError{message: "文件夹不存在"}
	}
	return nil
}
