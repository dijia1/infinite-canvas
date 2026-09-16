package repository

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/basketikun/infinite-canvas/model"
	"github.com/google/uuid"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

func SaveMedia(item model.Media, contexts ...context.Context) (model.Media, error) {
	db, err := DB()
	if err != nil {
		return model.Media{}, err
	}
	if len(contexts) > 0 {
		db = db.WithContext(contexts[0])
	}
	err = db.Transaction(func(tx *gorm.DB) error {
		if err := completeMediaObjectReservation(tx, item); err != nil {
			return err
		}
		if err := tx.Create(&item).Error; err != nil {
			return err
		}
		return recordMediaLifecycle(tx, item, item.OwnerUID, "created", "", "resource_created")
	})
	return item, err
}

func GetMedia(id string) (model.Media, bool, error) {
	db, err := DB()
	if err != nil {
		return model.Media{}, false, err
	}
	item := model.Media{}
	err = db.First(&item, "id = ?", id).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return model.Media{}, false, nil
	}
	return item, err == nil, err
}

func DeleteMedia(id string, contexts ...context.Context) error {
	db, err := DB()
	if err != nil {
		return err
	}
	if len(contexts) > 0 {
		db = db.WithContext(contexts[0])
	}
	return db.Transaction(func(tx *gorm.DB) error {
		var item model.Media
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).First(&item, "id = ?", id).Error; err != nil {
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
		return recordMediaLifecycle(tx, item, "", "deleted", "", "resource_removed")
	})
}

type PrivateMediaKind string

const (
	PrivateMediaKindImage PrivateMediaKind = "image"
	PrivateMediaKindVideo PrivateMediaKind = "video"
)

func ListPrivateMedia(ownerUID string, kind PrivateMediaKind) ([]model.Media, error) {
	db, err := DB()
	if err != nil {
		return nil, err
	}
	items := make([]model.Media, 0)
	query := db.Where("owner_uid = ?", ownerUID)
	switch kind {
	case PrivateMediaKindImage:
		query = query.Where("content_type NOT LIKE ?", "video/%")
	case PrivateMediaKindVideo:
		query = query.Where("content_type LIKE ?", "video/%")
	default:
		return nil, fmt.Errorf("invalid private media kind")
	}
	err = query.
		Where("cleanup_status = ?", model.MediaCleanupActive).
		Where("expires_at IS NULL").
		Where("NOT EXISTS (SELECT 1 FROM public_images WHERE public_images.media_id = media.id)").
		Order("created_at desc").
		Find(&items).Error
	return items, err
}

func mediaExpiryEqual(current, target *time.Time) bool {
	if current == nil || target == nil {
		return current == nil && target == nil
	}
	// pgx persists timestamps at microsecond precision, regardless of location.
	return current.Truncate(time.Microsecond).Equal(target.Truncate(time.Microsecond))
}

func SetPrivateMediaExpiry(id, ownerUID string, expiresAt *time.Time) (bool, error) {
	// Match PostgreSQL/pgx timestamp precision before comparing with a stored value.
	if expiresAt != nil {
		normalized := expiresAt.UTC().Truncate(time.Microsecond)
		expiresAt = &normalized
	}
	db, err := DB()
	if err != nil {
		return false, err
	}
	updated := false
	err = db.Transaction(func(tx *gorm.DB) error {
		var item model.Media
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Where("id = ? AND owner_uid = ? AND cleanup_status = ?", id, ownerUID, model.MediaCleanupActive).First(&item).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return nil
			}
			return err
		}
		if mediaExpiryEqual(item.ExpiresAt, expiresAt) {
			updated = true
			return nil
		}
		if err := tx.Model(&model.Media{}).Where("id = ?", item.ID).Update("expires_at", expiresAt).Error; err != nil {
			return err
		}
		if (item.ExpiresAt == nil && expiresAt != nil) || (item.ExpiresAt != nil && expiresAt == nil) || (item.ExpiresAt != nil && expiresAt != nil && !item.ExpiresAt.Equal(*expiresAt)) {
			event := "cleanup_scheduled"
			if expiresAt == nil {
				event = "cleanup_cancelled"
			}
			item.ExpiresAt = expiresAt
			if err := recordMediaLifecycle(tx, item, ownerUID, event, "", "retention_changed"); err != nil {
				return err
			}
		}
		updated = true
		return nil
	})
	return updated, err
}

func ListExpiredPrivateMedia(before time.Time) ([]model.Media, error) {
	return ListExpiredPrivateMediaAfter(before, "")
}

func ListExpiredPrivateMediaAfter(before time.Time, afterID string) ([]model.Media, error) {
	db, err := DB()
	if err != nil {
		return nil, err
	}
	items := make([]model.Media, 0)
	err = db.Where("(cleanup_status = ? AND expires_at IS NOT NULL AND expires_at <= ?) OR (cleanup_status = ? AND (cleanup_lease_until IS NULL OR cleanup_lease_until <= ?))",
		model.MediaCleanupActive, before.UTC(), model.MediaCleanupDeleting, before.UTC()).Where("id > ?", afterID).Order("id asc").Limit(100).Find(&items).Error
	return items, err
}

func PromoteLegacyCanvasTemporaryMedia() (int64, error) {
	db, err := DB()
	if err != nil {
		return 0, err
	}
	result := db.Model(&model.Media{}).
		Where("source = ?", "canvas_temporary").
		Where("cleanup_status = ?", model.MediaCleanupActive).
		Updates(map[string]any{"source": model.MediaSourceUpload, "expires_at": nil})
	return result.RowsAffected, result.Error
}

func UpdatePrivateMedia(id, ownerUID string, title *string, folderID *string) (model.Media, bool, error) {
	db, err := DB()
	if err != nil {
		return model.Media{}, false, err
	}
	updates := map[string]any{}
	if title != nil {
		updates["title"] = *title
	}
	if folderID != nil {
		updates["folder_id"] = *folderID
	}
	if len(updates) == 0 {
		return model.Media{}, false, nil
	}
	var updated model.Media
	found := false
	err = db.Transaction(func(tx *gorm.DB) error {
		if folderID != nil && *folderID != "" {
			var folder model.PrivateFolder
			if err := tx.Clauses(clause.Locking{Strength: "KEY SHARE"}).Select("id").First(&folder, "id = ? AND owner_uid = ?", *folderID, ownerUID).Error; err != nil {
				if errors.Is(err, gorm.ErrRecordNotFound) {
					return ErrPrivateFolderNotFound
				}
				return err
			}
		}
		result := tx.Model(&model.Media{}).Where("id = ? AND owner_uid = ? AND cleanup_status = ?", id, ownerUID, model.MediaCleanupActive).Updates(updates)
		if result.Error != nil || result.RowsAffected == 0 {
			return result.Error
		}
		if err := tx.First(&updated, "id = ? AND owner_uid = ?", id, ownerUID).Error; err != nil {
			return err
		}
		found = true
		return nil
	})
	return updated, found, err
}

// ClaimCanvasMediaCleanup shares the media row lock with Canvas writes. A lease
// only assigns a deletion attempt; expiry never makes deleting media usable.
func ClaimCanvasMediaCleanup(id string, current time.Time, lease time.Duration) (model.Media, bool, error) {
	items, err := ClaimCanvasMediaCleanupBatch([]string{id}, current, lease)
	if err != nil || len(items) == 0 {
		return model.Media{}, false, err
	}
	return items[0], true, nil
}

// Lock the entire batch before reading references. Canvas writers use the same
// sorted media locks, so a shared owner snapshot stays valid until commit.
func ClaimCanvasMediaCleanupBatch(ids []string, current time.Time, lease time.Duration) ([]model.Media, error) {
	if len(ids) == 0 {
		return nil, nil
	}
	db, err := DB()
	if err != nil {
		return nil, err
	}
	var claimed []model.Media
	var referenceErrors []error
	err = db.Transaction(func(tx *gorm.DB) error {
		var items []model.Media
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Where("id IN ?", ids).Order("id").Find(&items).Error; err != nil {
			return err
		}
		eligible := items[:0]
		for _, item := range items {
			if item.CleanupStatus == model.MediaCleanupActive && item.ExpiresAt != nil && !item.ExpiresAt.After(current) ||
				item.CleanupStatus == model.MediaCleanupDeleting && (item.CleanupLeaseUntil == nil || !item.CleanupLeaseUntil.After(current)) {
				eligible = append(eligible, item)
			}
		}
		if len(eligible) == 0 {
			return nil
		}
		eligibleIDs := make([]string, 0, len(eligible))
		for _, item := range eligible {
			eligibleIDs = append(eligibleIDs, item.ID)
		}
		var publicItems []model.PublicImage
		if err := tx.Select("media_id").Where("media_id IN ?", eligibleIDs).Find(&publicItems).Error; err != nil {
			return err
		}
		public := make(map[string]bool, len(publicItems))
		for _, item := range publicItems {
			public[item.MediaID] = true
		}
		references := make(map[string]map[string]struct{})
		invalidOwners := make(map[string]error)
		for _, item := range eligible {
			if invalidOwners[item.OwnerUID] != nil {
				continue
			}
			referenced := public[item.ID]
			if !referenced {
				preparing, err := imageTaskPreparingMediaReferenced(tx, item.ID)
				if err != nil {
					return err
				}
				referenced = preparing
			}
			workflowHeld, err := workflowMediaReferenced(tx, item.ID)
			if err != nil {
				return err
			}
			referenced = referenced || workflowHeld
			if !referenced {
				held, err := videoTaskReferences(tx, item.ID, current)
				if held {
					continue
				}
				if err != nil {
					return err
				}
			}
			if !referenced {
				refs, loaded := references[item.OwnerUID]
				if !loaded {
					var err error
					refs, err = canvasMediaReferences(tx, item.OwnerUID)
					if err != nil {
						if !errors.Is(err, ErrCanvasMediaInvalidDocument) {
							return err
						}
						invalidOwners[item.OwnerUID] = err
						referenceErrors = append(referenceErrors, fmt.Errorf("owner %s: %w", item.OwnerUID, err))
						continue
					}
					references[item.OwnerUID] = refs
				}
				_, referenced = refs[item.ID]
			}
			if referenced {
				if item.CleanupStatus == model.MediaCleanupDeleting {
					return errors.New("deleting media has a persisted reference")
				}
				if err := tx.Model(&model.Media{}).Where("id = ?", item.ID).Update("expires_at", nil).Error; err != nil {
					return err
				}
				item.ExpiresAt = nil
				if err := recordMediaLifecycle(tx, item, "", "cleanup_cancelled", "", "persisted_reference_found"); err != nil {
					return err
				}
				continue
			}
			started := current.UTC()
			until := started.Add(lease)
			if item.CleanupStartedAt == nil {
				item.CleanupStartedAt = &started
			}
			item.CleanupStatus = model.MediaCleanupDeleting
			item.CleanupClaimID = uuid.NewString()
			item.CleanupLeaseUntil = &until
			if err := tx.Model(&model.Media{}).Where("id = ?", item.ID).Updates(map[string]any{
				"cleanup_status": item.CleanupStatus, "cleanup_started_at": item.CleanupStartedAt,
				"cleanup_claim_id": item.CleanupClaimID, "cleanup_lease_until": item.CleanupLeaseUntil,
			}).Error; err != nil {
				return err
			}
			if err := recordMediaLifecycle(tx, item, "", "cleanup_started", "", "expired_unreferenced_resource"); err != nil {
				return err
			}
			claimed = append(claimed, item)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return claimed, errors.Join(referenceErrors...)
}

// Renew only the same deleting claim. An expired lease may be resumed until a
// competing worker replaces its token; the conditional update fences that race.
func RenewCanvasMediaCleanupClaim(id, claimID string, current time.Time, lease time.Duration) (bool, error) {
	if claimID == "" {
		return false, nil
	}
	db, err := DB()
	if err != nil {
		return false, err
	}
	result := db.Model(&model.Media{}).Where("id = ? AND cleanup_status = ? AND cleanup_claim_id = ?", id, model.MediaCleanupDeleting, claimID).Update("cleanup_lease_until", current.UTC().Add(lease))
	return result.RowsAffected > 0, result.Error
}

func DeleteClaimedCanvasMedia(id, claimID string) (bool, error) {
	if claimID == "" {
		return false, nil
	}
	db, err := DB()
	if err != nil {
		return false, err
	}
	deleted := false
	err = db.Transaction(func(tx *gorm.DB) error {
		var item model.Media
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Where("id = ? AND cleanup_status = ? AND cleanup_claim_id = ?", id, model.MediaCleanupDeleting, claimID).First(&item).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return nil
			}
			return err
		}
		if err := tx.Where("id = ? AND cleanup_status = ? AND cleanup_claim_id = ?", id, model.MediaCleanupDeleting, claimID).Delete(&model.Media{}).Error; err != nil {
			return err
		}
		if err := recordMediaLifecycle(tx, item, "", "deleted", "", "object_and_record_deleted"); err != nil {
			return err
		}
		deleted = true
		return nil
	})
	return deleted, err
}

// PreparePrivateMediaDeletion uses the same lock as Canvas/task creation so a
// direct delete cannot race a newly submitted video reference.
func PreparePrivateMediaDeletion(id, ownerUID string, current time.Time) (model.Media, error) {
	db, err := DB()
	if err != nil {
		return model.Media{}, err
	}
	var item model.Media
	err = db.Transaction(func(tx *gorm.DB) error {
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Where("id = ? AND owner_uid = ?", id, ownerUID).First(&item).Error; err != nil {
			return err
		}
		if item.CleanupStatus == model.MediaCleanupDeleting {
			return ErrCanvasMediaUnavailable
		}
		preparing, err := imageTaskPreparingMediaReferenced(tx, item.ID)
		if err != nil {
			return err
		}
		if preparing {
			return errors.New("素材正在被图片任务准备使用")
		}
		workflowHeld, err := workflowMediaReferenced(tx, id)
		if err != nil {
			return err
		}
		if workflowHeld {
			return errors.New("素材正在被自动化流程或运行记录使用")
		}
		held, err := videoTaskReferences(tx, id, current)
		if err != nil {
			return err
		}
		if held {
			return errors.New("素材正在被视频任务使用")
		}
		refs, err := canvasMediaReferences(tx, item.OwnerUID)
		if err != nil {
			return err
		}
		if _, held := refs[id]; held {
			return errors.New("素材正在被画布使用")
		}
		until := current.Add(2 * time.Minute)
		item.CleanupStatus = model.MediaCleanupDeleting
		item.CleanupStartedAt = &current
		item.CleanupLeaseUntil = &until
		item.CleanupClaimID = uuid.NewString()
		if err := tx.Model(&item).Updates(map[string]any{"cleanup_status": item.CleanupStatus, "cleanup_started_at": current, "cleanup_lease_until": until, "cleanup_claim_id": item.CleanupClaimID}).Error; err != nil {
			return err
		}
		return recordMediaLifecycle(tx, item, ownerUID, "delete_requested", "", "manual_private_delete")
	})
	return item, err
}

func imageTaskPreparingMediaReferenced(tx *gorm.DB, mediaID string) (bool, error) {
	var count int64
	err := tx.Model(&model.ImageGenerationTaskInput{}).
		Joins("JOIN image_generation_tasks ON image_generation_tasks.id = image_generation_task_inputs.task_id").
		Where("image_generation_task_inputs.source_media_id = ? AND image_generation_tasks.status = ?", mediaID, model.ImageTaskPreparing).
		Count(&count).Error
	return count > 0, err
}

// BindMediaObjectIdentity fills a legacy identity once. A concurrent winner is
// returned so every caller uses the same version, rather than its own HEAD.
func BindMediaObjectIdentity(ctx context.Context, id, key, version, etag string) (model.Media, error) {
	db, err := DB()
	if err != nil {
		return model.Media{}, err
	}
	if version == "" || etag == "" {
		return model.Media{}, errors.New("media object identity is incomplete")
	}
	result := db.WithContext(ctx).Model(&model.Media{}).
		Where("id = ? AND object_key = ? AND cleanup_status = ?", id, key, model.MediaCleanupActive).
		Where("(object_version_id IS NULL OR object_version_id = '' OR object_version_id = ?) AND (object_etag IS NULL OR object_etag = '' OR object_etag = ?)", version, etag).
		Updates(map[string]any{"object_version_id": version, "object_etag": etag})
	if result.Error != nil {
		return model.Media{}, result.Error
	}
	var item model.Media
	if err := db.WithContext(ctx).First(&item, "id = ?", id).Error; err != nil {
		return model.Media{}, err
	}
	if item.ObjectKey != key || item.CleanupStatus != model.MediaCleanupActive || item.ObjectVersionID == "" || item.ObjectETag == "" {
		return model.Media{}, ErrCanvasMediaUnavailable
	}
	return item, nil
}
