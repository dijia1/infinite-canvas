package handler

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestHealthReportsDatabaseAvailability(t *testing.T) {
	original := databaseHealthCheck
	t.Cleanup(func() { databaseHealthCheck = original })

	databaseHealthCheck = func() error { return nil }
	response := httptest.NewRecorder()
	Health(response, httptest.NewRequest(http.MethodGet, "/api/healthz", nil))
	if response.Code != http.StatusOK || response.Body.String() != "ok" {
		t.Fatalf("healthy response = %d/%q, want 200/ok", response.Code, response.Body.String())
	}
}

func TestHealthReportsDatabaseFailure(t *testing.T) {
	original := databaseHealthCheck
	t.Cleanup(func() { databaseHealthCheck = original })

	databaseHealthCheck = func() error { return errors.New("database unavailable") }
	response := httptest.NewRecorder()
	Health(response, httptest.NewRequest(http.MethodGet, "/api/healthz", nil))
	if response.Code != http.StatusServiceUnavailable || response.Body.String() != "unavailable" {
		t.Fatalf("unhealthy response = %d/%q, want 503/unavailable", response.Code, response.Body.String())
	}
}
