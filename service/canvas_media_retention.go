package service

import (
	"context"
	"log"
	"time"

	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/repository"
)

const canvasMediaCleanupInterval = time.Minute
const canvasMediaCleanupLease = 2 * time.Minute
const canvasMediaDeleteTimeout = 30 * time.Second

func CleanupExpiredCanvasMedia(current time.Time) error {
	return cleanupExpiredCanvasMedia(context.Background(), current, newImageStore)
}

func cleanupExpiredCanvasMedia(ctx context.Context, current time.Time, createStore func() (imageStore, error)) error {
	started := time.Now()
	store, err := createStore()
	if err != nil {
		return err
	}
	afterID := ""
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		items, err := repository.ListExpiredPrivateMediaAfter(current, afterID)
		if err != nil {
			return err
		}
		if len(items) == 0 {
			break
		}
		afterID = items[len(items)-1].ID
		ids := make([]string, 0, len(items))
		for _, candidate := range items {
			ids = append(ids, candidate.ID)
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		claimed, err := repository.ClaimCanvasMediaCleanupBatch(ids, current.Add(time.Since(started)), canvasMediaCleanupLease)
		if err != nil {
			log.Printf("canvas media cleanup batch claim failed: %v", err)
		}
		if err := deleteClaimedCanvasMedia(ctx, store, claimed, func() time.Time { return current.Add(time.Since(started)) }); err != nil {
			return err
		}
	}
	return nil
}

func deleteClaimedCanvasMedia(ctx context.Context, store imageStore, claimed []model.Media, now func() time.Time) error {
	for _, item := range claimed {
		if err := ctx.Err(); err != nil {
			return err
		}
		renewed, err := repository.RenewCanvasMediaCleanupClaim(item.ID, item.CleanupClaimID, now(), canvasMediaCleanupLease)
		if err != nil {
			log.Printf("canvas media cleanup renewal failed media_id=%s: %v", item.ID, err)
			continue
		}
		if !renewed {
			continue
		}
		deleteCtx, cancel := context.WithTimeout(ctx, canvasMediaDeleteTimeout)
		deleted, deleteErr := deleteClaimedMediaObject(deleteCtx, store, item, now())
		err = deleteErr
		cancel()
		if err != nil {
			auditMediaFailure(item, "", "delete_failed", "object_delete_failed")
			log.Printf("canvas media cleanup object delete failed media_id=%s claim_id=%s: %v", item.ID, item.CleanupClaimID, err)
			continue
		}
		if !deleted {
			continue
		}
		if _, err := repository.DeleteClaimedCanvasMedia(item.ID, item.CleanupClaimID); err != nil {
			auditMediaFailure(item, "", "delete_failed", "record_delete_failed")
			log.Printf("canvas media cleanup record delete failed media_id=%s claim_id=%s: %v", item.ID, item.CleanupClaimID, err)
		}
	}
	return nil
}

func StartCanvasMediaRetention(ctx context.Context) func() {
	ctx, cancel := context.WithCancel(ctx)
	if err := cleanupExpiredCanvasMedia(ctx, time.Now(), newImageStore); err != nil {
		log.Printf("canvas media cleanup failed: %v", err)
	}
	go func() {
		ticker := time.NewTicker(canvasMediaCleanupInterval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if err := cleanupExpiredCanvasMedia(ctx, time.Now(), newImageStore); err != nil {
					log.Printf("canvas media cleanup failed: %v", err)
				}
			}
		}
	}()
	return cancel
}
