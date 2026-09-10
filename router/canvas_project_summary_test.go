package router

import (
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/repository"
)

func TestCanvasProjectListReturnsSummariesAndKeepsFullDetailContracts(t *testing.T) {
	stamp := time.Now().Format("20060102150405.000000000")
	owner := "canvas-summary-route-owner-" + stamp
	otherOwner := "canvas-summary-route-other-" + stamp
	currentID := "canvas-summary-current-" + stamp
	emptyID := "canvas-summary-empty-" + stamp
	legacyID := "canvas-summary-legacy-" + stamp
	currentDocument := `{"nodes":[{"id":"image-1","type":"image","title":"图片","position":{"x":0,"y":0},"width":100,"height":80,"metadata":{"content":"blob:https://canvas.local/transient"}},{"id":"text-1","type":"text","title":"文本","position":{"x":120,"y":0},"width":100,"height":80}],"connections":[{"id":"line-1","fromNodeId":"image-1","toNodeId":"text-1"}],"backgroundMode":"lines","showImageInfo":false,"viewport":{"x":0,"y":0,"k":1}}`

	for _, request := range []struct {
		owner string
		id    string
		title string
		doc   string
	}{
		{owner: owner, id: currentID, title: "当前画布", doc: currentDocument},
		{owner: owner, id: emptyID, title: "空画布", doc: `{"nodes":[],"connections":[],"backgroundMode":"blank","showImageInfo":false,"viewport":{"x":0,"y":0,"k":1}}`},
		{owner: otherOwner, id: currentID, title: "其他用户同 ID 画布", doc: `{"nodes":[{"id":"other","type":"text","title":"其他","position":{"x":0,"y":0},"width":100,"height":80}],"connections":[],"backgroundMode":"dots","showImageInfo":false,"viewport":{"x":0,"y":0,"k":1}}`},
	} {
		response := canvasRequest(t, http.MethodPost, "/api/v1/canvas/projects", request.owner, `{"id":"`+request.id+`","title":"`+request.title+`","document":`+request.doc+`}`)
		if response.Code != http.StatusOK || decodeCanvasResponse(t, response).Code != 0 {
			t.Fatalf("create %q = %d/%s", request.id, response.Code, response.Body.String())
		}
	}

	detail := canvasRequest(t, http.MethodGet, "/api/v1/canvas/projects/"+currentID, owner, "")
	var fullDetail struct {
		Document struct {
			Nodes []struct {
				Metadata map[string]any `json:"metadata"`
			} `json:"nodes"`
			Connections []json.RawMessage `json:"connections"`
		} `json:"document"`
	}
	if detail.Code != http.StatusOK || json.Unmarshal(decodeCanvasResponse(t, detail).Data, &fullDetail) != nil || len(fullDetail.Document.Nodes) != 2 || len(fullDetail.Document.Connections) != 1 {
		t.Fatalf("canvas detail did not retain its full document contract: %d/%s", detail.Code, detail.Body.String())
	}
	if _, exists := fullDetail.Document.Nodes[0].Metadata["content"]; exists {
		t.Fatalf("canvas detail contains transient content after sanitization: %s", detail.Body.String())
	}

	importOwner := "canvas-summary-import-owner-" + stamp
	importID := "canvas-summary-import-" + stamp
	imported := canvasRequest(t, http.MethodPost, "/api/v1/canvas/projects/import", importOwner, `{"projects":[{"id":"`+importID+`","title":"导入画布","document":{"nodes":[],"connections":[],"backgroundMode":"lines","showImageInfo":false,"viewport":{"x":0,"y":0,"k":1}}}]}`)
	var importResult struct {
		Items []struct {
			ID       string          `json:"id"`
			Document json.RawMessage `json:"document"`
		} `json:"items"`
		Total int `json:"total"`
	}
	if imported.Code != http.StatusOK || json.Unmarshal(decodeCanvasResponse(t, imported).Data, &importResult) != nil || importResult.Total != 1 || len(importResult.Items) != 1 || importResult.Items[0].ID != importID || len(importResult.Items[0].Document) == 0 {
		t.Fatalf("canvas import did not retain full documents: %d/%s", imported.Code, imported.Body.String())
	}

	database, err := repository.DB()
	if err != nil {
		t.Fatal(err)
	}
	if err := database.Create(&model.CanvasProject{
		ID: legacyID, OwnerUID: owner, Title: "缺少数组的旧画布", Revision: 3,
		Document:  model.CanvasProjectDocument(`{"viewport":{"x":0,"y":0,"k":1}}`),
		CreatedAt: "2026-09-10T01:00:00Z", UpdatedAt: "2026-09-10T01:00:00Z",
	}).Error; err != nil {
		t.Fatal(err)
	}

	list := canvasRequest(t, http.MethodGet, "/api/v1/canvas/projects", owner, "")
	var listResult struct {
		Items []json.RawMessage `json:"items"`
		Total int               `json:"total"`
	}
	if list.Code != http.StatusOK || json.Unmarshal(decodeCanvasResponse(t, list).Data, &listResult) != nil || listResult.Total != 3 || len(listResult.Items) != 3 {
		t.Fatalf("owner summary list = %d/%s", list.Code, list.Body.String())
	}
	wantCounts := map[string][2]int{
		currentID: {2, 1},
		emptyID:   {0, 0},
		legacyID:  {0, 0},
	}
	for _, encoded := range listResult.Items {
		var fields map[string]json.RawMessage
		if err := json.Unmarshal(encoded, &fields); err != nil {
			t.Fatal(err)
		}
		if _, exists := fields["document"]; exists {
			t.Fatalf("canvas list item contains document: %s", encoded)
		}
		var summary struct {
			ID              string `json:"id"`
			NodeCount       int    `json:"nodeCount"`
			ConnectionCount int    `json:"connectionCount"`
		}
		if err := json.Unmarshal(encoded, &summary); err != nil {
			t.Fatal(err)
		}
		want, ok := wantCounts[summary.ID]
		if !ok {
			t.Fatalf("canvas list leaked another owner's project %q: %s", summary.ID, list.Body.String())
		}
		if summary.NodeCount != want[0] || summary.ConnectionCount != want[1] {
			t.Errorf("summary %q counts = (%d, %d), want (%d, %d)", summary.ID, summary.NodeCount, summary.ConnectionCount, want[0], want[1])
		}
	}
}
