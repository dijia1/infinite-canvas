package repository

import (
	"context"
	"errors"
	"sort"

	"github.com/basketikun/infinite-canvas/model"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

var ErrCanvasSaveRequestMismatch = errors.New("canvas save request does not match its original payload")

var errCanvasProjectRevisionConflict = errors.New("canvas project revision condition was not accepted")

func CreateCanvasProject(item model.CanvasProject, contexts ...context.Context) (model.CanvasProject, bool, error) {
	database, err := DB()
	if err != nil {
		return model.CanvasProject{}, false, err
	}
	if len(contexts) > 0 {
		database = database.WithContext(contexts[0])
	}
	created := item
	inserted := false
	err = database.Transaction(func(tx *gorm.DB) error {
		result := tx.Clauses(clause.OnConflict{Columns: []clause.Column{{Name: "id"}, {Name: "owner_uid"}}, DoNothing: true}).Create(&item)
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected == 0 {
			return tx.Where("id = ? AND owner_uid = ?", item.ID, item.OwnerUID).First(&created).Error
		}
		change, err := newCanvasMediaChange(item.OwnerUID, item.ID, nil, item.Document)
		if err != nil {
			return err
		}
		if err := applyCanvasMediaChanges(tx, []canvasMediaChange{change}); err != nil {
			return err
		}
		created, inserted = item, true
		return nil
	})
	if err != nil {
		return model.CanvasProject{}, false, err
	}
	return created, inserted, nil
}

// ImportCanvasProjects inserts a complete legacy batch atomically. Existing
// projects belonging to the same owner are returned unchanged, making retries
// safe without allowing imports to overwrite newer server snapshots.
func ImportCanvasProjects(items []model.CanvasProject) ([]model.CanvasProject, error) {
	database, err := DB()
	if err != nil {
		return nil, err
	}
	resultItems := make([]model.CanvasProject, len(items))
	// Preserve response order while obtaining project locks in a stable order.
	order := make([]int, len(items))
	for index := range items {
		order[index] = index
	}
	sort.Slice(order, func(i, j int) bool {
		a, b := items[order[i]], items[order[j]]
		if a.ID == b.ID {
			return a.OwnerUID < b.OwnerUID
		}
		return a.ID < b.ID
	})
	err = database.Transaction(func(tx *gorm.DB) error {
		changes := make([]canvasMediaChange, 0, len(items))
		for _, index := range order {
			item := items[index]
			result := tx.Clauses(clause.OnConflict{Columns: []clause.Column{{Name: "id"}, {Name: "owner_uid"}}, DoNothing: true}).Create(&item)
			if result.Error != nil {
				return result.Error
			}
			if result.RowsAffected == 0 {
				if err := tx.Where("id = ? AND owner_uid = ?", item.ID, item.OwnerUID).First(&resultItems[index]).Error; err != nil {
					return err
				}
				continue
			}
			resultItems[index] = item
			change, err := newCanvasMediaChange(item.OwnerUID, item.ID, nil, item.Document)
			if err != nil {
				return err
			}
			changes = append(changes, change)
		}
		return applyCanvasMediaChanges(tx, changes)
	})
	if err != nil {
		return nil, err
	}
	return resultItems, nil
}

func GetCanvasProject(ownerUID, id string) (model.CanvasProject, bool, error) {
	database, err := DB()
	if err != nil {
		return model.CanvasProject{}, false, err
	}
	item := model.CanvasProject{}
	err = database.Where("id = ? AND owner_uid = ?", id, ownerUID).First(&item).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return model.CanvasProject{}, false, nil
	}
	return item, err == nil, err
}

func GetCanvasSaveRequest(requestID string) (model.CanvasSaveRequest, bool, error) {
	database, err := DB()
	if err != nil {
		return model.CanvasSaveRequest{}, false, err
	}
	item := model.CanvasSaveRequest{}
	result := database.Where("request_id = ?", requestID).Limit(1).Find(&item)
	return item, result.RowsAffected != 0, result.Error
}

func ListCanvasProjects(ownerUID string) ([]model.CanvasSummary, error) {
	database, err := DB()
	if err != nil {
		return nil, err
	}
	items := make([]model.CanvasSummary, 0)
	// OFFSET 0 prevents PostgreSQL from inlining the JSON cast into each CASE
	// branch, while keeping parsed documents out of a materialized result set.
	err = database.Model(&model.CanvasProject{}).
		Select("canvas_projects.id, canvas_projects.title, canvas_projects.revision, canvas_projects.created_at, canvas_projects.updated_at, CASE WHEN jsonb_typeof(parsed.document -> 'nodes') = 'array' THEN jsonb_array_length(parsed.document -> 'nodes') ELSE 0 END AS node_count, CASE WHEN jsonb_typeof(parsed.document -> 'connections') = 'array' THEN jsonb_array_length(parsed.document -> 'connections') ELSE 0 END AS connection_count").
		Joins("CROSS JOIN LATERAL (SELECT canvas_projects.document::jsonb AS document OFFSET 0) AS parsed").
		Where("canvas_projects.owner_uid = ?", ownerUID).
		Order("canvas_projects.updated_at desc").
		Scan(&items).Error
	return items, err
}

func UpdateCanvasProject(ownerUID, id string, revision int, title string, document []byte, updatedAt string) (model.CanvasProject, bool, error) {
	database, err := DB()
	if err != nil {
		return model.CanvasProject{}, false, err
	}
	var item model.CanvasProject
	accepted := false
	err = database.Transaction(func(tx *gorm.DB) error {
		var existing model.CanvasProject
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Where("id = ? AND owner_uid = ?", id, ownerUID).First(&existing).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return nil
			}
			return err
		}
		if existing.Revision != revision {
			return nil
		}
		change, err := newCanvasMediaChange(ownerUID, id, existing.Document, document)
		if err != nil {
			return err
		}
		if err := tx.Model(&model.CanvasProject{}).Where("id = ? AND owner_uid = ?", id, ownerUID).Updates(map[string]any{"title": title, "document": document, "revision": revision + 1, "updated_at": updatedAt}).Error; err != nil {
			return err
		}
		if err := applyCanvasMediaChanges(tx, []canvasMediaChange{change}); err != nil {
			return err
		}
		item = model.CanvasProject{ID: id, OwnerUID: ownerUID, Title: title, Document: model.CanvasProjectDocument(append([]byte(nil), document...)), Revision: revision + 1, CreatedAt: existing.CreatedAt, UpdatedAt: updatedAt}
		accepted = true
		return nil
	})
	if err != nil {
		return model.CanvasProject{}, false, err
	}
	return item, accepted, nil
}

// UpdateCanvasProjectIdempotently atomically claims a request ID before the
// revision update. A retry with the same verified payload returns the snapshot
// accepted by the first request without writing a second revision.
func UpdateCanvasProjectIdempotently(ownerUID, id string, revision int, title string, document []byte, updatedAt, requestID, payloadHash string) (model.CanvasProject, bool, bool, error) {
	database, err := DB()
	if err != nil {
		return model.CanvasProject{}, false, false, err
	}

	var item model.CanvasProject
	accepted := false
	deduplicated := false
	err = database.Transaction(func(transaction *gorm.DB) error {
		request := model.CanvasSaveRequest{
			RequestID:    requestID,
			ProjectID:    id,
			UserUID:      ownerUID,
			BaseRevision: revision,
			PayloadHash:  payloadHash,
			CreatedAt:    updatedAt,
		}
		claim := transaction.Clauses(clause.OnConflict{DoNothing: true}).Create(&request)
		if claim.Error != nil {
			return claim.Error
		}
		if claim.RowsAffected == 0 {
			existingRequest := model.CanvasSaveRequest{}
			if err := transaction.Where("request_id = ?", requestID).First(&existingRequest).Error; err != nil {
				return err
			}
			if existingRequest.ProjectID != id || existingRequest.UserUID != ownerUID || existingRequest.BaseRevision != revision || existingRequest.PayloadHash != payloadHash {
				return ErrCanvasSaveRequestMismatch
			}
			item = model.CanvasProject{
				ID:        id,
				OwnerUID:  ownerUID,
				Title:     title,
				Document:  model.CanvasProjectDocument(append([]byte(nil), document...)),
				Revision:  existingRequest.ResultRevision,
				CreatedAt: existingRequest.ResultCreatedAt,
				UpdatedAt: existingRequest.ResultUpdatedAt,
			}
			accepted = true
			deduplicated = true
			return nil
		}

		existing := model.CanvasProject{}
		if err := transaction.Clauses(clause.Locking{Strength: "UPDATE"}).Where("id = ? AND owner_uid = ?", id, ownerUID).First(&existing).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return errCanvasProjectRevisionConflict
			}
			return err
		}
		if existing.Revision != revision {
			return errCanvasProjectRevisionConflict
		}
		change, err := newCanvasMediaChange(ownerUID, id, existing.Document, document)
		if err != nil {
			return err
		}
		result := transaction.Model(&model.CanvasProject{}).
			Where("id = ? AND owner_uid = ? AND revision = ?", id, ownerUID, revision).
			Updates(map[string]any{
				"title":      title,
				"document":   document,
				"revision":   gorm.Expr("revision + ?", 1),
				"updated_at": updatedAt,
			})
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected == 0 {
			return errCanvasProjectRevisionConflict
		}
		if err := applyCanvasMediaChanges(transaction, []canvasMediaChange{change}); err != nil {
			return err
		}
		if err := transaction.Model(&model.CanvasSaveRequest{}).Where("request_id = ?", requestID).Updates(map[string]any{
			"result_revision":   revision + 1,
			"result_created_at": existing.CreatedAt,
			"result_updated_at": updatedAt,
		}).Error; err != nil {
			return err
		}
		item = model.CanvasProject{
			ID:        id,
			OwnerUID:  ownerUID,
			Title:     title,
			Document:  model.CanvasProjectDocument(append([]byte(nil), document...)),
			Revision:  revision + 1,
			CreatedAt: existing.CreatedAt,
			UpdatedAt: updatedAt,
		}
		accepted = true
		return nil
	})
	if errors.Is(err, errCanvasProjectRevisionConflict) {
		return model.CanvasProject{}, false, false, nil
	}
	if err != nil {
		return model.CanvasProject{}, false, false, err
	}
	return item, accepted, deduplicated, nil
}

func DeleteCanvasSaveRequestsBefore(timestamp string) error {
	database, err := DB()
	if err != nil {
		return err
	}
	return database.Where("created_at < ?", timestamp).Delete(&model.CanvasSaveRequest{}).Error
}

func DeleteCanvasProject(ownerUID, id string, revision int) (bool, error) {
	database, err := DB()
	if err != nil {
		return false, err
	}
	deleted := false
	err = database.Transaction(func(tx *gorm.DB) error {
		var item model.CanvasProject
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Where("id = ? AND owner_uid = ? AND revision = ?", id, ownerUID, revision).First(&item).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return nil
			}
			return err
		}
		ids, err := CanvasDocumentMediaIDs(item.Document)
		if err != nil {
			return err
		}
		if err := tx.Delete(&item).Error; err != nil {
			return err
		}
		for mediaID := range ids {
			if err := recordMediaLifecycle(tx, model.Media{ID: mediaID}, ownerUID, "reference_removed", id, "canvas_deleted"); err != nil {
				return err
			}
		}
		deleted = true
		return nil
	})
	return deleted, err
}
