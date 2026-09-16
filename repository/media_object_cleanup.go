package repository

import (
	"context"
	"errors"
	"github.com/basketikun/infinite-canvas/model"
	"github.com/google/uuid"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
	"strings"
	"time"
)

const InternalMediaUploadIntent = "internal"
const mediaObjectCleanupRecheck = 24 * time.Hour
const mediaObjectCleanupClaimPrefix = "cleanup:"

// Called in the publication transaction, before inserting media. Cleanup closes
// this same reservation first, so a late publisher cannot resurrect a deleted key.
func completeMediaObjectReservation(tx *gorm.DB, item model.Media) error {
	var intent model.MediaUploadIntent
	err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Where("object_key = ?", item.ObjectKey).First(&intent).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil
	}
	if err != nil {
		return err
	}
	if strings.HasPrefix(intent.FinalizeClaimID, mediaObjectCleanupClaimPrefix) {
		return errors.New("media object reservation is closed")
	}
	if intent.Intent != InternalMediaUploadIntent {
		return nil
	}
	return tx.Model(&intent).Updates(map[string]any{"completed_media_id": item.ID, "completed_at": time.Now().UTC().Format(time.RFC3339Nano)}).Error
}

// Media row first, then its upload intent: the same order as the cleanup claim.
// A still-valid browser PUT URL delays physical deletion, while the deleting
// media remains hidden. The intent survives record deletion for a later sweep.
func BeginMediaObjectDeletion(ctx context.Context, item model.Media, current time.Time) (bool, error) {
	db, err := DB()
	if err != nil {
		return false, err
	}
	ready := false
	err = db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var media model.Media
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Where("id = ? AND cleanup_status = ? AND cleanup_claim_id = ?", item.ID, model.MediaCleanupDeleting, item.CleanupClaimID).First(&media).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return nil
			}
			return err
		}
		var intent model.MediaUploadIntent
		err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Where("object_key = ?", item.ObjectKey).First(&intent).Error
		if errors.Is(err, gorm.ErrRecordNotFound) {
			intent = model.MediaUploadIntent{ID: "media-cleanup-" + uuid.NewString(), OwnerUID: media.OwnerUID, ObjectKey: media.ObjectKey, Intent: InternalMediaUploadIntent, ExpiresAt: current.UTC().Format(time.RFC3339Nano), CreatedAt: current.UTC().Format(time.RFC3339Nano), CompletedMediaID: media.ID}
			if err = tx.Create(&intent).Error; err != nil {
				return err
			}
		} else if err != nil {
			return err
		}
		expiry, err := time.Parse(time.RFC3339Nano, intent.ExpiresAt)
		if err != nil {
			return err
		}
		if intent.Intent != InternalMediaUploadIntent && expiry.After(current) {
			return nil
		}
		updates := map[string]any{"finalize_claim_id": mediaObjectCleanupClaimPrefix + uuid.NewString()}
		// Start the recheck window when a published server-written object is removed.
		if !strings.HasPrefix(intent.FinalizeClaimID, mediaObjectCleanupClaimPrefix) && intent.Intent == InternalMediaUploadIntent {
			updates["expires_at"] = current.UTC().Format(time.RFC3339Nano)
		}
		if err = tx.Model(&intent).Updates(updates).Error; err != nil {
			return err
		}
		ready = true
		return nil
	})
	return ready, err
}

func ListMediaUploadCleanupCandidates(current time.Time, after string) ([]model.MediaUploadIntent, error) {
	db, err := DB()
	if err != nil {
		return nil, err
	}
	var items []model.MediaUploadIntent
	err = db.Where("expires_at <= ? AND id > ? AND (finalize_lease_until IS NULL OR finalize_lease_until <= ?)", current.UTC().Format(time.RFC3339Nano), after, current).Order("id").Limit(100).Find(&items).Error
	return items, err
}

// Return only unowned keys. Finalizers cannot publish after this transaction
// closes the intent. No transaction is held during external storage deletion.
func ClaimMediaUploadCleanup(ctx context.Context, id string, current time.Time) (model.MediaUploadIntent, []string, bool, error) {
	db, err := DB()
	if err != nil {
		return model.MediaUploadIntent{}, nil, false, err
	}
	var intent model.MediaUploadIntent
	var keys []string
	keep := false
	err = db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := tx.First(&intent, "id = ?", id).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				intent = model.MediaUploadIntent{}
				return nil
			}
			return err
		}
		objectKeys := []string{intent.ObjectKey}
		if intent.FinalObjectKey != "" {
			objectKeys = append(objectKeys, intent.FinalObjectKey)
		}
		var media []model.Media
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Where("object_key IN ?", objectKeys).Order("id").Find(&media).Error; err != nil {
			return err
		}
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).First(&intent, "id = ?", id).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				intent = model.MediaUploadIntent{}
				return nil
			}
			return err
		}
		expiry, err := time.Parse(time.RFC3339Nano, intent.ExpiresAt)
		if err != nil {
			return err
		}
		if expiry.After(current) || (intent.FinalizeLeaseUntil != nil && intent.FinalizeLeaseUntil.After(current)) {
			intent = model.MediaUploadIntent{}
			return nil
		}
		// The final key and publication may have changed while waiting for the lock.
		objectKeys = []string{intent.ObjectKey}
		if intent.FinalObjectKey != "" {
			objectKeys = append(objectKeys, intent.FinalObjectKey)
		}
		if err := tx.Where("object_key IN ?", objectKeys).Find(&media).Error; err != nil {
			return err
		}
		protected := map[string]bool{}
		for _, m := range media {
			protected[m.ObjectKey] = true
			if m.CleanupStatus == model.MediaCleanupDeleting {
				keep = true
			}
		}
		for _, key := range objectKeys {
			if key != "" && !protected[key] {
				keys = append(keys, key)
			}
		}
		intent.FinalizeClaimID = mediaObjectCleanupClaimPrefix + uuid.NewString()
		until := current.Add(2 * time.Minute)
		intent.FinalizeLeaseUntil = &until
		return tx.Model(&intent).Updates(map[string]any{"finalize_claim_id": intent.FinalizeClaimID, "finalize_lease_until": until}).Error
	})
	return intent, keys, keep, err
}

func FinishMediaUploadCleanup(ctx context.Context, intent model.MediaUploadIntent, current time.Time, keep bool) error {
	db, err := DB()
	if err != nil {
		return err
	}
	expiry, err := time.Parse(time.RFC3339Nano, intent.ExpiresAt)
	if err != nil {
		return err
	}
	query := db.WithContext(ctx).Where("id = ? AND finalize_claim_id = ?", intent.ID, intent.FinalizeClaimID)
	if !keep && !current.Before(expiry.Add(mediaObjectCleanupRecheck)) {
		return query.Delete(&model.MediaUploadIntent{}).Error
	}
	return query.Model(&model.MediaUploadIntent{}).Update("finalize_lease_until", nil).Error
}

func ScheduleReservedObjectCleanup(ctx context.Context, key string, current time.Time) (string, error) {
	db, err := DB()
	if err != nil {
		return "", err
	}
	var intent model.MediaUploadIntent
	if err = db.WithContext(ctx).Where("object_key = ?", key).First(&intent).Error; err != nil {
		return "", err
	}
	// Force only unpublished internal reservations due now. A committed media row
	// is protected again by ClaimMediaUploadCleanup, including an ambiguous COMMIT.
	if intent.Intent == InternalMediaUploadIntent && intent.CompletedMediaID == "" {
		err = db.WithContext(ctx).Model(&model.MediaUploadIntent{}).Where("id = ? AND completed_media_id = '' AND COALESCE(finalize_claim_id, '') NOT LIKE ?", intent.ID, mediaObjectCleanupClaimPrefix+"%").Update("expires_at", current.UTC().Format(time.RFC3339Nano)).Error
	}
	return intent.ID, err
}

func UpdateMediaUploadSignedExpiry(id string, expiry time.Time) error {
	db, err := DB()
	if err != nil {
		return err
	}
	return db.Model(&model.MediaUploadIntent{}).Where("id = ? AND completed_media_id = ''", id).Update("expires_at", expiry.UTC().Format(time.RFC3339Nano)).Error
}
