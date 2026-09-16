package service

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
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
	ETag        string
	VersionID   string
}

// versionedImageStore is required by image task snapshots. Implementations
// must bind every read, copy, signature and delete to an object version.
type versionedImageStore interface {
	imageStore
	EnsureVersioningEnabled(context.Context) error
	HeadVersion(context.Context, string, string, string) (imageObjectMetadata, error)
	ReadPrefixVersion(context.Context, string, string, string, int64) ([]byte, error)
	CopyVersion(context.Context, string, string, string, string) (imageObjectMetadata, error)
	SignedURLVersion(context.Context, string, string, time.Duration) (string, time.Time, error)
	DeleteVersion(context.Context, string, string) error
	DeletePrefixVersions(context.Context, string) error
}

var (
	errDirectUploadUnsupported = errors.New("当前存储不支持浏览器直传")
	errOSSVersioningRequired   = errors.New("OSS Bucket 必须启用版本控制")
)

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

// Copy creates an independent object without loading a whole video into memory.
func (store localImageStore) Copy(ctx context.Context, source, target string) (err error) {
	input, err := store.Open(source)
	if err != nil {
		return err
	}
	defer input.Close()
	path := store.path(target)
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		return err
	}
	output, err := os.Create(path)
	if err != nil {
		return err
	}
	defer func() {
		if err != nil {
			_ = os.Remove(path)
		}
	}()
	if err = ctx.Err(); err != nil {
		output.Close()
		return err
	}
	n, copyErr := io.Copy(output, io.LimitReader(input, maxMediaBytes+1))
	closeErr := output.Close()
	if copyErr != nil {
		return copyErr
	}
	if closeErr != nil {
		return closeErr
	}
	if n <= 0 || n > maxMediaBytes {
		return errors.New("分享视频大小无效")
	}
	return ctx.Err()
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
	data, err := os.ReadFile(store.path(key))
	if err != nil {
		return imageObjectMetadata{}, err
	}
	digest := sha256.Sum256(data)
	return imageObjectMetadata{Bytes: info.Size(), ETag: fmt.Sprintf("%x", digest[:]), VersionID: "null"}, nil
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

func (store localImageStore) EnsureVersioningEnabled(context.Context) error { return nil }
func (store localImageStore) HeadVersion(ctx context.Context, key, versionID, etag string) (imageObjectMetadata, error) {
	if versionID != "" && versionID != "null" {
		return imageObjectMetadata{}, errors.New("local object version is unavailable")
	}
	metadata, err := store.Head(ctx, key)
	if err == nil && etag != "" && etag != metadata.ETag {
		return imageObjectMetadata{}, errors.New("object etag changed")
	}
	return metadata, err
}
func (store localImageStore) ReadPrefixVersion(ctx context.Context, key, versionID, etag string, bytes int64) ([]byte, error) {
	if _, err := store.HeadVersion(ctx, key, versionID, etag); err != nil {
		return nil, err
	}
	return store.ReadPrefix(ctx, key, bytes)
}
func (store localImageStore) CopyVersion(ctx context.Context, source, versionID, etag, target string) (imageObjectMetadata, error) {
	if _, err := store.HeadVersion(ctx, source, versionID, etag); err != nil {
		return imageObjectMetadata{}, err
	}
	if err := store.Copy(ctx, source, target); err != nil {
		return imageObjectMetadata{}, err
	}
	return store.Head(ctx, target)
}
func (store localImageStore) SignedURLVersion(ctx context.Context, key, versionID string, _ time.Duration) (string, time.Time, error) {
	if _, err := store.HeadVersion(ctx, key, versionID, ""); err != nil {
		return "", time.Time{}, err
	}
	return store.SignedURL(ctx, key, "")
}
func (store localImageStore) DeleteVersion(ctx context.Context, key, _ string) error {
	return deleteImageObject(ctx, store, key)
}
func (store localImageStore) DeletePrefixVersions(_ context.Context, prefix string) error {
	return os.RemoveAll(store.path(prefix))
}

type ossImageStore struct {
	internal, public *oss.Client
	bucket           string
	ttl              time.Duration
}

func (store *ossImageStore) Put(ctx context.Context, key string, data []byte, contentType string) error {
	_, err := store.internal.PutObject(ctx, &oss.PutObjectRequest{Bucket: oss.Ptr(store.bucket), Key: oss.Ptr(key), Body: bytes.NewReader(data), ContentType: oss.Ptr(contentType), ContentLength: oss.Ptr(int64(len(data))), Acl: oss.ObjectACLPrivate})
	return err
}
func (store *ossImageStore) Copy(ctx context.Context, source, target string) error {
	_, err := store.internal.CopyObject(ctx, &oss.CopyObjectRequest{Bucket: oss.Ptr(store.bucket), Key: oss.Ptr(target), SourceBucket: oss.Ptr(store.bucket), SourceKey: oss.Ptr(source), Acl: oss.ObjectACLPrivate})
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
	return store.signedAccessURL(ctx, key, process, "")
}

func (store *ossImageStore) SignedDownloadURL(ctx context.Context, key, disposition string) (string, time.Time, error) {
	return store.signedAccessURL(ctx, key, "", disposition)
}

func (store *ossImageStore) signedAccessURL(ctx context.Context, key, process, disposition string) (string, time.Time, error) {
	return store.signedAccessURLVersion(ctx, key, "", process, disposition)
}
func (store *ossImageStore) signedAccessURLVersion(ctx context.Context, key, version, process, disposition string) (string, time.Time, error) {
	request := &oss.GetObjectRequest{Bucket: oss.Ptr(store.bucket), Key: oss.Ptr(key)}
	if version != "" {
		request.VersionId = oss.Ptr(version)
	}
	if disposition != "" {
		request.ResponseContentDisposition = oss.Ptr(disposition)
	}
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
	return imageObjectMetadata{ContentType: strings.TrimSpace(oss.ToString(result.ContentType)), Bytes: result.ContentLength, ETag: strings.TrimSpace(oss.ToString(result.ETag)), VersionID: oss.ToString(result.VersionId)}, nil
}

func (store *ossImageStore) EnsureVersioningEnabled(ctx context.Context) error {
	result, err := store.internal.GetBucketVersioning(ctx, &oss.GetBucketVersioningRequest{Bucket: oss.Ptr(store.bucket)})
	if err != nil {
		return err
	}
	if strings.TrimSpace(oss.ToString(result.VersionStatus)) != "Enabled" {
		return errOSSVersioningRequired
	}
	return nil
}

func (store *ossImageStore) HeadVersion(ctx context.Context, key, versionID, etag string) (imageObjectMetadata, error) {
	request := &oss.HeadObjectRequest{Bucket: oss.Ptr(store.bucket), Key: oss.Ptr(key), VersionId: oss.Ptr(versionID)}
	if etag != "" {
		request.IfMatch = oss.Ptr(etag)
	}
	result, err := store.internal.HeadObject(ctx, request)
	if err != nil {
		return imageObjectMetadata{}, err
	}
	return imageObjectMetadata{ContentType: strings.TrimSpace(oss.ToString(result.ContentType)), Bytes: result.ContentLength, ETag: strings.TrimSpace(oss.ToString(result.ETag)), VersionID: oss.ToString(result.VersionId)}, nil
}

func (store *ossImageStore) ReadPrefixVersion(ctx context.Context, key, versionID, etag string, bytes int64) ([]byte, error) {
	if bytes <= 0 {
		return nil, nil
	}
	request := &oss.GetObjectRequest{Bucket: oss.Ptr(store.bucket), Key: oss.Ptr(key), VersionId: oss.Ptr(versionID), Range: oss.Ptr("bytes=0-" + fmt.Sprint(bytes-1))}
	if etag != "" {
		request.IfMatch = oss.Ptr(etag)
	}
	result, err := store.internal.GetObject(ctx, request)
	if err != nil {
		return nil, err
	}
	defer result.Body.Close()
	return io.ReadAll(io.LimitReader(result.Body, bytes))
}

func (store *ossImageStore) CopyVersion(ctx context.Context, source, sourceVersionID, sourceETag, target string) (imageObjectMetadata, error) {
	result, err := store.internal.CopyObject(ctx, &oss.CopyObjectRequest{Bucket: oss.Ptr(store.bucket), Key: oss.Ptr(target), SourceBucket: oss.Ptr(store.bucket), SourceKey: oss.Ptr(source), SourceVersionId: oss.Ptr(sourceVersionID), IfMatch: oss.Ptr(sourceETag), Acl: oss.ObjectACLPrivate})
	if err != nil {
		return imageObjectMetadata{}, err
	}
	versionID := oss.ToString(result.VersionId)
	if versionID == "" {
		return imageObjectMetadata{}, errors.New("OSS CopyObject 未返回目标 VersionID")
	}
	return store.HeadVersion(ctx, target, versionID, "")
}

func (store *ossImageStore) SignedURLVersion(ctx context.Context, key, versionID string, ttl time.Duration) (string, time.Time, error) {
	result, err := store.public.Presign(ctx, &oss.GetObjectRequest{Bucket: oss.Ptr(store.bucket), Key: oss.Ptr(key), VersionId: oss.Ptr(versionID)}, oss.PresignExpires(ttl))
	if err != nil {
		return "", time.Time{}, err
	}
	return result.URL, result.Expiration, nil
}

func (store *ossImageStore) DeleteVersion(ctx context.Context, key, versionID string) error {
	_, err := store.internal.DeleteObject(ctx, &oss.DeleteObjectRequest{Bucket: oss.Ptr(store.bucket), Key: oss.Ptr(key), VersionId: oss.Ptr(versionID)})
	return err
}

func (store *ossImageStore) DeletePrefixVersions(ctx context.Context, prefix string) error {
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		result, err := store.internal.ListObjectVersions(ctx, &oss.ListObjectVersionsRequest{Bucket: oss.Ptr(store.bucket), Prefix: oss.Ptr(prefix), MaxKeys: 1000})
		if err != nil {
			return err
		}
		if len(result.ObjectVersions) == 0 && len(result.ObjectDeleteMarkers) == 0 {
			return nil
		}
		for _, item := range result.ObjectVersions {
			if err := store.DeleteVersion(ctx, oss.ToString(item.Key), oss.ToString(item.VersionId)); err != nil {
				return err
			}
		}
		for _, item := range result.ObjectDeleteMarkers {
			if err := store.DeleteVersion(ctx, oss.ToString(item.Key), oss.ToString(item.VersionId)); err != nil {
				return err
			}
		}
	}
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

func (store *ossImageStore) GetVersion(ctx context.Context, key, version, etag string) (io.ReadCloser, error) {
	request := &oss.GetObjectRequest{Bucket: oss.Ptr(store.bucket), Key: oss.Ptr(key), VersionId: oss.Ptr(version)}
	if etag != "" {
		request.IfMatch = oss.Ptr(etag)
	}
	result, err := store.internal.GetObject(ctx, request)
	if err != nil {
		return nil, err
	}
	return result.Body, nil
}

func (store *ossImageStore) SignedMediaURL(ctx context.Context, key, version, process, disposition string) (string, time.Time, error) {
	return store.signedAccessURLVersion(ctx, key, version, process, disposition)
}

// Capture the write response's version; HEAD without a version could observe a
// later write if this reserved key is ever retried.
func putImageObject(ctx context.Context, store imageStore, key string, data []byte, contentType string) (imageObjectMetadata, error) {
	if target, ok := store.(*ossImageStore); ok {
		result, err := target.internal.PutObject(ctx, &oss.PutObjectRequest{Bucket: oss.Ptr(target.bucket), Key: oss.Ptr(key), Body: bytes.NewReader(data), ContentType: oss.Ptr(contentType), ContentLength: oss.Ptr(int64(len(data))), Acl: oss.ObjectACLPrivate})
		if err != nil {
			return imageObjectMetadata{}, err
		}
		if oss.ToString(result.VersionId) == "" {
			return imageObjectMetadata{}, errors.New("OSS 写入未返回 VersionID")
		}
		return target.HeadVersion(ctx, key, oss.ToString(result.VersionId), oss.ToString(result.ETag))
	}
	if err := store.Put(ctx, key, data, contentType); err != nil {
		return imageObjectMetadata{}, err
	}
	return store.Head(ctx, key)
}
