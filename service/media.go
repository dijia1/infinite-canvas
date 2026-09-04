package service

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"image"
	_ "image/gif"
	_ "image/jpeg"
	_ "image/png"
	"io"
	"log"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/aliyun/alibabacloud-oss-go-sdk-v2/oss"
	"github.com/basketikun/infinite-canvas/config"
	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/repository"
	"github.com/google/uuid"
)

const maxMediaBytes = 50 << 20
const mediaPreviewProcess = "image/resize,w_320/quality,q_80/format,webp"
const mediaUploadIntentTTL = 15 * time.Minute

type MediaAccess struct {
	MediaID        string     `json:"mediaId"`
	URL            string     `json:"url"`
	PreviewURL     string     `json:"previewUrl"`
	ExpiresAt      time.Time  `json:"expiresAt"`
	MediaExpiresAt *time.Time `json:"mediaExpiresAt,omitempty"`
	ContentType    string     `json:"contentType"`
	Bytes          int64      `json:"bytes"`
	Width          int        `json:"width"`
	Height         int        `json:"height"`
}

type MediaUploadIntentInput struct {
	Filename    string `json:"filename"`
	ContentType string `json:"contentType"`
	Bytes       int64  `json:"bytes"`
	Intent      string `json:"intent"`
}

type MediaUploadIntentView struct {
	Mode      string    `json:"mode"`
	ID        string    `json:"id,omitempty"`
	UploadURL string    `json:"uploadUrl,omitempty"`
	ExpiresAt time.Time `json:"expiresAt,omitempty"`
}

func privateImageObjectKey(userUID string, source model.MediaSource, extension string, now time.Time) string {
	prefix := strings.Trim(strings.TrimSpace(config.Cfg.OSSObjectPrefix), "/")
	if prefix == "" {
		prefix = "images"
	}
	category := "library"
	switch source {
	case model.MediaSourceGenerated:
		category = "generated"
	}
	return fmt.Sprintf("%s/private/%s/%s/%04d/%02d/%s.%s", prefix, category, userUID, now.Year(), now.Month(), uuid.NewString(), extension)
}

func publicImageObjectKey(extension string, now time.Time) string {
	prefix := strings.Trim(strings.TrimSpace(config.Cfg.OSSObjectPrefix), "/")
	if prefix == "" {
		prefix = "images"
	}
	return fmt.Sprintf("%s/public/%04d/%02d/%s.%s", prefix, now.Year(), now.Month(), uuid.NewString(), extension)
}

func canAccessMedia(user PortalUser, item model.Media) bool {
	role := config.Cfg.PortalAdminRole
	if strings.TrimSpace(role) == "" {
		role = "portal-admin"
	}
	return user.UID == item.OwnerUID || user.HasRole(role)
}

func SaveUploadedImage(ctx context.Context, user PortalUser, filename, contentType string, data []byte, intent ...string) (MediaAccess, error) {
	source, err := uploadMediaSource(intent)
	if err != nil {
		return MediaAccess{}, err
	}
	return saveImage(ctx, user, source, filename, contentType, data, false)
}

func CreateMediaUploadIntent(ctx context.Context, user PortalUser, input MediaUploadIntentInput) (MediaUploadIntentView, error) {
	if user.UID == "" {
		return MediaUploadIntentView{}, errors.New("未经过 Portal Gateway 身份验证")
	}
	source, filename, extension, err := validateMediaUploadIntentInput(input)
	if err != nil {
		return MediaUploadIntentView{}, err
	}
	store, err := newImageStore()
	if err != nil {
		return MediaUploadIntentView{}, err
	}
	if _, unsupported := store.(localImageStore); unsupported {
		return MediaUploadIntentView{Mode: "proxy"}, nil
	}
	createdAt := time.Now().UTC()
	expiresAt := createdAt.Add(mediaUploadIntentTTL)
	item := model.MediaUploadIntent{
		ID:            newID("media-upload"),
		OwnerUID:      user.UID,
		ObjectKey:     privateImageObjectKey(user.UID, source, extension, createdAt),
		Filename:      filename,
		ContentType:   normalizedImageContentType(input.ContentType),
		ExpectedBytes: input.Bytes,
		Intent:        strings.TrimSpace(input.Intent),
		ExpiresAt:     expiresAt.Format(time.RFC3339Nano),
		CreatedAt:     createdAt.Format(time.RFC3339Nano),
	}
	if err := repository.SaveMediaUploadIntent(item); err != nil {
		return MediaUploadIntentView{}, err
	}
	uploadURL, signedExpiry, err := store.PresignPut(ctx, item.ObjectKey, item.ContentType)
	if err != nil {
		_ = repository.DeleteMediaUploadIntent(item.ID)
		return MediaUploadIntentView{}, fmt.Errorf("生成上传地址失败: %w", err)
	}
	return MediaUploadIntentView{Mode: "direct", ID: item.ID, UploadURL: uploadURL, ExpiresAt: signedExpiry}, nil
}

func CompleteMediaUploadIntent(ctx context.Context, user PortalUser, id string) (MediaAccess, bool, error) {
	if user.UID == "" {
		return MediaAccess{}, false, errors.New("未经过 Portal Gateway 身份验证")
	}
	intent, found, err := repository.GetMediaUploadIntentForOwner(id, user.UID)
	if err != nil {
		return MediaAccess{}, false, err
	}
	if !found {
		return MediaAccess{}, false, safeMessageError{message: "上传请求不存在"}
	}
	if intent.CompletedMediaID != "" {
		access, err := MediaAccessURL(ctx, user, intent.CompletedMediaID)
		return access, false, err
	}
	expiresAt, err := time.Parse(time.RFC3339Nano, intent.ExpiresAt)
	if err != nil || !time.Now().UTC().Before(expiresAt) {
		return MediaAccess{}, false, safeMessageError{message: "上传请求已过期，请重新选择图片"}
	}
	store, err := newImageStore()
	if err != nil {
		return MediaAccess{}, false, err
	}
	metadata, err := store.Head(ctx, intent.ObjectKey)
	if err != nil {
		return MediaAccess{}, false, safeMessageError{message: "图片尚未上传完成，请稍后重试"}
	}
	if metadata.Bytes != intent.ExpectedBytes || normalizedImageContentType(metadata.ContentType) != intent.ContentType {
		return MediaAccess{}, false, safeMessageError{message: "图片上传校验失败，请重新上传"}
	}
	prefix, err := store.ReadPrefix(ctx, intent.ObjectKey, 512)
	if err != nil || normalizedImageContentType(http.DetectContentType(prefix)) != intent.ContentType {
		return MediaAccess{}, false, safeMessageError{message: "图片上传校验失败，请重新上传"}
	}
	completedAt := time.Now().UTC()
	item := model.Media{ID: newID("media"), OwnerUID: user.UID, Source: model.MediaSourceUpload, ObjectKey: intent.ObjectKey, ContentType: intent.ContentType, Bytes: intent.ExpectedBytes, Filename: intent.Filename, Title: strings.TrimSuffix(intent.Filename, filepath.Ext(intent.Filename)), CreatedAt: completedAt.Format(time.RFC3339)}
	updatedIntent, media, created, err := repository.FinalizeMediaUploadIntent(intent.ID, user.UID, completedAt.Format(time.RFC3339Nano), item)
	if err != nil {
		return MediaAccess{}, false, err
	}
	if updatedIntent.ID == "" {
		return MediaAccess{}, false, safeMessageError{message: "上传请求不存在"}
	}
	if !created && media.ID == "" {
		return MediaAccess{}, false, safeMessageError{message: "上传请求已过期，请重新选择图片"}
	}
	access, err := mediaAccess(ctx, store, media)
	return access, created, err
}

func validateMediaUploadIntentInput(input MediaUploadIntentInput) (model.MediaSource, string, string, error) {
	source, err := uploadMediaSource([]string{input.Intent})
	if err != nil {
		return "", "", "", err
	}
	filename := strings.TrimSpace(filepath.Base(input.Filename))
	if filename == "" || filename == "." {
		return "", "", "", safeMessageError{message: "图片文件名无效"}
	}
	if input.Bytes <= 0 || input.Bytes > maxMediaBytes {
		return "", "", "", safeMessageError{message: "图片大小无效"}
	}
	contentType := normalizedImageContentType(input.ContentType)
	extension, ok := mediaUploadExtensions[contentType]
	if !ok {
		return "", "", "", safeMessageError{message: "图片格式无效"}
	}
	return source, filename, extension, nil
}

var mediaUploadExtensions = map[string]string{
	"image/gif":  "gif",
	"image/jpeg": "jpg",
	"image/png":  "png",
	"image/webp": "webp",
}

func normalizedImageContentType(value string) string {
	contentType, _, err := mime.ParseMediaType(value)
	if err != nil {
		return ""
	}
	return strings.ToLower(strings.TrimSpace(contentType))
}

func uploadMediaSource(intent []string) (model.MediaSource, error) {
	value := "library"
	if len(intent) > 0 {
		value = strings.ToLower(strings.TrimSpace(intent[0]))
	}
	switch value {
	case "", "library":
		return model.MediaSourceUpload, nil
	case "canvas":
		return model.MediaSourceUpload, nil
	default:
		return "", safeMessageError{message: "图片上传意图无效"}
	}
}

func saveImage(ctx context.Context, user PortalUser, source model.MediaSource, filename, contentType string, data []byte, isPublic bool) (MediaAccess, error) {
	if user.UID == "" {
		return MediaAccess{}, errors.New("未经过 Portal Gateway 身份验证")
	}
	if len(data) == 0 || len(data) > maxMediaBytes {
		return MediaAccess{}, errors.New("图片大小无效")
	}
	contentType, extension, err := normalizeImage(data, contentType)
	if err != nil {
		return MediaAccess{}, err
	}
	store, err := newImageStore()
	if err != nil {
		return MediaAccess{}, err
	}
	createdAt := time.Now()
	key := privateImageObjectKey(user.UID, source, extension, createdAt)
	if isPublic {
		key = publicImageObjectKey(extension, createdAt)
	}
	if err := store.Put(ctx, key, data, contentType); err != nil {
		return MediaAccess{}, fmt.Errorf("保存图片失败: %w", err)
	}
	width, height := imageDimensions(data)
	item := model.Media{ID: newID("media"), OwnerUID: user.UID, Source: source, ObjectKey: key, ContentType: contentType, Bytes: int64(len(data)), Width: width, Height: height, Filename: filepath.Base(filename), Title: strings.TrimSuffix(filepath.Base(filename), filepath.Ext(filename)), CreatedAt: now()}
	saved, err := repository.SaveMedia(item)
	if err != nil {
		_ = store.Delete(ctx, key)
		return MediaAccess{}, err
	}
	return mediaAccess(ctx, store, saved)
}

func MediaAccessURL(ctx context.Context, user PortalUser, id string) (MediaAccess, error) {
	item, found, err := repository.GetMedia(id)
	if err != nil {
		return MediaAccess{}, err
	}
	if !found {
		return MediaAccess{}, safeMessageError{message: "图片不存在"}
	}
	if !canAccessMedia(user, item) {
		return MediaAccess{}, safeMessageError{message: "无权访问该图片"}
	}
	store, err := newImageStore()
	if err != nil {
		return MediaAccess{}, err
	}
	return mediaAccess(ctx, store, item)
}

func DeletePrivateMedia(ctx context.Context, user PortalUser, id string) error {
	item, found, err := repository.GetMedia(id)
	if err != nil {
		return privateMediaDeleteFailure(id, err)
	}
	if !found {
		return nil
	}
	if !canAccessMedia(user, item) {
		return safeMessageError{message: "无权删除该图片"}
	}
	_, isPublic, err := repository.GetPublicImageByMediaID(item.ID)
	if err != nil {
		return privateMediaDeleteFailure(id, err)
	}
	if isPublic {
		return safeMessageError{message: "公共图片请通过公共素材管理删除"}
	}
	store, err := newImageStore()
	if err != nil {
		return privateMediaDeleteFailure(id, err)
	}
	if err := deleteImageObject(ctx, store, item.ObjectKey); err != nil {
		return privateMediaDeleteFailure(id, err)
	}
	if err := repository.DeleteMedia(item.ID); err != nil {
		return privateMediaDeleteFailure(id, err)
	}
	return nil
}

func privateMediaDeleteFailure(id string, err error) error {
	log.Printf("private media delete failed media_id=%s: %v", id, err)
	return safeMessageError{message: "删除图片失败，请稍后重试"}
}

func deleteImageObject(ctx context.Context, store imageStore, key string) error {
	err := store.Delete(ctx, key)
	if err == nil || isMissingImageObjectError(err) {
		return nil
	}
	return err
}

func isMissingImageObjectError(err error) bool {
	if errors.Is(err, os.ErrNotExist) {
		return true
	}
	var serviceError *oss.ServiceError
	return errors.As(err, &serviceError) && serviceError.StatusCode == http.StatusNotFound
}

func mediaAccess(ctx context.Context, store imageStore, item model.Media) (MediaAccess, error) {
	url, expiresAt, err := store.SignedURL(ctx, item.ObjectKey, "")
	if err != nil {
		return MediaAccess{}, fmt.Errorf("生成图片访问地址失败: %w", err)
	}
	previewURL, _, err := store.SignedURL(ctx, item.ObjectKey, mediaPreviewProcess)
	if err != nil {
		return MediaAccess{}, fmt.Errorf("生成图片预览地址失败: %w", err)
	}
	if _, local := store.(localImageStore); local {
		url = "/api/v1/media/" + item.ID + "/content"
		previewURL = url
	}
	return MediaAccess{MediaID: item.ID, URL: url, PreviewURL: previewURL, ExpiresAt: expiresAt, MediaExpiresAt: item.ExpiresAt, ContentType: item.ContentType, Bytes: item.Bytes, Width: item.Width, Height: item.Height}, nil
}

func OpenLocalMedia(ctx context.Context, user PortalUser, id string) (io.ReadCloser, string, error) {
	item, found, err := repository.GetMedia(id)
	if err != nil {
		return nil, "", err
	}
	if !found {
		return nil, "", safeMessageError{message: "图片不存在"}
	}
	if !canAccessMedia(user, item) {
		return nil, "", safeMessageError{message: "无权访问该图片"}
	}
	store, err := newImageStore()
	if err != nil {
		return nil, "", err
	}
	local, ok := store.(localImageStore)
	if !ok {
		return nil, "", safeMessageError{message: "当前存储不支持本地文件访问"}
	}
	file, err := local.Open(item.ObjectKey)
	return file, item.ContentType, err
}

func normalizeImage(data []byte, claimed string) (string, string, error) {
	contentType, _, _ := mime.ParseMediaType(claimed)
	detected := http.DetectContentType(data)
	if !strings.HasPrefix(detected, "image/") {
		return "", "", errors.New("图片格式无效")
	}
	if !strings.HasPrefix(contentType, "image/") {
		contentType = detected
	}
	extensions, _ := mime.ExtensionsByType(contentType)
	extension := "png"
	if len(extensions) > 0 {
		extension = strings.TrimPrefix(extensions[0], ".")
	}
	return contentType, extension, nil
}

func imageDimensions(data []byte) (int, int) {
	config, _, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil || config.Width <= 0 || config.Height <= 0 {
		return 0, 0
	}
	return config.Width, config.Height
}
