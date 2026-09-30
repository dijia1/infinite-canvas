package service

import (
	"context"
	"errors"
	"path/filepath"
	"strings"
	"time"

	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/repository"
	"github.com/google/uuid"
)

type PublicImageImportAccess struct {
	MediaAccess
	SourceMediaID string `json:"sourceMediaId"`
}

func ImportPublicImage(ctx context.Context, user PortalUser, publicID, requestID string) (PublicImageImportAccess, error) {
	store, err := newImageStore()
	if err != nil {
		return PublicImageImportAccess{}, err
	}
	item, err := importPublicImage(ctx, store, user, publicID, requestID)
	if err != nil {
		return PublicImageImportAccess{}, err
	}
	access, err := mediaAccess(ctx, store, item)
	if err != nil {
		return PublicImageImportAccess{}, err
	}
	request, _ := uuid.Parse(requestID)
	id := "public-import-" + uuid.NewSHA1(uuid.NameSpaceURL, []byte(user.UID+":"+request.String())).String()
	intent, _, err := repository.GetMediaUploadIntentForOwner(id, user.UID)
	return PublicImageImportAccess{MediaAccess: access, SourceMediaID: intent.SourceMediaID}, err
}

func importPublicImage(ctx context.Context, store imageStore, user PortalUser, publicID, requestID string) (model.Media, error) {
	if strings.TrimSpace(user.UID) == "" {
		return model.Media{}, safeMessageError{message: "未经过 Portal Gateway 身份验证"}
	}
	request, err := uuid.Parse(requestID)
	if err != nil {
		return model.Media{}, safeMessageError{message: "导入请求 ID 无效"}
	}
	// Scope retries to the authenticated owner; the client never controls a key.
	id := "public-import-" + uuid.NewSHA1(uuid.NameSpaceURL, []byte(user.UID+":"+request.String())).String()
	intent, found, err := repository.GetMediaUploadIntentForOwner(id, user.UID)
	if err != nil {
		return model.Media{}, err
	}
	if found && intent.SourcePublicImageID != publicID {
		return model.Media{}, safeMessageError{message: repository.ErrPublicImageImportMismatch.Error()}
	}
	if found && intent.CompletedMediaID != "" {
		return completedPublicImageImport(user, intent)
	}
	versioned, ok := store.(versionedImageStore)
	if !ok {
		return model.Media{}, errors.New("图片存储不支持版本复制")
	}
	if !found {
		public, found, err := repository.GetPublicImage(publicID)
		if err != nil {
			return model.Media{}, err
		}
		if !found || !canAccessPublicMedia(user, public.Media) {
			return model.Media{}, safeMessageError{message: "公共图片不存在或正在删除"}
		}
		bound, err := bindMediaVersion(ctx, versioned, public.Media)
		if err != nil {
			return model.Media{}, safeMessageError{message: "公共图片版本已丢失或校验失败，请联系管理员"}
		}
		if bound.Bytes <= 0 || bound.Bytes > maxMediaBytes || !strings.HasPrefix(bound.ContentType, "image/") {
			return model.Media{}, safeMessageError{message: "公共图片格式或大小无效"}
		}
		current := time.Now().UTC()
		intent = model.MediaUploadIntent{ID: id, OwnerUID: user.UID, ObjectKey: privateImageObjectKey(user.UID, model.MediaSourceUpload, filepath.Ext(bound.Filename), current), Filename: bound.Filename, ContentType: bound.ContentType, ExpectedBytes: bound.Bytes, Intent: repository.PublicImageImportIntent, ExpiresAt: current.Add(24 * time.Hour).Format(time.RFC3339Nano), CreatedAt: current.Format(time.RFC3339Nano), SourcePublicImageID: publicID, SourceMediaID: bound.ID, SourceObjectKey: bound.ObjectKey, SourceVersionID: bound.ObjectVersionID, SourceETag: bound.ObjectETag}
		intent, err = repository.ReservePublicImageImport(ctx, intent)
		if err != nil {
			return model.Media{}, safeMessageError{message: publicImportSafeError(err)}
		}
	}
	intent, copyNow, err := repository.ClaimPublicImageImport(ctx, id, user.UID, time.Now().UTC())
	if err != nil {
		return model.Media{}, safeMessageError{message: publicImportSafeError(err)}
	}
	if intent.CompletedMediaID != "" {
		return completedPublicImageImport(user, intent)
	}
	// Bound the network operation below the lease. After an ambiguous response or
	// crash, retries only inspect the registered key, never issue a second Copy.
	copyCtx, cancel := context.WithTimeout(ctx, 50*time.Second)
	defer cancel()
	var metadata imageObjectMetadata
	if copyNow {
		metadata, err = versioned.CopyVersion(copyCtx, intent.SourceObjectKey, intent.SourceVersionID, intent.SourceETag, intent.ObjectKey)
	} else {
		metadata, err = versioned.Head(copyCtx, intent.ObjectKey)
	}
	if err != nil {
		return model.Media{}, safeMessageError{message: "公共图片复制结果尚未确认，请稍后重试；重试不会重复复制"}
	}
	if metadata.VersionID == "" || metadata.ETag == "" || metadata.Bytes != intent.ExpectedBytes {
		return model.Media{}, safeMessageError{message: "公共图片副本校验失败"}
	}
	if _, err = versioned.HeadVersion(copyCtx, intent.ObjectKey, metadata.VersionID, metadata.ETag); err != nil {
		return model.Media{}, safeMessageError{message: "公共图片副本版本校验失败"}
	}
	source, found, err := repository.GetMedia(intent.SourceMediaID)
	if err != nil {
		return model.Media{}, err
	}
	if !found {
		return model.Media{}, safeMessageError{message: "公共图片源记录不存在"}
	}
	current := time.Now().UTC()
	expiry := current.Add(24 * time.Hour)
	item := model.Media{ID: newID("media"), OwnerUID: user.UID, Source: model.MediaSourceUpload, ObjectKey: intent.ObjectKey, ObjectVersionID: metadata.VersionID, ObjectETag: metadata.ETag, ContentType: intent.ContentType, Bytes: metadata.Bytes, Width: source.Width, Height: source.Height, Filename: intent.Filename, Title: source.Title, CreatedAt: current.Format(time.RFC3339Nano), ExpiresAt: &expiry}
	// On an ambiguous DB commit the reservation remains durable. Do not delete
	// here: the committed media may already be visible to a retry.
	return repository.PublishPublicImageImport(ctx, intent, item, current)
}
func completedPublicImageImport(user PortalUser, intent model.MediaUploadIntent) (model.Media, error) {
	item, found, err := repository.GetMedia(intent.CompletedMediaID)
	if err != nil {
		return item, err
	}
	if !found || item.OwnerUID != user.UID || item.CleanupStatus != model.MediaCleanupActive {
		return model.Media{}, safeMessageError{message: "导入的个人图片已删除，请重新导入"}
	}
	return item, nil
}
func publicImportSafeError(err error) string {
	for _, known := range []error{repository.ErrPublicImageImportBusy, repository.ErrPublicImageImportExpired, repository.ErrPublicImageImportMismatch, repository.ErrPublicImageImportUnavailable} {
		if errors.Is(err, known) {
			return known.Error()
		}
	}
	return "公共图片导入失败，请稍后重试"
}
