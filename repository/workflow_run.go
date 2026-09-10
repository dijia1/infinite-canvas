package repository

import (
	"errors"
	"time"

	"github.com/basketikun/infinite-canvas/model"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

var (
	ErrWorkflowRunNotFound = errors.New("workflow run not found")
	ErrWorkflowRunActive   = errors.New("workflow run is active")
	ErrWorkflowLeaseLost   = errors.New("workflow attempt lease lost")
	ErrWorkflowRunStale    = errors.New("workflow run evaluation is stale")
)

const workflowSchedulerAdvisoryLock int64 = 0x776f726b666c6f77

type WorkflowRunRecord struct {
	Run      model.WorkflowRun
	Steps    []model.WorkflowStepExecution
	Outputs  []model.WorkflowOutputExecution
	Attempts []model.WorkflowOutputAttempt
}

func CreateWorkflowRun(run model.WorkflowRun, steps []model.WorkflowStepExecution, outputs []model.WorkflowOutputExecution, mediaIDs []string) (model.WorkflowRun, bool, error) {
	database, err := DB()
	if err != nil {
		return model.WorkflowRun{}, false, err
	}
	inserted := false
	err = database.Transaction(func(tx *gorm.DB) error {
		result := tx.Clauses(clause.OnConflict{Columns: []clause.Column{{Name: "owner_uid"}, {Name: "request_id"}}, DoNothing: true}).Create(&run)
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected == 0 {
			existing := model.WorkflowRun{}
			if err := tx.Where("owner_uid = ? AND request_id = ?", run.OwnerUID, run.RequestID).First(&existing).Error; err != nil {
				return err
			}
			run = existing
			return nil
		}
		inserted = true
		if len(steps) > 0 {
			if err := tx.Create(&steps).Error; err != nil {
				return err
			}
		}
		if len(outputs) > 0 {
			if err := tx.Create(&outputs).Error; err != nil {
				return err
			}
		}
		return ReplaceWorkflowMediaRefs(tx, run.OwnerUID, "run", run.ID, mediaIDs)
	})
	return run, inserted, err
}

func GetWorkflowRun(ownerUID, id string) (WorkflowRunRecord, bool, error) {
	database, err := DB()
	if err != nil {
		return WorkflowRunRecord{}, false, err
	}
	record := WorkflowRunRecord{}
	result := database.Where("owner_uid = ? AND id = ?", ownerUID, id).Limit(1).Find(&record.Run)
	if result.Error != nil || result.RowsAffected == 0 {
		return record, false, result.Error
	}
	if err := database.Where("run_id = ?", id).Order("node_id").Find(&record.Steps).Error; err != nil {
		return record, false, err
	}
	if err := database.Where("run_id = ?", id).Order("node_id, slot_id").Find(&record.Outputs).Error; err != nil {
		return record, false, err
	}
	if err := database.Where("run_id = ?", id).Order("created_at, id").Find(&record.Attempts).Error; err != nil {
		return record, false, err
	}
	return record, true, nil
}

func GetWorkflowRunByRequest(ownerUID, requestID string) (model.WorkflowRun, bool, error) {
	database, err := DB()
	if err != nil {
		return model.WorkflowRun{}, false, err
	}
	item := model.WorkflowRun{}
	result := database.Where("owner_uid = ? AND request_id = ?", ownerUID, requestID).Limit(1).Find(&item)
	return item, result.RowsAffected > 0, result.Error
}

func ListWorkflowRuns(ownerUID, workflowID string, page, pageSize int) ([]model.WorkflowRun, int64, error) {
	database, err := DB()
	if err != nil {
		return nil, 0, err
	}
	query := database.Model(&model.WorkflowRun{}).Where("owner_uid = ?", ownerUID)
	if workflowID != "" {
		query = query.Where("workflow_id = ?", workflowID)
	}
	var total int64
	if err := query.Count(&total).Error; err != nil {
		return nil, 0, err
	}
	items := []model.WorkflowRun{}
	err = query.Omit("snapshot").Order("created_at DESC, id DESC").Offset((page - 1) * pageSize).Limit(pageSize).Find(&items).Error
	return items, total, err
}

func ListOpenWorkflowRuns(afterID string, limit int) ([]model.WorkflowRun, error) {
	database, err := DB()
	if err != nil {
		return nil, err
	}
	items := []model.WorkflowRun{}
	query := database.Where("status IN ?", []string{"pending", "running", "stopping", "attention_required"})
	if afterID != "" {
		query = query.Where("id > ?", afterID)
	}
	err = query.Order("id").Limit(limit).Find(&items).Error
	return items, err
}

func UpdateWorkflowEvaluation(runID string, expectedStateVersion int64, outputUpdates []model.WorkflowOutputExecution, stepUpdates []model.WorkflowStepExecution, status string, finishedAt *time.Time, current time.Time) error {
	database, err := DB()
	if err != nil {
		return err
	}
	return database.Transaction(func(tx *gorm.DB) error {
		var run model.WorkflowRun
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Where("id = ?", runID).First(&run).Error; err != nil {
			return err
		}
		if run.StateVersion != expectedStateVersion {
			return ErrWorkflowRunStale
		}
		for _, output := range outputUpdates {
			updates := map[string]any{"status": output.Status, "error": output.Error, "updated_at": current}
			if err := tx.Model(&model.WorkflowOutputExecution{}).
				Where("run_id = ? AND node_id = ? AND slot_id = ? AND status IN ?", output.RunID, output.NodeID, output.SlotID, []string{"waiting", "ready", "blocked"}).
				Updates(updates).Error; err != nil {
				return err
			}
		}
		for _, step := range stepUpdates {
			if err := tx.Model(&model.WorkflowStepExecution{}).Where("run_id = ? AND node_id = ?", step.RunID, step.NodeID).
				Updates(map[string]any{"status": step.Status, "error": step.Error}).Error; err != nil {
				return err
			}
		}
		updates := map[string]any{"status": status, "updated_at": current, "finished_at": finishedAt, "state_version": gorm.Expr("state_version + 1")}
		return tx.Model(&model.WorkflowRun{}).Where("id = ? AND status IN ?", runID, []string{"pending", "running", "stopping", "attention_required"}).Updates(updates).Error
	})
}

// ClaimWorkflowAttempt serializes capacity acquisition across service instances.
// Existing due attempts do not consume new capacity; a ready output does.
func ClaimWorkflowAttempt(globalLimit, runLimit int, allowNew bool, current time.Time, lease time.Duration) (model.WorkflowOutputAttempt, bool, error) {
	database, err := DB()
	if err != nil {
		return model.WorkflowOutputAttempt{}, false, err
	}
	claimed := model.WorkflowOutputAttempt{}
	found := false
	err = database.Transaction(func(tx *gorm.DB) error {
		if err := tx.Exec("SELECT pg_advisory_xact_lock(?)", workflowSchedulerAdvisoryLock).Error; err != nil {
			return err
		}
		var due model.WorkflowOutputAttempt
		dueResult := tx.Clauses(clause.Locking{Strength: "UPDATE", Options: "SKIP LOCKED"}).
			Where("status IN ? AND next_poll_at <= ? AND (lease_until IS NULL OR lease_until < ?)", []string{"claimed", "submitting", "running", "uncertain"}, current, current).
			Order("next_poll_at, created_at, id").Limit(1).Find(&due)
		if dueResult.Error != nil {
			return dueResult.Error
		}
		if dueResult.RowsAffected > 0 {
			claimID := workflowClaimID()
			leaseUntil := current.Add(lease)
			result := tx.Model(&model.WorkflowOutputAttempt{}).Where("id = ? AND (lease_until IS NULL OR lease_until < ?)", due.ID, current).
				Updates(map[string]any{"claim_id": claimID, "lease_until": leaseUntil, "updated_at": current})
			if result.Error != nil {
				return result.Error
			}
			if result.RowsAffected == 1 {
				due.ClaimID, due.LeaseUntil = claimID, &leaseUntil
				claimed, found = due, true
			}
			return nil
		}
		if !allowNew {
			return nil
		}

		var active int64
		if err := tx.Model(&model.WorkflowOutputAttempt{}).Where("status IN ?", []string{"claimed", "submitting", "running", "uncertain"}).Count(&active).Error; err != nil {
			return err
		}
		if int(active) >= globalLimit {
			return nil
		}
		var output model.WorkflowOutputExecution
		result := tx.Raw(`
			SELECT output.* FROM workflow_output_executions output
			JOIN workflow_runs run ON run.id = output.run_id
			WHERE output.status = 'ready'
			  AND run.stop_requested = false
			  AND run.status IN ('pending','running','attention_required')
			  AND (SELECT COUNT(*) FROM workflow_output_attempts attempt
			       WHERE attempt.run_id = output.run_id AND attempt.status IN ('claimed','submitting','running','uncertain')) < ?
			ORDER BY run.created_at, output.node_id, output.slot_id
			FOR UPDATE OF output, run SKIP LOCKED LIMIT 1`, runLimit).Scan(&output)
		if result.Error != nil || output.RunID == "" {
			return result.Error
		}
		claimID := workflowClaimID()
		leaseUntil := current.Add(lease)
		queuedAt := output.UpdatedAt
		attempt := model.WorkflowOutputAttempt{
			ID: workflowAttemptID(), RunID: output.RunID, NodeID: output.NodeID, SlotID: output.SlotID,
			Attempt: output.Attempt, RequestID: workflowAttemptRequestID(output.RunID, output.NodeID, output.SlotID, output.Attempt),
			RetryRequestID: output.RetryRequestID,
			Status:         "claimed", ClaimID: claimID, LeaseUntil: &leaseUntil, NextPollAt: current,
			QueuedAt: &queuedAt, CreatedAt: current, UpdatedAt: current,
		}
		var run model.WorkflowRun
		if err := tx.Where("id = ?", output.RunID).First(&run).Error; err != nil {
			return err
		}
		attempt.OwnerUID = run.OwnerUID
		if err := tx.Create(&attempt).Error; err != nil {
			return err
		}
		result = tx.Model(&model.WorkflowOutputExecution{}).Where("run_id = ? AND node_id = ? AND slot_id = ? AND status = 'ready'", output.RunID, output.NodeID, output.SlotID).
			Updates(map[string]any{"status": "submitting", "updated_at": current})
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected != 1 {
			return gorm.ErrRecordNotFound
		}
		if err := tx.Model(&model.WorkflowRun{}).Where("id = ?", output.RunID).Updates(map[string]any{"updated_at": current, "state_version": gorm.Expr("state_version + 1")}).Error; err != nil {
			return err
		}
		claimed, found = attempt, true
		return nil
	})
	return claimed, found, err
}

func UpdateClaimedWorkflowAttempt(item model.WorkflowOutputAttempt, outputStatus string, nextPollAt time.Time, terminal bool) error {
	database, err := DB()
	if err != nil {
		return err
	}
	current := time.Now().UTC()
	return database.Transaction(func(tx *gorm.DB) error {
		var run model.WorkflowRun
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Where("id = ?", item.RunID).First(&run).Error; err != nil {
			return err
		}
		updates := map[string]any{
			"task_type": item.TaskType, "task_id": item.TaskID, "status": item.Status, "error": item.Error,
			"media_id": item.MediaID, "next_poll_at": nextPollAt, "updated_at": current,
			"claim_id": "", "lease_until": nil,
		}
		if terminal {
			updates["finished_at"] = current
		}
		result := tx.Model(&model.WorkflowOutputAttempt{}).Where("id = ? AND claim_id = ? AND lease_until > ?", item.ID, item.ClaimID, current).Updates(updates)
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected != 1 {
			return ErrWorkflowLeaseLost
		}
		outputUpdates := map[string]any{"status": outputStatus, "error": item.Error, "updated_at": current}
		if terminal && item.Status == "succeeded" {
			outputUpdates["media_id"] = item.MediaID
		}
		outputResult := tx.Model(&model.WorkflowOutputExecution{}).
			Where("run_id = ? AND node_id = ? AND slot_id = ? AND attempt = ? AND status IN ?", item.RunID, item.NodeID, item.SlotID, item.Attempt, []string{"submitting", "running", "uncertain"}).
			Updates(outputUpdates)
		if outputResult.Error != nil {
			return outputResult.Error
		}
		if outputResult.RowsAffected != 1 {
			return ErrWorkflowLeaseLost
		}
		return tx.Model(&model.WorkflowRun{}).Where("id = ?", item.RunID).Updates(map[string]any{"updated_at": current, "state_version": gorm.Expr("state_version + 1")}).Error
	})
}

// AuthorizeWorkflowAttemptSubmission is the durable Stop boundary. Once it
// returns true the local generation task may be created or recovered even if a
// Stop request arrives immediately afterwards.
func AuthorizeWorkflowAttemptSubmission(item model.WorkflowOutputAttempt, allowSubmission bool, current time.Time) (bool, error) {
	database, err := DB()
	if err != nil {
		return false, err
	}
	authorized := false
	err = database.Transaction(func(tx *gorm.DB) error {
		var run model.WorkflowRun
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Where("id = ?", item.RunID).First(&run).Error; err != nil {
			return err
		}
		if run.StopRequested {
			updates := map[string]any{"status": "stopped", "error": "运行已停止", "claim_id": "", "lease_until": nil, "finished_at": current, "updated_at": current}
			result := tx.Model(&model.WorkflowOutputAttempt{}).Where("id = ? AND claim_id = ? AND lease_until > ? AND status = 'claimed'", item.ID, item.ClaimID, current).Updates(updates)
			if result.Error != nil || result.RowsAffected != 1 {
				if result.Error != nil {
					return result.Error
				}
				return ErrWorkflowLeaseLost
			}
			if err := tx.Model(&model.WorkflowOutputExecution{}).Where("run_id = ? AND node_id = ? AND slot_id = ? AND attempt = ?", item.RunID, item.NodeID, item.SlotID, item.Attempt).
				Updates(map[string]any{"status": "stopped", "error": "运行已停止", "updated_at": current}).Error; err != nil {
				return err
			}
			return tx.Model(&model.WorkflowRun{}).Where("id = ?", item.RunID).Updates(map[string]any{"updated_at": current, "state_version": gorm.Expr("state_version + 1")}).Error
		}
		if !allowSubmission {
			result := tx.Model(&model.WorkflowOutputAttempt{}).Where("id = ? AND claim_id = ? AND lease_until > ? AND status = 'claimed'", item.ID, item.ClaimID, current).
				Updates(map[string]any{"claim_id": "", "lease_until": nil, "next_poll_at": current.Add(5 * time.Second), "updated_at": current})
			if result.Error != nil {
				return result.Error
			}
			if result.RowsAffected != 1 {
				return ErrWorkflowLeaseLost
			}
			return nil
		}
		result := tx.Model(&model.WorkflowOutputAttempt{}).Where("id = ? AND claim_id = ? AND lease_until > ? AND status = 'claimed'", item.ID, item.ClaimID, current).
			Updates(map[string]any{"status": "submitting", "started_at": gorm.Expr("COALESCE(started_at, ?)", current), "updated_at": current})
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected != 1 {
			return ErrWorkflowLeaseLost
		}
		authorized = true
		return tx.Model(&model.WorkflowRun{}).Where("id = ?", item.RunID).Updates(map[string]any{"updated_at": current, "state_version": gorm.Expr("state_version + 1")}).Error
	})
	return authorized, err
}

func RequestWorkflowRunStop(ownerUID, id string, current time.Time) (bool, error) {
	database, err := DB()
	if err != nil {
		return false, err
	}
	result := database.Model(&model.WorkflowRun{}).Where("owner_uid = ? AND id = ? AND status IN ?", ownerUID, id, []string{"pending", "running", "attention_required", "stopping"}).
		Updates(map[string]any{"stop_requested": true, "status": "stopping", "updated_at": current, "state_version": gorm.Expr("state_version + 1")})
	return result.RowsAffected > 0, result.Error
}

func RetryWorkflowOutput(ownerUID, runID, nodeID, slotID, retryRequestID string, current time.Time) (model.WorkflowOutputExecution, error) {
	database, err := DB()
	if err != nil {
		return model.WorkflowOutputExecution{}, err
	}
	output := model.WorkflowOutputExecution{}
	err = database.Transaction(func(tx *gorm.DB) error {
		var run model.WorkflowRun
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Where("owner_uid = ? AND id = ?", ownerUID, runID).First(&run).Error; err != nil {
			return ErrWorkflowRunNotFound
		}
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Where("run_id = ? AND node_id = ? AND slot_id = ?", runID, nodeID, slotID).First(&output).Error; err != nil {
			return err
		}
		if output.RetryRequestID == retryRequestID {
			return nil
		}
		var priorRetry int64
		if err := tx.Model(&model.WorkflowOutputAttempt{}).
			Where("run_id = ? AND node_id = ? AND slot_id = ? AND retry_request_id = ?", runID, nodeID, slotID, retryRequestID).
			Count(&priorRetry).Error; err != nil {
			return err
		}
		if priorRetry > 0 {
			return nil
		}
		if run.StopRequested || run.Status == "stopped" {
			return ErrWorkflowRunActive
		}
		if output.Status != "failed" {
			return ErrWorkflowRunActive
		}
		output.Attempt++
		output.Status, output.Error, output.MediaID, output.RetryRequestID, output.UpdatedAt = "waiting", "", "", retryRequestID, current
		if err := tx.Save(&output).Error; err != nil {
			return err
		}
		return tx.Model(&model.WorkflowRun{}).Where("id = ?", runID).Updates(map[string]any{"status": "running", "finished_at": nil, "updated_at": current, "state_version": gorm.Expr("state_version + 1")}).Error
	})
	return output, err
}

func DeleteWorkflowRun(ownerUID, id string) error {
	database, err := DB()
	if err != nil {
		return err
	}
	return database.Transaction(func(tx *gorm.DB) error {
		var run model.WorkflowRun
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Where("owner_uid = ? AND id = ?", ownerUID, id).First(&run).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return ErrWorkflowRunNotFound
			}
			return err
		}
		if run.Status == "pending" || run.Status == "running" || run.Status == "stopping" || run.Status == "attention_required" {
			return ErrWorkflowRunActive
		}
		if err := ReplaceWorkflowMediaRefs(tx, ownerUID, "run", id, nil); err != nil {
			return err
		}
		for _, target := range []any{&model.WorkflowOutputAttempt{}, &model.WorkflowOutputExecution{}, &model.WorkflowStepExecution{}} {
			if err := tx.Where("run_id = ?", id).Delete(target).Error; err != nil {
				return err
			}
		}
		return tx.Delete(&run).Error
	})
}

func workflowClaimID() string   { return "workflow-claim-" + randomUUID() }
func workflowAttemptID() string { return "workflow-attempt-" + randomUUID() }
