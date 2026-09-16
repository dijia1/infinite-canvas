package service

import (
	"context"
	"errors"
	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/repository"
	"io"
	"time"
)

// Local files have no object generations. OSS media operations require both
// version-aware reads and signatures, including processing/download parameters.
type mediaVersionStore interface {
	versionedImageStore
	GetVersion(context.Context, string, string, string) (io.ReadCloser, error)
	SignedMediaURL(context.Context, string, string, string, string) (string, time.Time, error)
}

func bindMediaVersion(ctx context.Context, store versionedImageStore, item model.Media) (model.Media, error) {
	var metadata imageObjectMetadata
	var err error
	if item.ObjectVersionID != "" {
		metadata, err = store.HeadVersion(ctx, item.ObjectKey, item.ObjectVersionID, item.ObjectETag)
	} else {
		metadata, err = store.Head(ctx, item.ObjectKey)
	}
	if err != nil {
		return model.Media{}, err
	}
	if metadata.VersionID == "" || metadata.ETag == "" || (item.ObjectETag != "" && item.ObjectETag != metadata.ETag) {
		return model.Media{}, safeMessageError{message: "媒体版本校验失败，请重新上传"}
	}
	if item.ObjectVersionID != "" && item.ObjectETag != "" {
		return item, nil
	}
	bound, err := repository.BindMediaObjectIdentity(ctx, item.ID, item.ObjectKey, metadata.VersionID, metadata.ETag)
	if err != nil {
		return model.Media{}, err
	}
	// A different caller may have won while our HEAD was in flight.
	if _, err = store.HeadVersion(ctx, bound.ObjectKey, bound.ObjectVersionID, bound.ObjectETag); err != nil {
		return model.Media{}, err
	}
	return bound, nil
}

func readMediaObject(ctx context.Context, store imageStore, item model.Media) (io.ReadCloser, error) {
	if versioned, ok := store.(mediaVersionStore); ok {
		bound, err := bindMediaVersion(ctx, versioned, item)
		if err != nil {
			return nil, err
		}
		return versioned.GetVersion(ctx, bound.ObjectKey, bound.ObjectVersionID, bound.ObjectETag)
	}
	return store.Get(ctx, item.ObjectKey)
}

func persistMediaCopyIdentity(ctx context.Context, item model.Media, metadata imageObjectMetadata) (model.Media, error) {
	if metadata.VersionID == "" || metadata.ETag == "" {
		return model.Media{}, errors.New("复制对象未返回版本身份")
	}
	return repository.BindMediaObjectIdentity(ctx, item.ID, item.ObjectKey, metadata.VersionID, metadata.ETag)
}
