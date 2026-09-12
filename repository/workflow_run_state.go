package repository

import (
	"database/sql"
	"errors"

	"github.com/basketikun/infinite-canvas/model"
	"gorm.io/gorm"
)

type WorkflowRunStateRecord struct {
	Workflow     model.Workflow
	LatestRuns   map[string]model.WorkflowRun
	ActiveRunIDs map[string]string
	NodeRunIDs   map[string]string
	ActiveRuns   []model.WorkflowRun
	ActiveTotal  int64
}

func workflowRunScopeKey(scopeType model.WorkflowRunScopeType, frameID string) string {
	if normalizeWorkflowRunScopeType(scopeType) != model.WorkflowRunScopeFrame {
		frameID = ""
	}
	return string(normalizeWorkflowRunScopeType(scopeType)) + "\x00" + frameID
}

func GetWorkflowRunState(ownerUID, workflowID string, page, pageSize int) (WorkflowRunStateRecord, error) {
	database, err := DB()
	if err != nil {
		return WorkflowRunStateRecord{}, err
	}
	record := WorkflowRunStateRecord{LatestRuns: map[string]model.WorkflowRun{}, ActiveRunIDs: map[string]string{}, NodeRunIDs: map[string]string{}, ActiveRuns: []model.WorkflowRun{}}
	err = database.Transaction(func(tx *gorm.DB) error {
		if err := tx.Where("owner_uid = ? AND id = ?", ownerUID, workflowID).First(&record.Workflow).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return ErrWorkflowRunNotFound
			}
			return err
		}
		latest := []model.WorkflowRun{}
		if err := tx.Raw(`SELECT DISTINCT ON (scope_type, frame_id) id, owner_uid, request_id, workflow_id, revision, title, scope_type, frame_id, frame_name, status, state_version, stop_requested, created_at, updated_at, finished_at
			FROM workflow_runs WHERE owner_uid = ? AND workflow_id = ?
			ORDER BY scope_type, frame_id, created_at DESC, id DESC`, ownerUID, workflowID).Scan(&latest).Error; err != nil {
			return err
		}
		for _, run := range latest {
			canonicalizeWorkflowRunScope(&run)
			key := workflowRunScopeKey(run.ScopeType, run.FrameID)
			existing, found := record.LatestRuns[key]
			if !found || run.CreatedAt.After(existing.CreatedAt) || run.CreatedAt.Equal(existing.CreatedAt) && run.ID > existing.ID {
				record.LatestRuns[key] = run
			}
		}
		active := []model.WorkflowRun{}
		if err := tx.Omit("snapshot").Where("owner_uid = ? AND workflow_id = ? AND status IN ?", ownerUID, workflowID, workflowActiveStatuses()).Order("created_at DESC, id DESC").Find(&active).Error; err != nil {
			return err
		}
		record.ActiveTotal = int64(len(active))
		for _, run := range active {
			canonicalizeWorkflowRunScope(&run)
			key := workflowRunScopeKey(run.ScopeType, run.FrameID)
			if record.ActiveRunIDs[key] == "" {
				record.ActiveRunIDs[key] = run.ID
			}
		}
		for index := range active {
			canonicalizeWorkflowRunScope(&active[index])
		}
		start := (page - 1) * pageSize
		if start < len(active) {
			end := start + pageSize
			if end > len(active) {
				end = len(active)
			}
			record.ActiveRuns = append(record.ActiveRuns, active[start:end]...)
		}
		type nodeRun struct {
			NodeID string
			RunID  string
		}
		rows := []nodeRun{}
		if err := tx.Raw(`SELECT DISTINCT ON (step.node_id) step.node_id, run.id AS run_id
			FROM workflow_step_executions AS step JOIN workflow_runs AS run ON run.id = step.run_id
			WHERE run.owner_uid = ? AND run.workflow_id = ?
			ORDER BY step.node_id, run.created_at DESC, run.id DESC`, ownerUID, workflowID).Scan(&rows).Error; err != nil {
			return err
		}
		for _, row := range rows {
			record.NodeRunIDs[row.NodeID] = row.RunID
		}
		return nil
	}, &sql.TxOptions{Isolation: sql.LevelRepeatableRead, ReadOnly: true})
	return record, err
}
