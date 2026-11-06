package service

import (
	"context"
	"errors"
	"github.com/aliyun/alibabacloud-oss-go-sdk-v2/oss"
	"io"
	"net/http"
	"time"
)

// Relay the provider response into OSS without probing, buffering or spooling
// the video. The task worker retries by reopening the provider URL if needed.
func putVideoStream(ctx context.Context, store imageStore, key string, reader io.ReadCloser, size int64) (imageObjectMetadata, error) {
	if size == 0 || size > maxVideoBytes {
		return imageObjectMetadata{}, safeMessageError{message: "视频大小无效，最大 100 MB"}
	}
	target, ok := store.(*ossImageStore)
	if !ok {
		return imageObjectMetadata{}, errors.New("视频需要配置 OSS 存储")
	}
	request := &oss.PutObjectRequest{Bucket: oss.Ptr(target.bucket), Key: oss.Ptr(key), Body: http.MaxBytesReader(nil, reader, maxVideoBytes), ContentType: oss.Ptr("video/mp4"), Acl: oss.ObjectACLPrivate}
	if size > 0 {
		request.ContentLength = oss.Ptr(size)
	}
	result, err := target.internal.PutObject(ctx, request)
	if err != nil {
		return imageObjectMetadata{}, err
	}
	if oss.ToString(result.VersionId) == "" {
		return imageObjectMetadata{}, errors.New("OSS 写入未返回 VersionID")
	}
	return target.HeadVersion(ctx, key, oss.ToString(result.VersionId), oss.ToString(result.ETag))
}
func videoReferenceURL(ctx context.Context, store imageStore, key string) (string, error) {
	target, ok := store.(*ossImageStore)
	if !ok {
		return "", safeMessageError{message: "视频生成需要 OSS 存储"}
	}
	copy := *target
	copy.ttl = 2 * time.Hour
	url, _, err := copy.SignedURL(ctx, key, "")
	return url, err
}
