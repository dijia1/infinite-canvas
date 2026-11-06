package service

import (
	"context"
	"errors"
	"fmt"
	"github.com/aliyun/alibabacloud-oss-go-sdk-v2/oss"
	"net"

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
