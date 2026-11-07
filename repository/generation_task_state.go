package repository

import "time"

type GenerationTaskState struct {
	ID, Status, Error, ErrorKind, ErrorStage, ClaimID, ProviderTaskID string
	Failures                                                          int
	NextRetryAt                                                       *time.Time
}

func ListGenerationTaskStates(owner, kind string, ids []string) ([]GenerationTaskState, error) {
	if len(ids) == 0 {
		return nil, nil
	}
	db, err := DB()
	if err != nil {
		return nil, err
	}
	table, message, failures, next := "image_generation_tasks", "error_message", "poll_failures", "lease_until"
	if kind == "video" {
		table, message, failures, next = "video_generation_tasks", "error", "attempts", "next_poll_at"
	}
	var states []GenerationTaskState
	err = db.Table(table).Select("id", "status", message+" AS error", "error_kind", "error_stage", "claim_id", "provider_task_id", failures+" AS failures", next+" AS next_retry_at").Where("owner_uid = ? AND id IN ?", owner, ids).Find(&states).Error
	return states, err
}
