package router

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestHealthRouteIsPublicAndChecksDatabase(t *testing.T) {
	response := httptest.NewRecorder()
	New().ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/healthz", nil))
	if response.Code != http.StatusOK || response.Body.String() != "ok" {
		t.Fatalf("health route = %d/%q, want 200/ok", response.Code, response.Body.String())
	}
}
