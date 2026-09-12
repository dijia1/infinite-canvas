package repository

import (
	"errors"
	"sort"
	"strings"

	"github.com/basketikun/infinite-canvas/model"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

var ErrWorkflowFrameClientOutdated = errors.New("workflow frame client outdated")

func CreateWorkflow(item model.Workflow) (model.Workflow, error) {
	database, err := DB()
	if err != nil {
		return model.Workflow{}, err
	}
	err = database.Transaction(func(tx *gorm.DB) error {
		if err := tx.Create(&item).Error; err != nil {
			return err
		}
		return ReplaceWorkflowMediaRefs(tx, item.OwnerUID, "definition", item.ID, WorkflowGraphMediaIDs(item.Graph))
	})
	if err != nil {
		return model.Workflow{}, err
	}
	return item, nil
}

func GetWorkflow(ownerUID, id string) (model.Workflow, bool, error) {
	database, err := DB()
	if err != nil {
		return model.Workflow{}, false, err
	}
	item := model.Workflow{}
	err = database.Where("owner_uid = ? AND id = ?", ownerUID, id).First(&item).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return model.Workflow{}, false, nil
	}
	return item, err == nil, err
}

func ListWorkflows(ownerUID string, page, pageSize int) ([]model.WorkflowListItem, int64, error) {
	database, err := DB()
	if err != nil {
		return nil, 0, err
	}
	var total int64
	if err := database.Model(&model.Workflow{}).Where("owner_uid = ?", ownerUID).Count(&total).Error; err != nil {
		return nil, 0, err
	}
	items := make([]model.WorkflowListItem, 0)
	err = database.Model(&model.Workflow{}).
		Select("id, name, revision, created_at, updated_at, COALESCE(jsonb_array_length(graph -> 'nodes'), 0) AS node_count, COALESCE(jsonb_array_length(graph -> 'connections'), 0) AS connection_count").
		Where("owner_uid = ?", ownerUID).
		Order("updated_at DESC, id DESC").
		Offset((page - 1) * pageSize).
		Limit(pageSize).
		Scan(&items).Error
	return items, total, err
}

func UpdateWorkflow(ownerUID, id string, revision int, name string, graph model.WorkflowGraph, updatedAt string) (model.Workflow, bool, error) {
	return UpdateWorkflowWithFrameSchema(ownerUID, id, revision, name, graph, nil, updatedAt)
}

func UpdateWorkflowWithFrameSchema(ownerUID, id string, revision int, name string, graph model.WorkflowGraph, frameSchemaVersion *int, updatedAt string) (model.Workflow, bool, error) {
	database, err := DB()
	if err != nil {
		return model.Workflow{}, false, err
	}
	item := model.Workflow{}
	accepted := false
	err = database.Transaction(func(tx *gorm.DB) error {
		existing := model.Workflow{}
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Where("owner_uid = ? AND id = ?", ownerUID, id).First(&existing).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return nil
			}
			return err
		}
		if existing.Revision != revision {
			return nil
		}
		if (len(existing.Graph.Frames) > 0 || len(graph.Frames) > 0) && (frameSchemaVersion == nil || *frameSchemaVersion != 1) {
			return ErrWorkflowFrameClientOutdated
		}
		update := model.Workflow{Name: name, Graph: graph, Revision: revision + 1, UpdatedAt: updatedAt}
		result := tx.Model(&model.Workflow{}).
			Where("owner_uid = ? AND id = ? AND revision = ?", ownerUID, id, revision).
			Select("name", "graph", "revision", "updated_at").
			Updates(update)
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected == 0 {
			return nil
		}
		if err := ReplaceWorkflowMediaRefs(tx, ownerUID, "definition", id, WorkflowGraphMediaIDs(graph)); err != nil {
			return err
		}
		item = model.Workflow{ID: id, OwnerUID: ownerUID, Name: name, Graph: graph, Revision: revision + 1, CreatedAt: existing.CreatedAt, UpdatedAt: updatedAt}
		accepted = true
		return nil
	})
	if err != nil {
		return model.Workflow{}, false, err
	}
	return item, accepted, nil
}

func DeleteWorkflow(ownerUID, id string, revision int) (bool, error) {
	database, err := DB()
	if err != nil {
		return false, err
	}
	deleted := false
	err = database.Transaction(func(tx *gorm.DB) error {
		item := model.Workflow{}
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Where("owner_uid = ? AND id = ?", ownerUID, id).First(&item).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return nil
			}
			return err
		}
		if item.Revision != revision {
			return nil
		}
		if err := ReplaceWorkflowMediaRefs(tx, ownerUID, "definition", id, nil); err != nil {
			return err
		}
		result := tx.Where("owner_uid = ? AND id = ? AND revision = ?", ownerUID, id, revision).Delete(&model.Workflow{})
		if result.Error != nil {
			return result.Error
		}
		deleted = result.RowsAffected == 1
		return nil
	})
	return deleted, err
}

func WorkflowGraphMediaIDs(graph model.WorkflowGraph) []string {
	unique := make(map[string]struct{})
	for _, node := range graph.Nodes {
		id := strings.TrimSpace(node.MediaID)
		if id != "" {
			unique[id] = struct{}{}
		}
	}
	ids := make([]string, 0, len(unique))
	for id := range unique {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return ids
}
