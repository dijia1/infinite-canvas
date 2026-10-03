package router

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func workflowRequest(method, path, owner, body string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, path, strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	if owner != "" {
		request.Header.Set("X-Portal-User-Uid", owner)
	}
	response := httptest.NewRecorder()
	servePortalRequest(response, request)
	return response
}

func workflowResponse(t *testing.T, response *httptest.ResponseRecorder) struct {
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
		t.Fatalf("decode workflow response %q: %v", response.Body.String(), err)
	}
	return payload
}

func TestWorkflowRoutesRequirePortalIdentity(t *testing.T) {
	response := workflowRequest(http.MethodGet, "/api/v1/workflows", fixtureUID(""), "")
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated workflow list = %d/%s", response.Code, response.Body.String())
	}
}

func TestWorkflowOwnerCRUDPaginationCopyDeleteAndRevisionConflict(t *testing.T) {
	stamp := time.Now().Format("20060102150405.000000000")
	owner := fixtureUID("workflow-owner-" + stamp)
	create := workflowRequest(http.MethodPost, "/api/v1/workflows", owner, `{"name":"  图片视频流程  ","graph":{"version":1,"nodes":[{"id":"image","type":"image_input","position":{"x":0,"y":0}},{"id":"prompt","type":"text_input","position":{"x":0,"y":120},"text":"产品图"},{"id":"generate","type":"image_generation","position":{"x":300,"y":0},"inputPorts":[{"id":"image","type":"image"},{"id":"prompt","type":"text"}],"config":{"providerId":"image-provider","size":"1024x1024","options":{"seed":1}},"outputs":[{"id":"slot-a","type":"image"},{"id":"slot-b","type":"image"}]}],"connections":[{"sourceNodeId":"image","sourceSlotId":"output","targetNodeId":"generate","targetPortId":"image","order":0},{"sourceNodeId":"prompt","sourceSlotId":"output","targetNodeId":"generate","targetPortId":"prompt","order":2}]}}`)
	if create.Code != http.StatusOK || workflowResponse(t, create).Code != 0 {
		t.Fatalf("create workflow = %d/%s", create.Code, create.Body.String())
	}
	var created struct {
		ID       string `json:"id"`
		Name     string `json:"name"`
		Revision int    `json:"revision"`
		Graph    struct {
			Version int `json:"version"`
			Nodes   []struct {
				ID      string `json:"id"`
				Outputs []struct {
					ID string `json:"id"`
				} `json:"outputs"`
			} `json:"nodes"`
		} `json:"graph"`
	}
	if err := json.Unmarshal(workflowResponse(t, create).Data, &created); err != nil || created.ID == "" || created.Name != "图片视频流程" || created.Revision != 1 || created.Graph.Version != 1 || len(created.Graph.Nodes[2].Outputs) != 2 || created.Graph.Nodes[2].Outputs[0].ID != "slot-a" {
		t.Fatalf("created workflow = %#v err=%v body=%s", created, err, create.Body.String())
	}

	for _, name := range []string{"分页二", "分页三"} {
		response := workflowRequest(http.MethodPost, "/api/v1/workflows", owner, `{"name":"`+name+`"}`)
		if response.Code != http.StatusOK || workflowResponse(t, response).Code != 0 {
			t.Fatalf("create %s = %d/%s", name, response.Code, response.Body.String())
		}
	}
	list := workflowRequest(http.MethodGet, "/api/v1/workflows?page=2&pageSize=1", owner, "")
	var listed struct {
		Items []struct {
			ID              string `json:"id"`
			NodeCount       int    `json:"nodeCount"`
			ConnectionCount int    `json:"connectionCount"`
		} `json:"items"`
		Total    int64 `json:"total"`
		Page     int   `json:"page"`
		PageSize int   `json:"pageSize"`
	}
	if list.Code != http.StatusOK || json.Unmarshal(workflowResponse(t, list).Data, &listed) != nil || listed.Total != 3 || listed.Page != 2 || listed.PageSize != 1 || len(listed.Items) != 1 {
		t.Fatalf("paginated list = %d/%s decoded=%#v", list.Code, list.Body.String(), listed)
	}

	other := workflowRequest(http.MethodGet, "/api/v1/workflows/"+created.ID, fixtureUID("other-"+owner), "")
	if other.Code != http.StatusOK || workflowResponse(t, other).Code != 1 {
		t.Fatalf("cross-owner get = %d/%s", other.Code, other.Body.String())
	}

	update := workflowRequest(http.MethodPut, "/api/v1/workflows/"+created.ID, owner, `{"revision":1,"name":"更新流程","graph":{"version":1,"nodes":[{"id":"draft-text","type":"text_input","position":{"x":1,"y":2}}],"connections":[]}}`)
	var updated struct {
		Name     string `json:"name"`
		Revision int    `json:"revision"`
	}
	if update.Code != http.StatusOK || json.Unmarshal(workflowResponse(t, update).Data, &updated) != nil || updated.Name != "更新流程" || updated.Revision != 2 {
		t.Fatalf("update workflow = %d/%s decoded=%#v", update.Code, update.Body.String(), updated)
	}
	conflict := workflowRequest(http.MethodPut, "/api/v1/workflows/"+created.ID, owner, `{"revision":1,"name":"过期更新","graph":{"version":1,"nodes":[],"connections":[]}}`)
	var conflictData struct {
		Code              string `json:"code"`
		WorkflowID        string `json:"workflowId"`
		RequestedRevision int    `json:"requestedRevision"`
		ServerRevision    int    `json:"serverRevision"`
	}
	if conflict.Code != http.StatusConflict || json.Unmarshal(workflowResponse(t, conflict).Data, &conflictData) != nil || conflictData.Code != "workflow_revision_conflict" || conflictData.WorkflowID != created.ID || conflictData.RequestedRevision != 1 || conflictData.ServerRevision != 2 {
		t.Fatalf("revision conflict = %d/%s decoded=%#v", conflict.Code, conflict.Body.String(), conflictData)
	}

	copyResponse := workflowRequest(http.MethodPost, "/api/v1/workflows/"+created.ID+"/copy", owner, `{"name":"更新流程副本"}`)
	var copied struct {
		ID       string `json:"id"`
		Name     string `json:"name"`
		Revision int    `json:"revision"`
		Graph    struct {
			Nodes []struct {
				ID string `json:"id"`
			} `json:"nodes"`
		} `json:"graph"`
	}
	if copyResponse.Code != http.StatusOK || json.Unmarshal(workflowResponse(t, copyResponse).Data, &copied) != nil || copied.ID == "" || copied.ID == created.ID || copied.Name != "更新流程副本" || copied.Revision != 1 || len(copied.Graph.Nodes) != 1 || copied.Graph.Nodes[0].ID != "draft-text" {
		t.Fatalf("copy workflow = %d/%s decoded=%#v", copyResponse.Code, copyResponse.Body.String(), copied)
	}
	deleted := workflowRequest(http.MethodDelete, "/api/v1/workflows/"+copied.ID, owner, `{"revision":1}`)
	if deleted.Code != http.StatusOK || workflowResponse(t, deleted).Code != 0 {
		t.Fatalf("delete copied workflow = %d/%s", deleted.Code, deleted.Body.String())
	}
}

func TestWorkflowRoutesRejectCyclesLimitsAndUnknownURLFields(t *testing.T) {
	owner := fixtureUID("workflow-validation-" + time.Now().Format("20060102150405.000000000"))
	tests := []struct {
		name string
		body string
	}{
		{
			name: "cycle",
			body: `{"name":"循环","graph":{"version":1,"nodes":[{"id":"a","type":"image_generation","position":{"x":0,"y":0},"inputPorts":[{"id":"in","type":"image"}],"outputs":[{"id":"out","type":"image"}]},{"id":"b","type":"image_generation","position":{"x":200,"y":0},"inputPorts":[{"id":"in","type":"image"}],"outputs":[{"id":"out","type":"image"}]}],"connections":[{"sourceNodeId":"a","sourceSlotId":"out","targetNodeId":"b","targetPortId":"in","order":0},{"sourceNodeId":"b","sourceSlotId":"out","targetNodeId":"a","targetPortId":"in","order":0}]}}`,
		},
		{
			name: "ten outputs",
			body: `{"name":"十输出","graph":{"version":1,"nodes":[{"id":"a","type":"image_generation","position":{"x":0,"y":0},"outputs":[{"id":"1","type":"image"},{"id":"2","type":"image"},{"id":"3","type":"image"},{"id":"4","type":"image"},{"id":"5","type":"image"},{"id":"6","type":"image"},{"id":"7","type":"image"},{"id":"8","type":"image"},{"id":"9","type":"image"},{"id":"10","type":"image"}]}],"connections":[]}}`,
		},
		{
			name: "unknown signed url field",
			body: `{"name":"地址","graph":{"version":1,"nodes":[{"id":"image","type":"image_input","position":{"x":0,"y":0},"previewUrl":"https://signed.example/image.png"}],"connections":[]}}`,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			response := workflowRequest(http.MethodPost, "/api/v1/workflows", owner, test.body)
			if response.Code != http.StatusBadRequest || workflowResponse(t, response).Code != 1 {
				t.Fatalf("invalid workflow = %d/%s", response.Code, response.Body.String())
			}
		})
	}
}
