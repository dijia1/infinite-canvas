package providers

import (
	"context"
	"errors"
	"github.com/basketikun/infinite-canvas/ai"
	"net/http"
	"strings"
	"testing"
)

func TestMaiziImageSubmissionOutcomes(t *testing.T) {
	for _, tc := range []struct {
		name     string
		status   int
		body     string
		rejected bool
		id       string
	}{
		{"validation", 422, `{"error":{"message":"图片尺寸无效"}}`, true, ""},
		{"auth", 401, `{"error_msg":"凭证无效"}`, true, ""},
		{"business rejection", 200, `{"status":"rejected","error_msg":"内容被拒绝"}`, true, ""},
		{"proxy text", 400, `bad gateway`, false, ""},
		{"message only", 400, `{"message":"an unexplained error"}`, false, ""},
		{"timeout", 408, `{"error":"timeout"}`, false, ""},
		{"conflict", 409, `{"error":"conflict"}`, false, ""},
		{"rate limit", 429, `{"error":"rate limit"}`, false, ""},
		{"server", 500, `{"error":"server error"}`, false, ""},
		{"malformed", 200, `{`, false, ""},
		{"missing id", 202, `{"data":[{"status":"processing"}]}`, false, ""},
		{"acceptance without ID", 422, `{"data":[{"status":"processing"}],"error":"contradiction"}`, false, ""},
		{"top-level acceptance", 401, `{"status":"processing","error":"contradiction"}`, false, ""},
		{"accepted with error", 422, `{"data":[{"task_id":"upstream","status":"processing"}],"error":"contradiction"}`, false, "upstream"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			calls := 0
			p := &maiziProvider{config: maiziConfig{APIKey: "test-key", Model: "model"}, client: &http.Client{Transport: roundTripperFunc(func(*http.Request) (*http.Response, error) {
				calls++
				return jsonStatusResponse(tc.status, tc.body), nil
			})}}
			task, err := p.CreateImageTask(context.Background(), ai.ImageTaskRequest{Request: ai.ImageRequest{Prompt: "private prompt"}})
			var submission *ai.ImageSubmissionError
			rejected := errors.As(err, &submission) && submission.NotAccepted
			if rejected != tc.rejected || task.ID != tc.id || calls != 1 {
				t.Fatalf("task=%+v rejected=%v error=%v calls=%d", task, rejected, err, calls)
			}
			if err == nil && tc.id == "" {
				t.Fatal("missing outcome error")
			}
		})
	}
}

func TestMaiziImagePreflightRejectsWithoutSending(t *testing.T) {
	p := &maiziProvider{client: &http.Client{Transport: roundTripperFunc(func(*http.Request) (*http.Response, error) { t.Fatal("sent invalid request"); return nil, nil })}}
	_, err := p.CreateImageTask(context.Background(), ai.ImageTaskRequest{References: []ai.ImageReference{{URL: "https://image.example"}}})
	var submission *ai.ImageSubmissionError
	if !errors.As(err, &submission) || !submission.NotAccepted {
		t.Fatalf("preflight not rejected: %v", err)
	}
}

func TestMaiziImageSubmissionDoesNotExposeRequestSecrets(t *testing.T) {
	p := &maiziProvider{config: maiziConfig{APIKey: "private-key", Model: "model"}, client: &http.Client{Transport: roundTripperFunc(func(*http.Request) (*http.Response, error) {
		return jsonStatusResponse(422, `{"error":"Authorization Bearer private-key; prompt private prompt; https://oss.example/?signature=secret"}`), nil
	})}}
	_, err := p.CreateImageTask(context.Background(), ai.ImageTaskRequest{Request: ai.ImageRequest{Prompt: "private prompt"}})
	if err == nil {
		t.Fatal("expected error")
	}
	for _, secret := range []string{"private-key", "private prompt", "https://", "Bearer"} {
		if strings.Contains(err.Error(), secret) {
			t.Fatalf("error leaked secret: %s", secret)
		}
	}
}
