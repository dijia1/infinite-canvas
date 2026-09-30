package handler

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestHealthReportsDatabaseAvailability(t *testing.T) {
	original := databaseHealthCheck
	t.Cleanup(func() { databaseHealthCheck = original })

	databaseHealthCheck = func(context.Context) error { return nil }
	response := httptest.NewRecorder()
	Health(response, httptest.NewRequest(http.MethodGet, "/api/healthz", nil))
	if response.Code != http.StatusOK || response.Body.String() != "{\"ok\":true}\n" {
		t.Fatalf("healthy response = %d/%q, want 200/ok", response.Code, response.Body.String())
	}
}

func TestHealthReportsDatabaseFailure(t *testing.T) {
	original := databaseHealthCheck
	t.Cleanup(func() { databaseHealthCheck = original })

	databaseHealthCheck = func(context.Context) error { return errors.New("database unavailable") }
	response := httptest.NewRecorder()
	Health(response, httptest.NewRequest(http.MethodGet, "/api/healthz", nil))
	if response.Code != http.StatusServiceUnavailable || !strings.Contains(response.Body.String(), "DEPENDENCY_UNAVAILABLE") {
		t.Fatalf("unhealthy response = %d/%q, want 503/unavailable", response.Code, response.Body.String())
	}
}

func TestHealthUsesBoundedRequestContextAndNoHeadBody(t *testing.T) {
	previous := databaseHealthCheck
	t.Cleanup(func() { databaseHealthCheck = previous })
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Millisecond)
	defer cancel()
	databaseHealthCheck = func(check context.Context) error {
		deadline, ok := check.Deadline()
		if !ok || time.Until(deadline) > 2*time.Second {
			t.Fatal("missing bounded deadline")
		}
		<-check.Done()
		return check.Err()
	}
	w := httptest.NewRecorder()
	Health(w, httptest.NewRequest(http.MethodHead, "/api/healthz", nil).WithContext(ctx))
	if w.Code != 503 || w.Body.Len() != 0 || w.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("response=%d %v %s", w.Code, w.Header(), w.Body.String())
	}
}
