package router

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func canvasRequest(t *testing.T, method, path, owner, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	if owner != "" {
		req.Header.Set("X-Portal-User-Uid", owner)
	}
	response := httptest.NewRecorder()
	New().ServeHTTP(response, req)
	return response
}

func decodeCanvasResponse(t *testing.T, response *httptest.ResponseRecorder) struct {
	Code int             `json:"code"`
	Data json.RawMessage `json:"data"`
	Msg  string          `json:"msg"`
} {
	t.Helper()
	var payload struct {
		Code int             `json:"code"`
		Data json.RawMessage `json:"data"`
		Msg  string          `json:"msg"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode response %q: %v", response.Body.String(), err)
	}
	return payload
}

func TestCanvasProjectRoutesRequirePortalIdentity(t *testing.T) {
	response := canvasRequest(t, http.MethodGet, "/api/v1/canvas/projects", "", "")
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated canvas list = %d/%s", response.Code, response.Body.String())
	}
}

func TestCanvasProjectOwnerCRUDSanitizesTransientImageContent(t *testing.T) {
	id := "canvas-crud-" + time.Now().Format("20060102150405.000000000")
	owner := "canvas-owner-" + id
	document := `{"nodes":[{"id":"image-1","type":"image","metadata":{"content":"blob:https://canvas.local/1","mediaId":"media-1","publicImageId":"public-image-1","mimeType":"image/png","bytes":12,"access":{"url":"https://bucket.example/image.png?X-Amz-Signature=secret","google":"https://storage.googleapis.com/bucket/image.png?X-Goog-Signature=secret","azure":"https://account.blob.core.windows.net/images/image.png?sv=2025-01-05&sig=secret"}}},{"id":"text-1","type":"text","metadata":{"content":"keep this text"}}],"connections":[{"id":"line-1","fromNodeId":"image-1","toNodeId":"text-1"}],"backgroundMode":"dots","showImageInfo":true,"viewport":{"x":5,"y":8,"k":1.5},"legacyPreview":"data:image/png;base64,abc"}`
	create := canvasRequest(t, http.MethodPost, "/api/v1/canvas/projects", owner, `{"id":"`+id+`","title":"  我的画布  ","createdAt":"2026-09-02T01:00:00Z","updatedAt":"2026-09-02T01:00:00Z","document":`+document+`}`)
	if create.Code != http.StatusOK {
		t.Fatalf("create canvas project = %d/%s", create.Code, create.Body.String())
	}
	created := decodeCanvasResponse(t, create)
	if created.Code != 0 {
		t.Fatalf("create payload = %s", create.Body.String())
	}
	var project struct {
		ID       string          `json:"id"`
		Title    string          `json:"title"`
		Revision int             `json:"revision"`
		Document json.RawMessage `json:"document"`
	}
	if err := json.Unmarshal(created.Data, &project); err != nil {
		t.Fatal(err)
	}
	if project.ID != id || project.Title != "我的画布" || project.Revision != 1 {
		t.Fatalf("created project = %#v", project)
	}
	assertCanvasDocumentSanitized(t, project.Document)

	list := canvasRequest(t, http.MethodGet, "/api/v1/canvas/projects", owner, "")
	var listData struct {
		Items []struct {
			ID string `json:"id"`
		} `json:"items"`
		Total int `json:"total"`
	}
	if list.Code != http.StatusOK || json.Unmarshal(decodeCanvasResponse(t, list).Data, &listData) != nil || listData.Total != 1 || len(listData.Items) != 1 || listData.Items[0].ID != id {
		t.Fatalf("owner list = %d/%s", list.Code, list.Body.String())
	}

	other := canvasRequest(t, http.MethodGet, "/api/v1/canvas/projects/"+id, "another-owner", "")
	if other.Code != http.StatusOK || decodeCanvasResponse(t, other).Code != 1 {
		t.Fatalf("cross-owner get must be hidden = %d/%s", other.Code, other.Body.String())
	}

	update := canvasRequest(t, http.MethodPut, "/api/v1/canvas/projects/"+id, owner, `{"revision":1,"title":"更新后画布","document":{"nodes":[],"connections":[],"backgroundMode":"blank","showImageInfo":false,"viewport":{"x":0,"y":0,"k":1}}}`)
	if update.Code != http.StatusOK {
		t.Fatalf("update canvas project = %d/%s", update.Code, update.Body.String())
	}
	if err := json.Unmarshal(decodeCanvasResponse(t, update).Data, &project); err != nil || project.Revision != 2 || project.Title != "更新后画布" {
		t.Fatalf("updated project = %s, err=%v", update.Body.String(), err)
	}

	deleted := canvasRequest(t, http.MethodDelete, "/api/v1/canvas/projects/"+id, owner, `{"revision":2}`)
	if deleted.Code != http.StatusOK || decodeCanvasResponse(t, deleted).Code != 0 {
		t.Fatalf("delete canvas project = %d/%s", deleted.Code, deleted.Body.String())
	}
	missing := canvasRequest(t, http.MethodGet, "/api/v1/canvas/projects/"+id, owner, "")
	if missing.Code != http.StatusOK || decodeCanvasResponse(t, missing).Code != 1 {
		t.Fatalf("deleted project lookup = %d/%s", missing.Code, missing.Body.String())
	}
}

func TestCanvasProjectImportIsIdempotentAndDoesNotOverwriteExistingProject(t *testing.T) {
	id := "canvas-import-" + time.Now().Format("20060102150405.000000000")
	owner := "canvas-import-owner-" + id
	body := `{"projects":[{"id":"` + id + `","title":"本地画布","createdAt":"2026-09-01T01:00:00Z","updatedAt":"2026-09-01T01:00:00Z","document":{"nodes":[],"connections":[],"backgroundMode":"lines","showImageInfo":false,"viewport":{"x":0,"y":0,"k":1}}}]}`
	first := canvasRequest(t, http.MethodPost, "/api/v1/canvas/projects/import", owner, body)
	if first.Code != http.StatusOK || decodeCanvasResponse(t, first).Code != 0 {
		t.Fatalf("first import = %d/%s", first.Code, first.Body.String())
	}
	second := canvasRequest(t, http.MethodPost, "/api/v1/canvas/projects/import", owner, strings.Replace(body, "本地画布", "不应覆盖", 1))
	if second.Code != http.StatusOK || decodeCanvasResponse(t, second).Code != 0 {
		t.Fatalf("repeat import = %d/%s", second.Code, second.Body.String())
	}
	project := canvasRequest(t, http.MethodGet, "/api/v1/canvas/projects/"+id, owner, "")
	var got struct {
		Title    string `json:"title"`
		Revision int    `json:"revision"`
	}
	if err := json.Unmarshal(decodeCanvasResponse(t, project).Data, &got); err != nil || got.Title != "本地画布" || got.Revision != 1 {
		t.Fatalf("idempotent imported project = %d/%s, %#v, %v", project.Code, project.Body.String(), got, err)
	}
}

func TestCanvasProjectImportAllowsDifferentOwnersToUseTheSameClientID(t *testing.T) {
	id := "canvas-shared-" + time.Now().Format("20060102150405.000000000")
	firstOwner := "canvas-shared-first-" + id
	secondOwner := "canvas-shared-second-" + id
	first := `{"projects":[{"id":"` + id + `","title":"第一个用户画布","document":{"nodes":[],"connections":[],"backgroundMode":"lines","showImageInfo":false,"viewport":{"x":0,"y":0,"k":1}}}]}`
	second := strings.Replace(first, "第一个用户画布", "第二个用户画布", 1)
	if response := canvasRequest(t, http.MethodPost, "/api/v1/canvas/projects/import", firstOwner, first); response.Code != http.StatusOK || decodeCanvasResponse(t, response).Code != 0 {
		t.Fatalf("first owner import = %d/%s", response.Code, response.Body.String())
	}
	if response := canvasRequest(t, http.MethodPost, "/api/v1/canvas/projects/import", secondOwner, second); response.Code != http.StatusOK || decodeCanvasResponse(t, response).Code != 0 {
		t.Fatalf("second owner import = %d/%s", response.Code, response.Body.String())
	}
	for _, check := range []struct {
		owner string
		title string
	}{{firstOwner, "第一个用户画布"}, {secondOwner, "第二个用户画布"}} {
		response := canvasRequest(t, http.MethodGet, "/api/v1/canvas/projects/"+id, check.owner, "")
		var project struct {
			Title string `json:"title"`
		}
		if response.Code != http.StatusOK || json.Unmarshal(decodeCanvasResponse(t, response).Data, &project) != nil || project.Title != check.title {
			t.Fatalf("owner-scoped shared ID lookup for %s = %d/%s", check.owner, response.Code, response.Body.String())
		}
	}
}

func TestCanvasProjectImportRejectsAnInvalidBatchWithoutSavingEarlierProjects(t *testing.T) {
	owner := "canvas-import-invalid-" + time.Now().Format("20060102150405.000000000")
	validID := "canvas-import-valid-" + owner
	batch := `{"projects":[{"id":"` + validID + `","title":"有效画布","document":{"nodes":[],"connections":[],"backgroundMode":"lines","showImageInfo":false,"viewport":{"x":0,"y":0,"k":1}}},{"id":"canvas-import-invalid","title":" ","document":{}}]}`
	response := canvasRequest(t, http.MethodPost, "/api/v1/canvas/projects/import", owner, batch)
	if response.Code != http.StatusBadRequest || decodeCanvasResponse(t, response).Code != 1 {
		t.Fatalf("invalid import batch = %d/%s", response.Code, response.Body.String())
	}
	lookup := canvasRequest(t, http.MethodGet, "/api/v1/canvas/projects/"+validID, owner, "")
	if lookup.Code != http.StatusOK || decodeCanvasResponse(t, lookup).Code != 1 {
		t.Fatalf("invalid import must not save preceding project = %d/%s", lookup.Code, lookup.Body.String())
	}
}

func TestCanvasProjectRejectsInvalidPayloadsAndStaleRevisions(t *testing.T) {
	id := "canvas-conflict-" + time.Now().Format("20060102150405.000000000")
	owner := "canvas-conflict-owner-" + id
	invalid := canvasRequest(t, http.MethodPost, "/api/v1/canvas/projects", owner, `{"id":"bad","title":" ","document":{}}`)
	if invalid.Code != http.StatusBadRequest || decodeCanvasResponse(t, invalid).Code != 1 {
		t.Fatalf("invalid canvas payload = %d/%s", invalid.Code, invalid.Body.String())
	}
	create := canvasRequest(t, http.MethodPost, "/api/v1/canvas/projects", owner, `{"id":"`+id+`","title":"冲突画布","document":{"nodes":[],"connections":[],"backgroundMode":"lines","showImageInfo":false,"viewport":{"x":0,"y":0,"k":1}}}`)
	if create.Code != http.StatusOK {
		t.Fatal(create.Body.String())
	}
	freshUpdate := canvasRequest(t, http.MethodPut, "/api/v1/canvas/projects/"+id, owner, `{"revision":1,"title":"服务器版本","document":{"nodes":[{"id":"server-node"}],"connections":[],"backgroundMode":"lines","showImageInfo":false,"viewport":{"x":0,"y":0,"k":1}}}`)
	if freshUpdate.Code != http.StatusOK || decodeCanvasResponse(t, freshUpdate).Code != 0 {
		t.Fatalf("fresh update = %d/%s", freshUpdate.Code, freshUpdate.Body.String())
	}
	staleUpdate := canvasRequest(t, http.MethodPut, "/api/v1/canvas/projects/"+id, owner, `{"revision":1,"title":"不应保存","document":{"nodes":[{"id":"stale-node"}],"connections":[],"backgroundMode":"blank","showImageInfo":false,"viewport":{"x":0,"y":0,"k":1}}}`)
	if staleUpdate.Code != http.StatusConflict || decodeCanvasResponse(t, staleUpdate).Code != 1 {
		t.Fatalf("stale update = %d/%s", staleUpdate.Code, staleUpdate.Body.String())
	}
	staleDelete := canvasRequest(t, http.MethodDelete, "/api/v1/canvas/projects/"+id, owner, `{"revision":1}`)
	if staleDelete.Code != http.StatusConflict || decodeCanvasResponse(t, staleDelete).Code != 1 {
		t.Fatalf("stale delete = %d/%s", staleDelete.Code, staleDelete.Body.String())
	}
	current := canvasRequest(t, http.MethodGet, "/api/v1/canvas/projects/"+id, owner, "")
	var project struct {
		Title    string          `json:"title"`
		Revision int             `json:"revision"`
		Document json.RawMessage `json:"document"`
	}
	if current.Code != http.StatusOK || json.Unmarshal(decodeCanvasResponse(t, current).Data, &project) != nil || project.Title != "服务器版本" || project.Revision != 2 || !bytes.Contains(project.Document, []byte("server-node")) || bytes.Contains(project.Document, []byte("stale-node")) {
		t.Fatalf("stale writes changed server snapshot = %d/%s", current.Code, current.Body.String())
	}
}

func assertCanvasDocumentSanitized(t *testing.T, document json.RawMessage) {
	t.Helper()
	text := string(document)
	for _, forbidden := range []string{"blob:", "data:image/", "X-Amz-Signature", "X-Goog-Signature", "sig=secret"} {
		if strings.Contains(text, forbidden) {
			t.Fatalf("stored document leaks transient image content %q: %s", forbidden, text)
		}
	}
	for _, required := range []string{"media-1", "public-image-1", "image/png", "keep this text", "line-1", "dots"} {
		if !bytes.Contains(document, []byte(required)) {
			t.Fatalf("stored document lost stable canvas state %q: %s", required, document)
		}
	}
}
