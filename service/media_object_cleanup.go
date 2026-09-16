package service

import (
	"context"
	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/repository"
	"log"
	"time"
)

func reserveMediaObject(ctx context.Context, owner, key string) error {
	current := time.Now().UTC()
	return repository.SaveMediaUploadIntent(model.MediaUploadIntent{ID: newID("object-reservation"), OwnerUID: owner, ObjectKey: key, Intent: repository.InternalMediaUploadIntent, ExpiresAt: current.Add(24 * time.Hour).Format(time.RFC3339Nano), CreatedAt: current.Format(time.RFC3339Nano)})
}

func deleteClaimedMediaObject(ctx context.Context, store imageStore, item model.Media, current time.Time) (bool, error) {
	if _, versioned := store.(interface {
		DeleteObjectVersions(context.Context, string) error
	}); versioned {
		ready, err := repository.BeginMediaObjectDeletion(ctx, item, current)
		if err != nil || !ready {
			return false, err
		}
	}
	if err := deleteImageObject(ctx, store, item.ObjectKey); err != nil {
		return false, err
	}
	return true, nil
}

func cleanupMediaUploadIntent(ctx context.Context, store imageStore, id string, current time.Time) error {
	intent, keys, keep, err := repository.ClaimMediaUploadCleanup(ctx, id, current)
	if err != nil || intent.ID == "" {
		return err
	}
	for _, key := range keys {
		if err := deleteImageObject(ctx, store, key); err != nil {
			return err
		}
	}
	return repository.FinishMediaUploadCleanup(ctx, intent, current, keep)
}

func cleanupReservedMediaObject(ctx context.Context, store imageStore, key string) {
	cleanupCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 30*time.Second)
	defer cancel()
	current := time.Now().UTC()
	id, err := repository.ScheduleReservedObjectCleanup(cleanupCtx, key, current)
	if err == nil {
		err = cleanupMediaUploadIntent(cleanupCtx, store, id, current)
	}
	if err != nil {
		log.Printf("unpublished media cleanup deferred reservation_id=%s: %v", id, err)
	}
}
