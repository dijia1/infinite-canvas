package repository

import (
	"errors"
	"sort"
	"time"

	"github.com/basketikun/infinite-canvas/model"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// ReplaceWorkflowMediaRefs must run inside the owning definition/run transaction,
// after locking that parent. Sorted media locks serialize against deletion claims.
func ReplaceWorkflowMediaRefs(tx *gorm.DB, ownerUID, scope, scopeID string, mediaIDs []string) error {
	if ownerUID == "" || scopeID == "" || (scope != "definition" && scope != "run") {
		return errors.New("invalid workflow media reference owner")
	}
	var previous []model.WorkflowMediaRef
	if err := tx.Where("owner_uid = ? AND scope = ? AND scope_id = ?", ownerUID, scope, scopeID).Find(&previous).Error; err != nil {
		return err
	}
	next, all := map[string]bool{}, map[string]bool{}
	for _, id := range mediaIDs {
		if id == "" {
			return ErrCanvasMediaUnavailable
		}
		next[id] = true
		all[id] = true
	}
	before := map[string]bool{}
	for _, ref := range previous {
		all[ref.MediaID] = true
		before[ref.MediaID] = true
	}
	if len(all) == 0 {
		return nil
	}
	ids := make([]string, 0, len(all))
	for id := range all {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	var items []model.Media
	if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Where("id IN ?", ids).Order("id").Find(&items).Error; err != nil {
		return err
	}
	byID := map[string]model.Media{}
	for _, item := range items {
		byID[item.ID] = item
	}
	var public []model.PublicImage
	if err := tx.Where("media_id IN ?", ids).Find(&public).Error; err != nil {
		return err
	}
	isPublic := map[string]bool{}
	for _, item := range public {
		isPublic[item.MediaID] = true
	}
	for id := range next {
		item, ok := byID[id]
		if !ok || item.CleanupStatus != model.MediaCleanupActive || (item.OwnerUID != ownerUID && !isPublic[id]) {
			return ErrCanvasMediaUnavailable
		}
	}
	if err := tx.Where("owner_uid = ? AND scope = ? AND scope_id = ?", ownerUID, scope, scopeID).Delete(&model.WorkflowMediaRef{}).Error; err != nil {
		return err
	}
	for _, id := range ids {
		if next[id] {
			ref := model.WorkflowMediaRef{OwnerUID: ownerUID, Scope: scope, ScopeID: scopeID, MediaID: id}
			if err := tx.Create(&ref).Error; err != nil {
				return err
			}
		}
	}
	for _, id := range ids {
		item, exists := byID[id]
		if !exists {
			continue
		}
		if before[id] != next[id] {
			event := "reference_removed"
			if next[id] {
				event = "reference_added"
			}
			if err := recordMediaLifecycle(tx, item, ownerUID, event, scopeID, "workflow_"+scope); err != nil {
				return err
			}
		}
		if item.CleanupStatus != model.MediaCleanupActive {
			continue
		}
		var expiry *time.Time
		if !next[id] && !isPublic[id] {
			held, err := workflowMediaReferenced(tx, id)
			if err != nil {
				return err
			}
			refs, err := canvasMediaReferences(tx, item.OwnerUID)
			if err != nil {
				return err
			}
			_, canvasHeld := refs[id]
			taskHeld, err := videoTaskReferences(tx, id, time.Now().UTC())
			if err != nil {
				return err
			}
			if !held && !canvasHeld && !taskHeld {
				deadline := time.Now().UTC().Add(canvasMediaCleanupDelay)
				expiry = &deadline
			}
		}
		if mediaExpiryEqual(item.ExpiresAt, expiry) {
			continue
		}
		if err := tx.Model(&model.Media{}).Where("id = ?", id).Update("expires_at", expiry).Error; err != nil {
			return err
		}
	}
	return nil
}

func workflowMediaReferenced(tx *gorm.DB, mediaID string) (bool, error) {
	var count int64
	err := tx.Model(&model.WorkflowMediaRef{}).Where("media_id = ?", mediaID).Count(&count).Error
	return count > 0, err
}
