package service

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/repository"
	"gorm.io/gorm"
)

type GenerationTaskResolutionRequest struct {
	Action         string `json:"action"`
	ProviderTaskID string `json:"providerTaskId"`
	Reason         string `json:"reason"`
}

func ResolveGenerationTask(ctx context.Context, kind, id string, input GenerationTaskResolutionRequest) error {
	actor, ok := PortalUserFromContext(ctx)
	if !ok || actor.UID == "" {
		return safeMessageError{message: "未登录或权限不足"}
	}
	// The HTTP entry is also guarded by RequireAppAdmin. Keep the service entry
	// safe for callers that do not run through the router.
	permissions, err := ResolveAppPermissions(ctx, actor)
	if err != nil {
		return err
	}
	if !permissions.IsAdmin {
		return safeMessageError{message: "未登录或权限不足"}
	}
	id, input.Reason, input.ProviderTaskID = strings.TrimSpace(id), strings.TrimSpace(input.Reason), strings.TrimSpace(input.ProviderTaskID)
	if kind != "image" && kind != "video" || id == "" || len(id) > 128 {
		return safeMessageError{message: "生成任务无效"}
	}
	if input.Action != "attach" && input.Action != "close" {
		return safeMessageError{message: "请选择绑定原供应商任务或确认失败并结案"}
	}
	if input.Reason == "" || utf8.RuneCountInString(input.Reason) > 500 {
		return safeMessageError{message: "请填写不超过 500 字的核对原因"}
	}
	if input.Action == "attach" && (input.ProviderTaskID == "" || len(input.ProviderTaskID) > 512) {
		return safeMessageError{message: "请填写有效的原供应商任务 ID"}
	}
	timeout, err := imageTaskWaitTimeout()
	if kind == "video" {
		timeout, err = videoTaskTimeout()
	}
	if err != nil {
		return err
	}
	global, _ := workflowConcurrency()
	current := time.Now().UTC()
	summary, err := json.Marshal(input)
	if err != nil {
		return err
	}
	audit := model.OperationLog{ID: newID("operation"), ActorUID: actor.UID, ActorName: PortalDisplayName(actor), ActorRoles: append([]string{}, actor.Roles...), Action: "generation_task_resolution", Status: model.OperationStatusSuccess, TargetType: kind + "_generation", TargetID: id, ProviderTaskID: input.ProviderTaskID, RequestSummary: string(summary), CreatedAt: current}
	err = repository.ResolveGenerationTask(kind, id, input.Action, input.ProviderTaskID, current, timeout, global, audit)
	if errors.Is(err, repository.ErrGenerationTaskResolutionConflict) {
		return safeMessageError{message: "任务状态已变化，或已有其他供应商任务 ID，请刷新后核对"}
	}
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return safeMessageError{message: "生成任务不存在"}
	}
	if err != nil {
		return generationResumeError(err)
	}
	if kind == "image" && input.Action == "close" {
		cleanupClosedImageTask(ctx, id)
	}
	return nil
}

func cleanupClosedImageTask(ctx context.Context, id string) {
	item, found, loadErr := repository.GetImageGenerationTask(id)
	if loadErr != nil {
		log.Printf("image task %s closed task cleanup lookup failed: %v", id, loadErr)
	} else if found {
		cleanupCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		defer cancel()
		if cleanupErr := cleanupImageTaskResources(cleanupCtx, item); cleanupErr != nil {
			log.Printf("image task %s closed task cleanup deferred category=%s", id, TaskErrorCategory(cleanupErr))
		}
	}
}
