package repository

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/basketikun/infinite-canvas/model"
	"github.com/google/uuid"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

const PublicImageImportIntent = "public_image_import"

var ErrPublicImageImportBusy = errors.New("公共图片导入进行中，请稍后重试")
var ErrPublicImageImportMismatch = errors.New("导入请求与原公共图片不一致")
var ErrPublicImageImportExpired = errors.New("公共图片导入已过期，请重新导入")
var ErrPublicImageImportUnavailable = errors.New("公共图片不存在或正在删除")

// Source media is locked before the reservation, in the same order as deletion.
// Registration is committed before any external Copy, so cleanup can find even
// a Copy whose response never reached the application.
func ReservePublicImageImport(ctx context.Context, item model.MediaUploadIntent) (model.MediaUploadIntent, error) {
	db, err := DB()
	if err != nil {
		return item, err
	}
	err = db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var media model.Media
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).First(&media, "id = ?", item.SourceMediaID).Error; err != nil {
			return ErrPublicImageImportUnavailable
		}
		var public model.PublicImage
		if err := tx.First(&public, "id = ? AND media_id = ?", item.SourcePublicImageID, media.ID).Error; err != nil {
			return ErrPublicImageImportUnavailable
		}
		if media.CleanupStatus != model.MediaCleanupActive || media.ObjectKey != item.SourceObjectKey || media.ObjectVersionID != item.SourceVersionID || media.ObjectETag != item.SourceETag {
			return ErrPublicImageImportUnavailable
		}
		if err := tx.Clauses(clause.OnConflict{DoNothing: true}).Create(&item).Error; err != nil {
			return err
		}
		var stored model.MediaUploadIntent
		if err := tx.First(&stored, "id = ?", item.ID).Error; err != nil {
			return err
		}
		if stored.OwnerUID != item.OwnerUID || stored.Intent != PublicImageImportIntent || stored.SourcePublicImageID != item.SourcePublicImageID {
			return ErrPublicImageImportMismatch
		}
		item = stored
		return nil
	})
	return item, err
}

func ClaimPublicImageImport(ctx context.Context, id, owner string, current time.Time) (model.MediaUploadIntent, bool, error) {
	db, err := DB()
	if err != nil {
		return model.MediaUploadIntent{}, false, err
	}
	var item model.MediaUploadIntent
	copyNow := false
	err = db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		// The persisted reservation already protects the source from deletion.
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).First(&item, "id = ? AND owner_uid = ? AND intent = ?", id, owner, PublicImageImportIntent).Error; err != nil {
			return err
		}
		if item.CompletedMediaID != "" {
			return nil
		}
		expiry, err := time.Parse(time.RFC3339Nano, item.ExpiresAt)
		if err != nil || !current.Before(expiry) || strings.HasPrefix(item.FinalizeClaimID, mediaObjectCleanupClaimPrefix) {
			return ErrPublicImageImportExpired
		}
		if item.FinalizeLeaseUntil != nil && item.FinalizeLeaseUntil.After(current) {
			return ErrPublicImageImportBusy
		}
		item.FinalizeClaimID = uuid.NewString()
		until := current.Add(2 * time.Minute)
		item.FinalizeLeaseUntil = &until
		updates := map[string]any{"finalize_claim_id": item.FinalizeClaimID, "finalize_lease_until": until}
		if item.CopyStartedAt == nil {
			copyNow = true
			item.CopyStartedAt = &current
			updates["copy_started_at"] = current
		}
		return tx.Model(&item).Updates(updates).Error
	})
	return item, copyNow, err
}

func PublishPublicImageImport(ctx context.Context, intent model.MediaUploadIntent, item model.Media, current time.Time) (model.Media, error) {
	db, err := DB()
	if err != nil {
		return item, err
	}
	err = db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var locked model.MediaUploadIntent
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).First(&locked, "id = ?", intent.ID).Error; err != nil {
			return err
		}
		result := tx.Model(&model.MediaUploadIntent{}).Where("id = ? AND owner_uid = ? AND intent = ? AND completed_media_id = '' AND finalize_claim_id = ? AND finalize_lease_until > ?", intent.ID, item.OwnerUID, PublicImageImportIntent, intent.FinalizeClaimID, current).Updates(map[string]any{"completed_media_id": item.ID, "completed_at": current.UTC().Format(time.RFC3339Nano), "finalize_lease_until": nil})
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected != 1 {
			return ErrPublicImageImportBusy
		}
		if err := tx.Create(&item).Error; err != nil {
			return err
		}
		return recordMediaLifecycle(tx, item, item.OwnerUID, "created", "", "public_image_imported")
	})
	return item, err
}

func publicImageImportReferenced(tx *gorm.DB, mediaID string, current time.Time) (bool, error) {
	var count int64
	err := tx.Model(&model.MediaUploadIntent{}).Where("intent = ? AND source_media_id = ? AND completed_media_id = '' AND COALESCE(finalize_claim_id, '') NOT LIKE ? AND (expires_at > ? OR finalize_lease_until > ?)", PublicImageImportIntent, mediaID, mediaObjectCleanupClaimPrefix+"%", current.UTC().Format(time.RFC3339Nano), current).Count(&count).Error
	return count > 0, err
}
