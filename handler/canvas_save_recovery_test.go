package handler

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/basketikun/infinite-canvas/service"
)

func TestCanvasSaveRejectionResponseKeepsStructuredSemantics(t *testing.T) {
	_, _, err := service.UpdateCanvasProject(context.Background(), service.PortalUser{UID: "test"}, "canvas", service.CanvasProjectUpdateInput{Revision: 1, Title: strings.Repeat("x", 129)}, "")
	if err == nil {
		t.Fatal("expected pre-write validation rejection")
	}
	recorder := httptest.NewRecorder()
	writeCanvasSaveError(recorder, err)
	var result struct {
		Code int
		Data struct{ Code string }
		Msg  string
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if recorder.Code != http.StatusBadRequest || result.Code != 1 || result.Data.Code != "canvas_save_rejected" || result.Msg == "" {
		t.Fatalf("response=%s", recorder.Body)
	}
	recorder = httptest.NewRecorder()
	writeCanvasSaveError(recorder, errors.New("unconfirmed failure"))
	var unknown map[string]any
	if err := json.Unmarshal(recorder.Body.Bytes(), &unknown); err != nil {
		t.Fatal(err)
	}
	if unknown["data"] != nil {
		t.Fatal("unclassified failure must not claim rejection")
	}
}
