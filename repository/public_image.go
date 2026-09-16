package repository

import (
	"errors"
	"github.com/google/uuid"
	"gorm.io/gorm/clause"
	"time"

	"github.com/basketikun/infinite-canvas/model"
	"gorm.io/gorm"
)

func SavePublicImage(item model.PublicImage) (model.PublicImage, error) {
	db, err := DB()
	if err != nil {
		return model.PublicImage{}, err
	}
	return item, db.Create(&item).Error
}

func GetPublicImage(id string) (model.PublicImage, bool, error) {
	db, err := DB()
	if err != nil {
		return model.PublicImage{}, false, err
	}
	item := model.PublicImage{}
	err = db.Preload("Media").First(&item, "id = ?", id).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return model.PublicImage{}, false, nil
	}
	return item, err == nil, err
}

func GetPublicImageByMediaID(mediaID string) (model.PublicImage, bool, error) {
	db, err := DB()
	if err != nil {
		return model.PublicImage{}, false, err
	}
	item := model.PublicImage{}
	err = db.First(&item, "media_id = ?", mediaID).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return model.PublicImage{}, false, nil
	}
	return item, err == nil, err
}

func ListPublicImages(q model.Query) ([]model.PublicImage, int64, error) {
	db, err := DB()
	if err != nil {
		return nil, 0, err
	}
	q.Normalize()
	tx := db.Model(&model.PublicImage{})
	if q.FolderID != "" {
		tx = tx.Where("folder_id = ?", q.FolderID)
	} else {
		tx = tx.Where("folder_id = ? OR folder_id IS NULL", "")
	}
	if q.Keyword != "" {
		tx = tx.Where("title LIKE ?", "%"+q.Keyword+"%")
	}
	var total int64
	if err := tx.Count(&total).Error; err != nil {
		return nil, 0, err
	}
	items := make([]model.PublicImage, 0)
	err = tx.Preload("Media").Order("created_at desc").Offset(q.Offset()).Limit(q.PageSize).Find(&items).Error
	return items, total, err
}

func UpdatePublicImage(id string, title *string, folderID *string) (model.PublicImage, bool, error) {
	db, err := DB()
	if err != nil {
		return model.PublicImage{}, false, err
	}
	updates := map[string]any{}
	if title != nil {
		updates["title"] = *title
	}
	if folderID != nil {
		updates["folder_id"] = *folderID
	}
	if err := db.Model(&model.PublicImage{}).Where("id = ?", id).Updates(updates).Error; err != nil {
		return model.PublicImage{}, false, err
	}
	return GetPublicImage(id)
}

func DeletePublicImageAndMedia(publicImageID, mediaID string) error {
	db, err := DB()
	if err != nil {
		return err
	}
	return db.Transaction(func(tx *gorm.DB) error {
		if err := tx.Delete(&model.PublicImage{}, "id = ?", publicImageID).Error; err != nil {
			return err
		}
		var item model.Media
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).First(&item, "id = ?", mediaID).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return nil
			}
			return err
		}
		held, err := workflowMediaReferenced(tx, item.ID)
		if err != nil {
			return err
		}
		if held {
			return errors.New("素材正在被自动化流程或运行记录使用")
		}
		if err := tx.Delete(&item).Error; err != nil {
			return err
		}
		return recordMediaLifecycle(tx, item, "", "deleted", "", "public_resource_removed")
	})
}

// Remove public discoverability under the media lock before external deletion.
// Active video tasks keep their input even when an administrator deletes it.
func PreparePublicImageDeletion(publicID string, current time.Time, actorUID ...string) (model.Media, error) {
	db, err := DB()
	if err != nil {
		return model.Media{}, err
	}
	var media model.Media
	err = db.Transaction(func(tx *gorm.DB) error {
		var public model.PublicImage
		if err := tx.First(&public, "id = ?", publicID).Error; err != nil {
			return err
		}
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).First(&media, "id = ?", public.MediaID).Error; err != nil {
			return err
		}
		preparing, err := imageTaskPreparingMediaReferenced(tx, media.ID)
		if err != nil {
			return err
		}
		if preparing {
			return errors.New("素材正在被图片任务准备使用")
		}
		workflowHeld, err := workflowMediaReferenced(tx, media.ID)
		if err != nil {
			return err
		}
		if workflowHeld {
			return errors.New("素材正在被自动化流程或运行记录使用")
		}
		held, err := videoTaskReferences(tx, media.ID, current)
		if err != nil {
			return err
		}
		if held {
			return errors.New("素材正在被视频任务使用")
		}
		media.CleanupStatus = model.MediaCleanupDeleting
		media.CleanupClaimID = uuid.NewString()
		until := current.Add(2 * time.Minute)
		if err := tx.Model(&media).Updates(map[string]any{"cleanup_status": model.MediaCleanupDeleting, "cleanup_claim_id": media.CleanupClaimID, "cleanup_started_at": current, "cleanup_lease_until": until}).Error; err != nil {
			return err
		}
		if err := tx.Delete(&public).Error; err != nil {
			return err
		}
		actor := ""
		if len(actorUID) > 0 {
			actor = actorUID[0]
		}
		return recordMediaLifecycle(tx, media, actor, "delete_requested", "", "manual_public_delete")
	})
	return media, err
}
