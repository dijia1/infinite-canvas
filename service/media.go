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
	"sync"
	"time"

	"github.com/aliyun/alibabacloud-oss-go-sdk-v2/oss"
	"github.com/aliyun/alibabacloud-oss-go-sdk-v2/oss/credentials"
	"github.com/basketikun/infinite-canvas/config"
	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/repository"
	"github.com/google/uuid"
)

const maxMediaBytes = 50 << 20
const mediaPreviewProcess = "image/resize,w_320/quality,q_80/format,webp"
const canvasTemporaryMediaRetention = 7 * 24 * time.Hour

type imageStore interface {
	Put(context.Context, string, []byte, string) error
	Get(context.Context, string) (io.ReadCloser, error)
	Delete(context.Context, string) error
	SignedURL(context.Context, string, string) (string, time.Time, error)
}

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

func imageObjectKey(userUID, extension string, now time.Time) string {
	return privateImageObjectKey(userUID, model.MediaSourceUpload, extension, now)
}

func privateImageObjectKey(userUID string, source model.MediaSource, extension string, now time.Time) string {
	prefix := strings.Trim(strings.TrimSpace(config.Cfg.OSSObjectPrefix), "/")
	if prefix == "" {
		prefix = "images"
	}
	category := "library"
	switch source {
	case model.MediaSourceCanvasTemporary:
		category = "canvas"
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

func uploadMediaSource(intent []string) (model.MediaSource, error) {
	value := "library"
	if len(intent) > 0 {
		value = strings.ToLower(strings.TrimSpace(intent[0]))
	}
	switch value {
	case "", "library":
		return model.MediaSourceUpload, nil
	case "canvas":
		return model.MediaSourceCanvasTemporary, nil
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
	if source == model.MediaSourceCanvasTemporary && !isPublic {
		expiresAt := createdAt.Add(canvasTemporaryMediaRetention)
		item.ExpiresAt = &expiresAt
	}
	saved, err := repository.SaveMedia(item)
	if err != nil {
		_ = store.Delete(ctx, key)
		return MediaAccess{}, err
	}
	return mediaAccess(ctx, store, saved)
}

func PreserveTemporaryPrivateMedia(_ context.Context, user PortalUser, id string) (model.Media, error) {
	temporaryMediaRetentionMutex.Lock()
	defer temporaryMediaRetentionMutex.Unlock()
	item, found, err := repository.GetMedia(id)
	if err != nil {
		return model.Media{}, err
	}
	if !found || item.OwnerUID != user.UID {
		return model.Media{}, safeMessageError{message: "图片不存在"}
	}
	if item.Source != model.MediaSourceCanvasTemporary || item.ExpiresAt == nil {
		return model.Media{}, safeMessageError{message: "该图片不是画板临时素材"}
	}
	if !item.ExpiresAt.After(time.Now()) {
		return model.Media{}, safeMessageError{message: "临时素材已到期，无法永久保存"}
	}
	updated, found, err := repository.PreserveTemporaryMedia(id, user.UID)
	if err != nil {
		return model.Media{}, err
	}
	if !found {
		return model.Media{}, safeMessageError{message: "图片不存在"}
	}
	updated.Title = privateImageTitle(updated)
	return updated, nil
}

var (
	temporaryMediaStoreFactory   = newImageStore
	temporaryMediaRetentionMutex sync.Mutex
)

func CleanupExpiredTemporaryMedia(ctx context.Context, before time.Time) (int, error) {
	temporaryMediaRetentionMutex.Lock()
	defer temporaryMediaRetentionMutex.Unlock()
	items, err := repository.ListExpiredTemporaryMedia(before)
	if err != nil {
		return 0, err
	}
	if len(items) == 0 {
		return 0, nil
	}
	store, err := temporaryMediaStoreFactory()
	if err != nil {
		return 0, err
	}
	deleted := 0
	var failures []error
	for _, item := range items {
		if err := deleteImageObject(ctx, store, item.ObjectKey); err != nil {
			failures = append(failures, fmt.Errorf("删除到期素材 %s 失败: %w", item.ID, err))
			continue
		}
		if err := repository.DeleteMedia(item.ID); err != nil {
			failures = append(failures, fmt.Errorf("删除到期素材记录 %s 失败: %w", item.ID, err))
			continue
		}
		deleted++
	}
	return deleted, errors.Join(failures...)
}

func StartTemporaryMediaRetention(parent context.Context) func() {
	ctx, cancel := context.WithCancel(parent)
	var waitGroup sync.WaitGroup
	waitGroup.Add(1)
	go func() {
		defer waitGroup.Done()
		runTemporaryMediaRetention(ctx)
	}()
	return func() {
		cancel()
		waitGroup.Wait()
	}
}

func runTemporaryMediaRetention(ctx context.Context) {
	cleanup := func(current time.Time) {
		if _, err := CleanupExpiredTemporaryMedia(ctx, current); err != nil && ctx.Err() == nil {
			log.Printf("temporary media cleanup failed: %v", err)
		}
	}
	cleanup(time.Now())
	ticker := time.NewTicker(24 * time.Hour)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case current := <-ticker.C:
			cleanup(current)
		}
	}
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
	if item.Source == model.MediaSourceCanvasTemporary && item.ExpiresAt != nil && !item.ExpiresAt.After(time.Now()) {
		return MediaAccess{}, safeMessageError{message: "画板临时素材已到期"}
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
		return err
	}
	if !found {
		return nil
	}
	if !canAccessMedia(user, item) {
		return safeMessageError{message: "无权删除该图片"}
	}
	_, isPublic, err := repository.GetPublicImageByMediaID(item.ID)
	if err != nil {
		return err
	}
	if isPublic {
		return safeMessageError{message: "公共图片请通过公共素材管理删除"}
	}
	store, err := newImageStore()
	if err != nil {
		return err
	}
	if err := deleteImageObject(ctx, store, item.ObjectKey); err != nil {
		return fmt.Errorf("删除图片文件失败: %w", err)
	}
	return repository.DeleteMedia(item.ID)
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
	if item.Source == model.MediaSourceCanvasTemporary && item.ExpiresAt != nil && !item.ExpiresAt.After(time.Now()) {
		return nil, "", safeMessageError{message: "画板临时素材已到期"}
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

type localImageStore struct{ directory string }

func (store localImageStore) path(key string) string {
	return filepath.Join(store.directory, filepath.FromSlash(key))
}
func (store localImageStore) Put(_ context.Context, key string, data []byte, _ string) error {
	path := store.path(key)
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		return err
	}
	return os.WriteFile(path, data, 0644)
}
func (store localImageStore) Get(_ context.Context, key string) (io.ReadCloser, error) {
	return store.Open(key)
}
func (store localImageStore) Delete(_ context.Context, key string) error {
	return os.Remove(store.path(key))
}
func (store localImageStore) SignedURL(_ context.Context, key, _ string) (string, time.Time, error) {
	return "/api/v1/media/local?key=" + key, time.Time{}, nil
}
func (store localImageStore) Open(key string) (io.ReadCloser, error) { return os.Open(store.path(key)) }

type ossImageStore struct {
	internal, public *oss.Client
	bucket           string
	ttl              time.Duration
}

func (store *ossImageStore) Put(ctx context.Context, key string, data []byte, contentType string) error {
	_, err := store.internal.PutObject(ctx, &oss.PutObjectRequest{Bucket: oss.Ptr(store.bucket), Key: oss.Ptr(key), Body: bytes.NewReader(data), ContentType: oss.Ptr(contentType), ContentLength: oss.Ptr(int64(len(data))), Acl: oss.ObjectACLPrivate})
	return err
}
func (store *ossImageStore) Get(ctx context.Context, key string) (io.ReadCloser, error) {
	result, err := store.internal.GetObject(ctx, &oss.GetObjectRequest{Bucket: oss.Ptr(store.bucket), Key: oss.Ptr(key)})
	if err != nil {
		return nil, err
	}
	return result.Body, nil
}
func (store *ossImageStore) Delete(ctx context.Context, key string) error {
	_, err := store.internal.DeleteObject(ctx, &oss.DeleteObjectRequest{Bucket: oss.Ptr(store.bucket), Key: oss.Ptr(key)})
	return err
}
func (store *ossImageStore) SignedURL(ctx context.Context, key, process string) (string, time.Time, error) {
	request := &oss.GetObjectRequest{Bucket: oss.Ptr(store.bucket), Key: oss.Ptr(key)}
	if process != "" {
		request.Process = oss.Ptr(process)
	}
	result, err := store.public.Presign(ctx, request, oss.PresignExpires(store.ttl))
	if err != nil {
		return "", time.Time{}, err
	}
	return result.URL, result.Expiration, nil
}

func newImageStore() (imageStore, error) {
	if strings.TrimSpace(config.Cfg.MediaStorage) == "" || strings.EqualFold(config.Cfg.MediaStorage, "local") {
		return localImageStore{directory: config.Cfg.MediaLocalDir}, nil
	}
	if !strings.EqualFold(config.Cfg.MediaStorage, "oss") {
		return nil, errors.New("MEDIA_STORAGE 必须为 local 或 oss")
	}
	if config.Cfg.OSSRegion == "" || config.Cfg.OSSBucket == "" || config.Cfg.OSSInternalEndpoint == "" || config.Cfg.OSSPublicEndpoint == "" || config.Cfg.OSSAccessKeyID == "" || config.Cfg.OSSAccessKeySecret == "" {
		return nil, errors.New("OSS 配置不完整")
	}
	ttl, err := time.ParseDuration(config.Cfg.OSSSignedURLTTL)
	if err != nil || ttl <= 0 {
		return nil, errors.New("OSS_SIGNED_URL_TTL 无效")
	}
	provider := credentials.NewStaticCredentialsProvider(config.Cfg.OSSAccessKeyID, config.Cfg.OSSAccessKeySecret)
	internalCfg := oss.LoadDefaultConfig().WithRegion(config.Cfg.OSSRegion).WithEndpoint(config.Cfg.OSSInternalEndpoint).WithCredentialsProvider(provider)
	publicCfg := oss.LoadDefaultConfig().WithRegion(config.Cfg.OSSRegion).WithEndpoint(config.Cfg.OSSPublicEndpoint).WithUseCName(true).WithCredentialsProvider(provider)
	return &ossImageStore{internal: oss.NewClient(internalCfg), public: oss.NewClient(publicCfg), bucket: config.Cfg.OSSBucket, ttl: ttl}, nil
}
