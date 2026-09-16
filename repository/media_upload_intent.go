package repository

import (
	"errors"
	"github.com/google/uuid"
	"gorm.io/gorm/clause"
	"time"

	"github.com/basketikun/infinite-canvas/model"
	"gorm.io/gorm"
)

func SaveMediaUploadIntent(item model.MediaUploadIntent) error {
	database, err := DB()
	if err != nil {
		return err
	}
	return database.Create(&item).Error
}

func GetMediaUploadIntentForOwner(id, ownerUID string) (model.MediaUploadIntent, bool, error) {
	database, err := DB()
	if err != nil {
		return model.MediaUploadIntent{}, false, err
	}
	item := model.MediaUploadIntent{}
	err = database.Where("id = ? AND owner_uid = ?", id, ownerUID).First(&item).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return model.MediaUploadIntent{}, false, nil
	}
	return item, err == nil, err
}

// FinalizeMediaUploadIntent claims an intent and creates its media record in
// the same transaction. A retry returns the media created by the first call.
func FinalizeMediaUploadIntent(id, ownerUID, completedAt string, media model.Media, claimID ...string) (model.MediaUploadIntent, model.Media, bool, error) {
	database, err := DB()
	if err != nil {
		return model.MediaUploadIntent{}, model.Media{}, false, err
	}
	intent := model.MediaUploadIntent{}
	resultMedia := model.Media{}
	created := false
	err = database.Transaction(func(transaction *gorm.DB) error {
		query := transaction.Model(&model.MediaUploadIntent{}).Where("intent <> ? AND COALESCE(finalize_claim_id, '') NOT LIKE ?", InternalMediaUploadIntent, mediaObjectCleanupClaimPrefix+"%")
		if len(claimID) > 0 && claimID[0] != "" {
			query = query.Where("finalize_claim_id = ? AND finalize_lease_until > ?", claimID[0], completedAt)
		}
		result := query.Where("id = ? AND owner_uid = ? AND completed_media_id = '' AND expires_at > ?", id, ownerUID, completedAt).
			Updates(map[string]any{"completed_media_id": media.ID, "completed_at": completedAt})
		if result.Error != nil {
			return result.Error
		}
		if err := transaction.Where("id = ? AND owner_uid = ?", id, ownerUID).First(&intent).Error; err != nil {
			return err
		}
		if result.RowsAffected == 0 {
			if intent.CompletedMediaID == "" {
				return nil
			}
			if err := transaction.First(&resultMedia, "id = ?", intent.CompletedMediaID).Error; err != nil {
				return err
			}
			return nil
		}
		if err := transaction.Create(&media).Error; err != nil {
			return err
		}
		if err := recordMediaLifecycle(transaction, media, ownerUID, "created", "", "upload_completed"); err != nil {
			return err
		}
		resultMedia = media
		created = true
		return nil
	})
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return model.MediaUploadIntent{}, model.Media{}, false, nil
	}
	return intent, resultMedia, created, err
}

func ListExpiredUncompletedMediaUploadIntents(before string) ([]model.MediaUploadIntent, error) {
	database, err := DB()
	if err != nil {
		return nil, err
	}
	items := make([]model.MediaUploadIntent, 0)
	err = database.Where("expires_at < ? AND completed_media_id = '' AND (finalize_lease_until IS NULL OR finalize_lease_until <= ?)", before, before).Order("expires_at asc").Find(&items).Error
	return items, err
}

func DeleteMediaUploadIntent(id string) error {
	database, err := DB()
	if err != nil {
		return err
	}
	return database.Delete(&model.MediaUploadIntent{}, "id = ?", id).Error
}

func DeleteCompletedMediaUploadIntentsBefore(before string) error {
	database, err := DB()
	if err != nil {
		return err
	}
	return database.Where("completed_media_id <> '' AND completed_at < ?", before).Delete(&model.MediaUploadIntent{}).Error
}

func ListExpiredVideoUploadIntents(before string) ([]model.MediaUploadIntent, error) {
	database, err := DB()
	if err != nil {
		return nil, err
	}
	var items []model.MediaUploadIntent
	err = database.Where("content_type = ? AND completed_media_id <> '' AND expires_at < ?", "video/mp4", before).Find(&items).Error
	return items, err
}

// A single leased publisher owns the immutable final object. Reservation is
// durable before PUT so expired/incomplete intents can clean both objects.
func ClaimVideoUploadCompletion(id, owner, key string, current time.Time) (model.MediaUploadIntent, error) {
	db, err := DB()
	if err != nil {
		return model.MediaUploadIntent{}, err
	}
	var item model.MediaUploadIntent
	err = db.Transaction(func(tx *gorm.DB) error {
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Where("id = ? AND owner_uid = ?", id, owner).First(&item).Error; err != nil {
			return err
		}
		if item.CompletedMediaID != "" {
			return nil
		}
		expiry, err := time.Parse(time.RFC3339Nano, item.ExpiresAt)
		if err != nil || !current.Before(expiry) {
			return errors.New("上传确认已过期")
		}
		if item.FinalizeLeaseUntil != nil && item.FinalizeLeaseUntil.After(current) {
			return errors.New("上传确认进行中，请稍后重试")
		}
		if item.FinalObjectKey == "" {
			item.FinalObjectKey = key
		}
		item.FinalizeClaimID = uuid.NewString()
		until := current.Add(2 * time.Minute)
		item.FinalizeLeaseUntil = &until
		return tx.Model(&item).Updates(map[string]any{"final_object_key": item.FinalObjectKey, "finalize_claim_id": item.FinalizeClaimID, "finalize_lease_until": until}).Error
	})
	return item, err
}
