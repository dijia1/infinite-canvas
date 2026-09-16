package providers

import (
	"encoding/json"
	"github.com/basketikun/infinite-canvas/ai"
	"net/http"
	"strings"
)

// Only the provider's structured error envelope with rejection HTTP semantics
// (or an explicit rejected/failed status) establishes non-acceptance. Proxy text,
// message-only responses, conflicts, timeouts, rate limits and 5xx stay uncertain.
func maiziExplicitSubmissionRejection(status int, data []byte) bool {
	var envelope struct {
		Error    json.RawMessage `json:"error"`
		ErrorMsg string          `json:"error_msg"`
		Status   string          `json:"status"`
		Data     []struct {
			Status string `json:"status"`
		} `json:"data"`
	}
	if json.Unmarshal(data, &envelope) != nil {
		return false
	}
	states := []string{envelope.Status}
	for _, item := range envelope.Data {
		states = append(states, item.Status)
	}
	for _, state := range states {
		normalized, _ := normalizeMaiziImageTaskStatus(state, "")
		if normalized == ai.ImageTaskStatusPending || normalized == ai.ImageTaskStatusRunning || normalized == ai.ImageTaskStatusCompleted {
			return false
		}
	}
	hasError := strings.TrimSpace(envelope.ErrorMsg) != ""
	var text string
	if json.Unmarshal(envelope.Error, &text) == nil && strings.TrimSpace(text) != "" {
		hasError = true
	}
	var detail struct {
		Message string `json:"message"`
	}
	if json.Unmarshal(envelope.Error, &detail) == nil && strings.TrimSpace(detail.Message) != "" {
		hasError = true
	}
	if !hasError {
		return false
	}
	switch status {
	case http.StatusBadRequest, http.StatusUnauthorized, http.StatusForbidden, http.StatusUnprocessableEntity:
		return true
	}
	if status >= 200 && status < 300 {
		normalized, _ := normalizeMaiziImageTaskStatus(envelope.Status, "")
		return normalized == ai.ImageTaskStatusFailed
	}
	return false
}

// Error details may echo request data. Suppress echoed secrets instead of sending
// them to task records, audit logs and the UI as a supposedly safe reason.
func (p *maiziProvider) safeSubmissionReason(message string, request ai.ImageRequest, references []ai.ImageReference, mask *ai.ImageReference) string {
	if message == "" {
		return ""
	}
	secrets := []string{p.config.APIKey, request.Prompt}
	for _, reference := range references {
		secrets = append(secrets, maiziImageReferenceValue(reference, false))
	}
	if mask != nil {
		secrets = append(secrets, maiziImageReferenceValue(*mask, false))
	}
	lower := strings.ToLower(message)
	unsafe := strings.Contains(lower, "http://") || strings.Contains(lower, "https://") || strings.Contains(lower, "data:image/") || strings.Contains(lower, "authorization") || strings.Contains(lower, "bearer ")
	for _, secret := range secrets {
		if secret != "" && strings.Contains(message, secret) {
			unsafe = true
		}
	}
	if unsafe {
		return "MaiziAI 图片请求失败，请检查供应商配置和请求参数"
	}
	runes := []rune(strings.TrimSpace(message))
	if len(runes) > 300 {
		runes = runes[:300]
	}
	return string(runes)
}
