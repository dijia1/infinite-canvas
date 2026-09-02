package handler

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestFailStatusCommitsJSONContentTypeWithErrorStatus(t *testing.T) {
	recorder := httptest.NewRecorder()

	FailStatus(recorder, http.StatusConflict, "版本冲突")

	response := recorder.Result()
	if response.StatusCode != http.StatusConflict {
		t.Fatalf("status = %d, want %d", response.StatusCode, http.StatusConflict)
	}
	if contentType := response.Header.Get("Content-Type"); contentType != "application/json" {
		t.Fatalf("Content-Type = %q, want application/json", contentType)
	}
}
