package service

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/aliyun/alibabacloud-oss-go-sdk-v2/oss"
	"github.com/aliyun/alibabacloud-oss-go-sdk-v2/oss/credentials"
	"github.com/basketikun/infinite-canvas/config"
)

type imageStore interface {
	Put(context.Context, string, []byte, string) error
	Get(context.Context, string) (io.ReadCloser, error)
	Delete(context.Context, string) error
	SignedURL(context.Context, string, string) (string, time.Time, error)
	PresignPut(context.Context, string, string) (string, time.Time, error)
	Head(context.Context, string) (imageObjectMetadata, error)
	ReadPrefix(context.Context, string, int64) ([]byte, error)
}

type imageObjectMetadata struct {
	ContentType string
	Bytes       int64
}

var errDirectUploadUnsupported = errors.New("当前存储不支持浏览器直传")

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
func (store localImageStore) PresignPut(context.Context, string, string) (string, time.Time, error) {
	return "", time.Time{}, errDirectUploadUnsupported
}
func (store localImageStore) Head(_ context.Context, key string) (imageObjectMetadata, error) {
	info, err := os.Stat(store.path(key))
	if err != nil {
		return imageObjectMetadata{}, err
	}
	return imageObjectMetadata{Bytes: info.Size()}, nil
}
func (store localImageStore) ReadPrefix(_ context.Context, key string, bytes int64) ([]byte, error) {
	file, err := store.Open(key)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	return io.ReadAll(io.LimitReader(file, bytes))
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

func (store *ossImageStore) PresignPut(ctx context.Context, key, contentType string) (string, time.Time, error) {
	result, err := store.public.Presign(ctx, &oss.PutObjectRequest{Bucket: oss.Ptr(store.bucket), Key: oss.Ptr(key), ContentType: oss.Ptr(contentType)}, oss.PresignExpires(store.ttl))
	if err != nil {
		return "", time.Time{}, err
	}
	return result.URL, result.Expiration, nil
}

func (store *ossImageStore) Head(ctx context.Context, key string) (imageObjectMetadata, error) {
	result, err := store.internal.HeadObject(ctx, &oss.HeadObjectRequest{Bucket: oss.Ptr(store.bucket), Key: oss.Ptr(key)})
	if err != nil {
		return imageObjectMetadata{}, err
	}
	return imageObjectMetadata{ContentType: strings.TrimSpace(oss.ToString(result.ContentType)), Bytes: result.ContentLength}, nil
}

func (store *ossImageStore) ReadPrefix(ctx context.Context, key string, bytes int64) ([]byte, error) {
	if bytes <= 0 {
		return nil, nil
	}
	rangeHeader := oss.HTTPRange{Offset: 0, Count: bytes}.FormatHTTPRange()
	result, err := store.internal.GetObject(ctx, &oss.GetObjectRequest{Bucket: oss.Ptr(store.bucket), Key: oss.Ptr(key), Range: rangeHeader})
	if err != nil {
		return nil, err
	}
	defer result.Body.Close()
	return io.ReadAll(io.LimitReader(result.Body, bytes))
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
