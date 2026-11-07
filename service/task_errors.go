package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/aliyun/alibabacloud-oss-go-sdk-v2/oss"
	"github.com/basketikun/infinite-canvas/ai"
	"github.com/basketikun/infinite-canvas/model"
	"net"
	"time"

	"github.com/basketikun/infinite-canvas/repository"
)

func SafeMessage(err error) (string, bool) {
	var safe interface{ SafeMessage() string }
	if errors.As(err, &safe) {
		return safe.SafeMessage(), true
	}
	return "", false
}

func generationResumeError(err error) error {
	switch {
	case errors.Is(err, repository.ErrWorkflowCapacity):
		return safeMessageError{message: "当前流程生成容量已满，请稍后恢复原任务"}
	case errors.Is(err, repository.ErrGenerationTaskBusy):
		return safeMessageError{message: "任务状态正在更新，请稍后恢复原任务"}
	default:
		return err
	}
}

// TaskErrorCategory omits raw SDK errors, signed URLs and credentials.
func TaskErrorCategory(err error) string {
	var remote *oss.ServiceError
	if errors.As(err, &remote) {
		return fmt.Sprintf("oss:%s http:%d request:%s", remote.Code, remote.StatusCode, remote.RequestID)
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return "timeout"
	}
	if errors.Is(err, context.Canceled) {
		return "canceled"
	}
	var network net.Error
	if errors.As(err, &network) {
		if network.Timeout() {
			return "network_timeout"
		}
		return "network"
	}
	if message, ok := SafeMessage(err); ok {
		return message
	}
	return fmt.Sprintf("internal:%T", err)
}

func generationQueryIssue(err error) (kind, message string) {
	var query *ai.TaskQueryError
	if errors.As(err, &query) {
		return query.Kind, query.Message
	}
	return ai.TaskIssueTransient, "任务查询暂时失败"
}

func generationTaskIssue(kind, stage string, failures int, next *time.Time) *model.GenerationTaskIssue {
	if kind == "" {
		return nil
	}
	return &model.GenerationTaskIssue{Kind: kind, Stage: stage, ConsecutiveFailures: failures, NextRetryAt: next}
}

// Refresh only authentication fields. The original endpoint and model identify
// the supplier task and must not follow a newly selected model.
func refreshedGenerationCredentials(providerID, providerType, saved string) (string, error) {
	settings, err := AdminSettings()
	if err != nil {
		return "", err
	}
	provider, found := findProvider(settings.AI, providerID)
	if !found {
		return saved, nil
	}
	if provider.Type != providerType {
		return "", safeMessageError{message: "原供应商类型已变更，请确认原任务后重新生成"}
	}
	info, found := ai.Type(providerType)
	if !found {
		return "", safeMessageError{message: "原供应商不可用"}
	}
	var original, current map[string]json.RawMessage
	if err := json.Unmarshal([]byte(saved), &original); err != nil {
		return "", safeMessageError{message: "原任务配置无效"}
	}
	if err := json.Unmarshal(provider.Config, &current); err != nil {
		return "", err
	}
	for _, field := range info.ConfigFields {
		if field.Type == "password" {
			if value, exists := current[field.Key]; exists {
				original[field.Key] = value
			}
		}
	}
	result, err := json.Marshal(original)
	return string(result), err
}

func imageGenerationTaskIssue(item model.ImageGenerationTask) *model.GenerationTaskIssue {
	var next *time.Time
	if item.Status == model.ImageTaskRunning && item.ClaimID == "" {
		next = item.LeaseUntil
	}
	return generationTaskIssue(item.ErrorKind, item.ErrorStage, item.PollFailures, next)
}
func videoGenerationTaskIssue(item model.VideoGenerationTask) *model.GenerationTaskIssue {
	var next *time.Time
	if (item.Status == "running" || item.Status == "saving") && item.ClaimID == "" {
		next = &item.NextPollAt
	}
	return generationTaskIssue(item.ErrorKind, item.ErrorStage, item.Attempts, next)
}
