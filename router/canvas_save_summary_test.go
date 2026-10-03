package router

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/repository"
	"github.com/google/uuid"
)

func TestCanvasCompactSaveResponseCompatibilityAndHistoricalReceipt(t *testing.T) {
	id := "canvas-summary-" + time.Now().Format("20060102150405.000000000")
	owner := fixtureUID(id)
	empty := `{"nodes":[],"connections":[],"backgroundMode":"lines","showImageInfo":false,"viewport":{"x":0,"y":0,"k":1}}`
	created := canvasRequest(t, http.MethodPost, "/api/v1/canvas/projects", owner, `{"id":"`+id+`","title":"base","document":`+empty+`}`)
	if created.Code != http.StatusOK || decodeCanvasResponse(t, created).Code != 0 {
		t.Fatal(created.Body.String())
	}
	document := `{"nodes":[{"id":"a","type":"text","title":"A","position":{"x":0,"y":0},"width":100,"height":100,"metadata":{"content":"` + strings.Repeat("x", 19000) + `"}},{"id":"b","type":"text","title":"B","position":{"x":200,"y":0},"width":100,"height":100}],"connections":[{"id":"ab","fromNodeId":"a","toNodeId":"b"}],"backgroundMode":"lines","showImageInfo":false,"viewport":{"x":0,"y":0,"k":1}}`
	requestID := uuid.NewString()
	update := func(header string, revision int, title, doc, rid string) *httptest.ResponseRecorder {
		t.Helper()
		req := httptest.NewRequest(http.MethodPut, "/api/v1/canvas/projects/"+id, strings.NewReader(fmt.Sprintf(`{"revision":%d,"title":%q,"document":%s}`, revision, title, doc)))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-Portal-User-Uid", owner)
		req.Header.Set("X-Canvas-Request-Id", rid)
		if header != "" {
			req.Header.Set("X-Canvas-Save-Response", header)
		}
		response := httptest.NewRecorder()
		servePortalRequest(response, req)
		return response
	}
	readSummary := func(response *httptest.ResponseRecorder) model.CanvasSummary {
		t.Helper()
		payload := decodeCanvasResponse(t, response)
		if response.Code != http.StatusOK || payload.Code != 0 {
			t.Fatalf("save = %d/%s", response.Code, response.Body)
		}
		var raw map[string]json.RawMessage
		if err := json.Unmarshal(payload.Data, &raw); err != nil {
			t.Fatal(err)
		}
		if _, exists := raw["document"]; exists {
			t.Fatal("compact receipt unexpectedly includes the document")
		}
		var summary model.CanvasSummary
		if err := json.Unmarshal(payload.Data, &summary); err != nil {
			t.Fatal(err)
		}
		return summary
	}
	compact := update("summary", 1, "A", document, requestID)
	first := readSummary(compact)
	if first.ID != id || first.Revision != 2 || first.Title != "A" || first.NodeCount != 2 || first.ConnectionCount != 1 || first.CreatedAt == "" || first.UpdatedAt == "" {
		t.Fatalf("summary = %#v", first)
	}
	if compact.Body.Len() > 1024 {
		t.Fatalf("compact receipt too large: %d", compact.Body.Len())
	}
	for _, header := range []string{"", "unknown"} {
		full := update(header, 1, "A", document, requestID)
		var record model.CanvasProject
		if err := json.Unmarshal(decodeCanvasResponse(t, full).Data, &record); err != nil {
			t.Fatal(err)
		}
		if full.Code != http.StatusOK || record.Revision != 2 || !strings.Contains(string(record.Document), strings.Repeat("x", 19000)) {
			t.Fatalf("legacy response = %d/%s", full.Code, full.Body)
		}
		t.Logf("full response %d bytes; compact response %d bytes", full.Body.Len(), compact.Body.Len())
	}
	second := readSummary(update("summary", 2, "B", empty, uuid.NewString()))
	if second.Revision != 3 || second.NodeCount != 0 {
		t.Fatalf("newer summary = %#v", second)
	}
	replay := readSummary(update("summary", 1, "A", document, requestID))
	if replay != first {
		t.Fatalf("old receipt changed: got %#v want %#v", replay, first)
	}
	stored, found, err := repository.GetCanvasProject(owner, id)
	if err != nil || !found || stored.Revision != 3 || stored.Title != "B" {
		t.Fatalf("replay overwrote newer state: %#v, %v", stored, err)
	}
	db, _ := repository.DB()
	if err := db.Where("request_id = ?", requestID).Delete(&model.CanvasSaveRequest{}).Error; err != nil {
		t.Fatal(err)
	}
	conflict := update("summary", 1, "A", document, requestID)
	var failure struct {
		Code string `json:"code"`
	}
	if err := json.Unmarshal(decodeCanvasResponse(t, conflict).Data, &failure); err != nil {
		t.Fatal(err)
	}
	if conflict.Code != http.StatusConflict || failure.Code != "canvas_revision_conflict" {
		t.Fatalf("conflict contract changed: %d/%s", conflict.Code, conflict.Body)
	}
}

func TestCanvasCompactStateMatchedResponse(t *testing.T) {
	id := "canvas-summary-match-" + time.Now().Format("20060102150405.000000000")
	owner := fixtureUID(id)
	doc := `{"nodes":[],"connections":[],"backgroundMode":"lines","showImageInfo":false,"viewport":{"x":0,"y":0,"k":1}}`
	created := canvasRequest(t, http.MethodPost, "/api/v1/canvas/projects", owner, `{"id":"`+id+`","title":"base","document":`+doc+`}`)
	if created.Code != http.StatusOK {
		t.Fatal(created.Body.String())
	}
	requestID := uuid.NewString()
	save := func() *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPut, "/api/v1/canvas/projects/"+id, strings.NewReader(`{"revision":1,"title":"A","document":`+doc+`}`))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-Portal-User-Uid", owner)
		req.Header.Set("X-Canvas-Request-Id", requestID)
		req.Header.Set("X-Canvas-Save-Response", "summary")
		response := httptest.NewRecorder()
		servePortalRequest(response, req)
		return response
	}
	first := save()
	db, _ := repository.DB()
	if err := db.Where("request_id = ?", requestID).Delete(&model.CanvasSaveRequest{}).Error; err != nil {
		t.Fatal(err)
	}
	replay := save()
	if replay.Code != http.StatusOK || replay.Body.String() != first.Body.String() {
		t.Fatalf("state match changed receipt: %d/%s, original %s", replay.Code, replay.Body, first.Body)
	}
}
