package service

import (
	"context"
	"errors"
	"fmt"
	"github.com/aliyun/alibabacloud-oss-go-sdk-v2/oss"
	"net"
)

func SafeMessage(err error) (string, bool) {
	var safe interface{ SafeMessage() string }
	if errors.As(err, &safe) {
		return safe.SafeMessage(), true
	}
	return "", false
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
