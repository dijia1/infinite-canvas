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

const emptyCanvasGraphDocument = `{"nodes":[],"connections":[],"backgroundMode":"lines","showImageInfo":false,"viewport":{"x":0,"y":0,"k":1}}`

func TestCanvasGraphInvariantsRejectNewViolationsAcrossWriteRoutes(t *testing.T) {
	invalidDocuments := []struct {
		name     string
		document string
	}{
		{name: "zero node width", document: `{"nodes":[{"id":"node-a","type":"text","title":"A","position":{"x":0,"y":0},"width":0,"height":10}],"connections":[],"backgroundMode":"lines","showImageInfo":false,"viewport":{"x":0,"y":0,"k":1}}`},
		{name: "negative node height", document: `{"nodes":[{"id":"node-a","type":"text","title":"A","position":{"x":0,"y":0},"width":10,"height":-1}],"connections":[],"backgroundMode":"lines","showImageInfo":false,"viewport":{"x":0,"y":0,"k":1}}`},
		{name: "duplicate node IDs", document: `{"nodes":[{"id":"node-a","type":"text","title":"A","position":{"x":0,"y":0},"width":10,"height":10},{"id":"node-a","type":"image","title":"B","position":{"x":20,"y":0},"width":10,"height":10}],"connections":[],"backgroundMode":"lines","showImageInfo":false,"viewport":{"x":0,"y":0,"k":1}}`},
		{name: "duplicate connection IDs", document: `{"nodes":[{"id":"node-a","type":"text","title":"A","position":{"x":0,"y":0},"width":10,"height":10}],"connections":[{"id":"edge-a","fromNodeId":"node-a","toNodeId":"node-a"},{"id":"edge-a","fromNodeId":"node-a","toNodeId":"node-a"}],"backgroundMode":"lines","showImageInfo":false,"viewport":{"x":0,"y":0,"k":1}}`},
		{name: "missing connection source", document: `{"nodes":[{"id":"node-a","type":"text","title":"A","position":{"x":0,"y":0},"width":10,"height":10}],"connections":[{"id":"edge-a","fromNodeId":"missing-node","toNodeId":"node-a"}],"backgroundMode":"lines","showImageInfo":false,"viewport":{"x":0,"y":0,"k":1}}`},
		{name: "missing connection target", document: `{"nodes":[{"id":"node-a","type":"text","title":"A","position":{"x":0,"y":0},"width":10,"height":10}],"connections":[{"id":"edge-a","fromNodeId":"node-a","toNodeId":"missing-node"}],"backgroundMode":"lines","showImageInfo":false,"viewport":{"x":0,"y":0,"k":1}}`},
	}

	for index, test := range invalidDocuments {
		t.Run(test.name, func(t *testing.T) {
			suffix := fmt.Sprintf("%d-%d", time.Now().UnixNano(), index)
			owner := "graph-strict-owner-" + suffix
			createID := "graph-strict-create-" + suffix
			create := canvasRequest(t, http.MethodPost, "/api/v1/canvas/projects", owner, `{"id":"`+createID+`","title":"strict create","document":`+test.document+`}`)
			if create.Code != http.StatusBadRequest || decodeCanvasResponse(t, create).Code != 1 {
				t.Fatalf("create accepted invalid graph = %d/%s", create.Code, create.Body.String())
			}

			importID := "graph-strict-import-" + suffix
			imported := canvasRequest(t, http.MethodPost, "/api/v1/canvas/projects/import", owner, `{"projects":[{"id":"`+importID+`","title":"strict import","document":`+test.document+`}]}`)
			if imported.Code != http.StatusBadRequest || decodeCanvasResponse(t, imported).Code != 1 {
				t.Fatalf("import accepted invalid graph = %d/%s", imported.Code, imported.Body.String())
			}

			updateID := "graph-strict-update-" + suffix
			seedCanvasGraphProject(t, updateID, owner, emptyCanvasGraphDocument)
			updated := canvasRequest(t, http.MethodPut, "/api/v1/canvas/projects/"+updateID, owner, `{"revision":1,"title":"must not save","document":`+test.document+`}`)
			if updated.Code != http.StatusBadRequest || decodeCanvasResponse(t, updated).Code != 1 {
				t.Fatalf("update accepted invalid graph = %d/%s", updated.Code, updated.Body.String())
			}
			assertStoredCanvasGraph(t, owner, updateID, 1, "seed", emptyCanvasGraphDocument)
		})
	}
}

func TestCanvasGraphInvariantsAcceptSupportedNodesEdgesAndMetadata(t *testing.T) {
	suffix := fmt.Sprint(time.Now().UnixNano())
	owner := "graph-compatible-owner-" + suffix
	id := "graph-compatible-" + suffix
	document := `{"nodes":[` +
		`{"id":"image","type":"image","title":"image","position":{"x":0,"y":0},"width":10,"height":10,"metadata":{"model":"legacy","batch":{"id":"batch-a"},"output":{"status":"done"},"sourceNodeId":"missing-metadata-node"}},` +
		`{"id":"text","type":"text","title":"text","position":{"x":20,"y":0},"width":10,"height":10,"metadata":{"dangling":{"nodeId":"missing"}}},` +
		`{"id":"config-a","type":"config","title":"config","position":{"x":40,"y":0},"width":10,"height":10,"metadata":{}},` +
		`{"id":"video","type":"video","title":"video","position":{"x":60,"y":0},"width":10,"height":10,"metadata":{"output":{"url":"video:stable"}}}],` +
		`"connections":[{"id":"self","fromNodeId":"text","toNodeId":"text"},{"id":"config-edge","fromNodeId":"config-a","toNodeId":"config-a"},{"id":"parallel-a","fromNodeId":"image","toNodeId":"video"},{"id":"parallel-b","fromNodeId":"image","toNodeId":"video"}],` +
		`"backgroundMode":"lines","showImageInfo":false,"viewport":{"x":0,"y":0,"k":1},"legacy":{"model":"old","batch":"kept","output":"kept"}}`

	response := canvasRequest(t, http.MethodPost, "/api/v1/canvas/projects", owner, `{"id":"`+id+`","title":"compatible","document":`+document+`}`)
	if response.Code != http.StatusOK || decodeCanvasResponse(t, response).Code != 0 {
		t.Fatalf("supported graph rejected = %d/%s", response.Code, response.Body.String())
	}
}

func TestCanvasGraphInvariantBaselineCanBePreservedReducedButNotChangedOrWorsened(t *testing.T) {
	suffix := fmt.Sprint(time.Now().UnixNano())
	owner := "graph-baseline-owner-" + suffix
	legacyID := "graph-baseline-legacy-" + suffix
	legacy := `{"nodes":[{"id":" exact-id ","type":"text","title":"legacy","position":{"x":0,"y":0},"width":0e5,"height":10,"metadata":{"legacy":true}},{"id":" exact-id ","type":"image","title":"duplicate","position":{"x":20,"y":0},"width":10,"height":-1e1}],"connections":[{"id":"edge-a","fromNodeId":" exact-id ","toNodeId":"missing"},{"id":"edge-a","fromNodeId":" exact-id ","toNodeId":"missing"}],"backgroundMode":"lines","showImageInfo":false,"viewport":{"x":0,"y":0,"k":1}}`
	seedCanvasGraphProject(t, legacyID, owner, legacy)
	preserved := `{"nodes":[{"id":" exact-id ","type":"text","title":"legacy","position":{"x":0,"y":0},"width":0,"height":10,"metadata":{"legacy":true,"edited":true}},{"id":" exact-id ","type":"image","title":"duplicate","position":{"x":20,"y":0},"width":10,"height":-10.0}],"connections":[{"id":"edge-a","fromNodeId":" exact-id ","toNodeId":"missing"},{"id":"edge-a","fromNodeId":" exact-id ","toNodeId":"missing"}],"backgroundMode":"lines","showImageInfo":false,"viewport":{"x":12,"y":24,"k":2},"metadata":{"saved":true}}`
	response := canvasRequest(t, http.MethodPut, "/api/v1/canvas/projects/"+legacyID, owner, `{"revision":1,"title":"metadata saved","document":`+preserved+`}`)
	if response.Code != http.StatusOK || decodeCanvasResponse(t, response).Code != 0 {
		t.Fatalf("preserving a legacy violation = %d/%s", response.Code, response.Body.String())
	}
	fixed := `{"nodes":[{"id":" exact-id ","type":"text","title":"legacy","position":{"x":0,"y":0},"width":10,"height":10,"metadata":{"legacy":true,"edited":true}},{"id":"second-id","type":"image","title":"duplicate","position":{"x":20,"y":0},"width":10,"height":10}],"connections":[{"id":"edge-a","fromNodeId":" exact-id ","toNodeId":"second-id"},{"id":"edge-b","fromNodeId":" exact-id ","toNodeId":"second-id"}],"backgroundMode":"lines","showImageInfo":false,"viewport":{"x":12,"y":24,"k":2},"metadata":{"saved":true}}`
	response = canvasRequest(t, http.MethodPut, "/api/v1/canvas/projects/"+legacyID, owner, `{"revision":2,"title":"fixed","document":`+fixed+`}`)
	if response.Code != http.StatusOK || decodeCanvasResponse(t, response).Code != 0 {
		t.Fatalf("repairing a legacy violation = %d/%s", response.Code, response.Body.String())
	}

	rejections := []struct {
		name      string
		baseline  string
		candidate string
	}{
		{name: "raw node ID identity is not trimmed", baseline: `{"nodes":[{"id":" exact-id ","type":"text","title":"legacy","position":{"x":0,"y":0},"width":0,"height":10}],"connections":[],"backgroundMode":"lines","showImageInfo":false,"viewport":{"x":0,"y":0,"k":1}}`, candidate: `{"nodes":[{"id":"exact-id","type":"text","title":"legacy","position":{"x":0,"y":0},"width":0,"height":10}],"connections":[],"backgroundMode":"lines","showImageInfo":false,"viewport":{"x":0,"y":0,"k":1}}`},
		{name: "zero dimension becomes negative", baseline: `{"nodes":[{"id":" exact-id ","type":"text","title":"legacy","position":{"x":0,"y":0},"width":0,"height":10}],"connections":[],"backgroundMode":"lines","showImageInfo":false,"viewport":{"x":0,"y":0,"k":1}}`, candidate: `{"nodes":[{"id":" exact-id ","type":"text","title":"legacy","position":{"x":0,"y":0},"width":-1,"height":10}],"connections":[],"backgroundMode":"lines","showImageInfo":false,"viewport":{"x":0,"y":0,"k":1}}`},
		{name: "distinct large negative dimensions do not collide", baseline: `{"nodes":[{"id":"node-a","type":"text","title":"legacy","position":{"x":0,"y":0},"width":-9007199254740992,"height":10}],"connections":[],"backgroundMode":"lines","showImageInfo":false,"viewport":{"x":0,"y":0,"k":1}}`, candidate: `{"nodes":[{"id":"node-a","type":"text","title":"legacy","position":{"x":0,"y":0},"width":-9007199254740993,"height":10}],"connections":[],"backgroundMode":"lines","showImageInfo":false,"viewport":{"x":0,"y":0,"k":1}}`},
		{name: "distinct exponential negative dimensions do not collide", baseline: `{"nodes":[{"id":"node-a","type":"text","title":"legacy","position":{"x":0,"y":0},"width":-1e20,"height":10}],"connections":[],"backgroundMode":"lines","showImageInfo":false,"viewport":{"x":0,"y":0,"k":1}}`, candidate: `{"nodes":[{"id":"node-a","type":"text","title":"legacy","position":{"x":0,"y":0},"width":-100000000000000000001,"height":10}],"connections":[],"backgroundMode":"lines","showImageInfo":false,"viewport":{"x":0,"y":0,"k":1}}`},
		{name: "dangling endpoint changes identity", baseline: `{"nodes":[{"id":"node-a","type":"text","title":"A","position":{"x":0,"y":0},"width":10,"height":10}],"connections":[{"id":"edge-a","fromNodeId":"node-a","toNodeId":"missing-a"}],"backgroundMode":"lines","showImageInfo":false,"viewport":{"x":0,"y":0,"k":1}}`, candidate: `{"nodes":[{"id":"node-a","type":"text","title":"A","position":{"x":0,"y":0},"width":10,"height":10}],"connections":[{"id":"edge-a","fromNodeId":"node-a","toNodeId":"missing-b"}],"backgroundMode":"lines","showImageInfo":false,"viewport":{"x":0,"y":0,"k":1}}`},
		{name: "new duplicate node ID", baseline: emptyCanvasGraphDocument, candidate: `{"nodes":[{"id":"dup","type":"text","title":"A","position":{"x":0,"y":0},"width":10,"height":10},{"id":"dup","type":"text","title":"B","position":{"x":20,"y":0},"width":10,"height":10}],"connections":[],"backgroundMode":"lines","showImageInfo":false,"viewport":{"x":0,"y":0,"k":1}}`},
		{name: "duplicate node count worsens", baseline: `{"nodes":[{"id":"dup","type":"text","title":"A","position":{"x":0,"y":0},"width":10,"height":10},{"id":"dup","type":"text","title":"B","position":{"x":20,"y":0},"width":10,"height":10}],"connections":[],"backgroundMode":"lines","showImageInfo":false,"viewport":{"x":0,"y":0,"k":1}}`, candidate: `{"nodes":[{"id":"dup","type":"text","title":"A","position":{"x":0,"y":0},"width":10,"height":10},{"id":"dup","type":"text","title":"B","position":{"x":20,"y":0},"width":10,"height":10},{"id":"dup","type":"text","title":"C","position":{"x":40,"y":0},"width":10,"height":10}],"connections":[],"backgroundMode":"lines","showImageInfo":false,"viewport":{"x":0,"y":0,"k":1}}`},
	}
	for index, test := range rejections {
		t.Run(test.name, func(t *testing.T) {
			id := fmt.Sprintf("graph-baseline-reject-%s-%d", suffix, index)
			seedCanvasGraphProject(t, id, owner, test.baseline)
			response := canvasRequest(t, http.MethodPut, "/api/v1/canvas/projects/"+id, owner, `{"revision":1,"title":"must not save","document":`+test.candidate+`}`)
			if response.Code != http.StatusBadRequest || decodeCanvasResponse(t, response).Code != 1 {
				t.Fatalf("changed legacy violation accepted = %d/%s", response.Code, response.Body.String())
			}
			assertStoredCanvasGraph(t, owner, id, 1, "seed", test.baseline)
		})
	}
}

func TestCanvasGraphLegacySaveRequestReplayWinsAfterProjectAdvances(t *testing.T) {
	suffix := fmt.Sprint(time.Now().UnixNano())
	owner := "graph-replay-owner-" + suffix
	id := "graph-replay-" + suffix
	requestID := uuid.NewString()
	legacy := `{"nodes":[{"id":"node-a","type":"text","title":"legacy","position":{"x":0,"y":0},"width":0,"height":10}],"connections":[],"backgroundMode":"lines","showImageInfo":false,"viewport":{"x":0,"y":0,"k":1}}`
	firstBody := `{"revision":1,"title":"first accepted","document":` + legacy + `}`
	seedCanvasGraphProject(t, id, owner, legacy)
	first := canvasGraphRequestWithID(t, http.MethodPut, "/api/v1/canvas/projects/"+id, owner, firstBody, requestID)
	var accepted model.CanvasProject
	if first.Code != http.StatusOK || json.Unmarshal(decodeCanvasResponse(t, first).Data, &accepted) != nil {
		t.Fatalf("first legacy save = %d/%s", first.Code, first.Body.String())
	}
	mismatched := canvasGraphRequestWithID(t, http.MethodPut, "/api/v1/canvas/projects/"+id, owner, strings.Replace(firstBody, "first accepted", "different payload", 1), requestID)
	if mismatched.Code != http.StatusBadRequest {
		t.Fatalf("same request ID with a different payload = %d/%s", mismatched.Code, mismatched.Body.String())
	}
	crossOwner := canvasGraphRequestWithID(t, http.MethodPut, "/api/v1/canvas/projects/"+id, "other-"+owner, firstBody, requestID)
	if crossOwner.Code != http.StatusBadRequest {
		t.Fatalf("same request ID from another owner = %d/%s", crossOwner.Code, crossOwner.Body.String())
	}
	advancedLegacy := strings.Replace(legacy, `"viewport":{"x":0`, `"viewport":{"x":99`, 1)
	advanced := canvasRequest(t, http.MethodPut, "/api/v1/canvas/projects/"+id, owner, `{"revision":2,"title":"advanced","document":`+advancedLegacy+`}`)
	if advanced.Code != http.StatusOK {
		t.Fatalf("advance project = %d/%s", advanced.Code, advanced.Body.String())
	}
	staleWorse := strings.Replace(firstBody, `"width":0`, `"width":-1`, 1)
	stale := canvasGraphRequestWithID(t, http.MethodPut, "/api/v1/canvas/projects/"+id, owner, staleWorse, uuid.NewString())
	if stale.Code != http.StatusConflict {
		t.Fatalf("new stale request must conflict before graph comparison = %d/%s", stale.Code, stale.Body.String())
	}
	replay := canvasGraphRequestWithID(t, http.MethodPut, "/api/v1/canvas/projects/"+id, owner, firstBody, requestID)
	var replayed model.CanvasProject
	var replayedDocument, firstDocument any
	if replay.Code != http.StatusOK || json.Unmarshal(decodeCanvasResponse(t, replay).Data, &replayed) != nil || json.Unmarshal(replayed.Document, &replayedDocument) != nil || json.Unmarshal([]byte(legacy), &firstDocument) != nil || replayed.Revision != accepted.Revision || replayed.CreatedAt != accepted.CreatedAt || replayed.UpdatedAt != accepted.UpdatedAt || replayed.Title != "first accepted" || !equalCanvasJSON(replayedDocument, firstDocument) {
		t.Fatalf("accepted legacy request did not replay its original result = %d/%s", replay.Code, replay.Body.String())
	}
	assertStoredCanvasGraph(t, owner, id, 3, "advanced", advancedLegacy)
}

func TestCanvasShareCopiesLegacyGraphViolations(t *testing.T) {
	suffix := fmt.Sprint(time.Now().UnixNano())
	owner := "graph-share-owner-" + suffix
	recipient := "graph-share-recipient-" + suffix
	id := "graph-share-" + suffix
	legacy := `{"nodes":[{"id":"node-a","type":"text","title":"legacy","position":{"x":0,"y":0},"width":0,"height":10}],"connections":[{"id":"edge-a","fromNodeId":"node-a","toNodeId":"missing"}],"backgroundMode":"lines","showImageInfo":false,"viewport":{"x":0,"y":0,"k":1}}`
	seedCanvasGraphProject(t, id, owner, legacy)
	if err := repository.UpsertPortalMembers([]model.PortalMember{{UserUID: recipient, DisplayName: "recipient", Enabled: true}}); err != nil {
		t.Fatal(err)
	}
	response := canvasRequest(t, http.MethodPost, "/api/v1/canvas/projects/"+id+"/share", owner, `{"revision":1,"recipientUserUids":["`+recipient+`"]}`)
	var result struct {
		Deliveries []struct {
			ProjectID string `json:"projectId"`
			Status    string `json:"status"`
		} `json:"deliveries"`
	}
	if response.Code != http.StatusOK || json.Unmarshal(decodeCanvasResponse(t, response).Data, &result) != nil || len(result.Deliveries) != 1 || result.Deliveries[0].Status != "shared" {
		t.Fatalf("share legacy graph = %d/%s", response.Code, response.Body.String())
	}
	copied, found, err := repository.GetCanvasProject(recipient, result.Deliveries[0].ProjectID)
	if err != nil || !found || copied.Revision != 1 || !strings.Contains(string(copied.Document), `"width":0`) || !strings.Contains(string(copied.Document), `"toNodeId":"missing"`) {
		t.Fatalf("copied legacy graph = %#v, found=%t, err=%v", copied, found, err)
	}
}

func seedCanvasGraphProject(t *testing.T, id, owner, document string) {
	t.Helper()
	item := model.CanvasProject{ID: id, OwnerUID: owner, Title: "seed", Document: model.CanvasProjectDocument(document), Revision: 1, CreatedAt: time.Now().UTC().Format(time.RFC3339Nano), UpdatedAt: time.Now().UTC().Format(time.RFC3339Nano)}
	if _, inserted, err := repository.CreateCanvasProject(item); err != nil || !inserted {
		t.Fatalf("seed canvas project: inserted=%t err=%v", inserted, err)
	}
}

func assertStoredCanvasGraph(t *testing.T, owner, id string, revision int, title, document string) {
	t.Helper()
	stored, found, err := repository.GetCanvasProject(owner, id)
	if err != nil || !found {
		t.Fatalf("load stored graph: found=%t err=%v", found, err)
	}
	var got, want any
	if json.Unmarshal(stored.Document, &got) != nil || json.Unmarshal([]byte(document), &want) != nil || !equalCanvasJSON(got, want) || stored.Revision != revision || stored.Title != title {
		t.Fatalf("stored graph changed: revision=%d title=%q document=%s", stored.Revision, stored.Title, stored.Document)
	}
}

func equalCanvasJSON(left, right any) bool {
	leftJSON, _ := json.Marshal(left)
	rightJSON, _ := json.Marshal(right)
	return string(leftJSON) == string(rightJSON)
}

func canvasGraphRequestWithID(t *testing.T, method, path, owner, body, requestID string) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(method, path, strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-Portal-User-Uid", owner)
	request.Header.Set("X-Canvas-Request-Id", requestID)
	response := httptest.NewRecorder()
	New().ServeHTTP(response, request)
	return response
}
