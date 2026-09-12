package router

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/repository"
)

const workflowFrameRouteBody = `{"name":"Frame Flow","frameSchemaVersion":1,"graph":{"version":1,"nodes":[{"id":"prompt","type":"text_input","position":{"x":0,"y":0},"text":"hello"},{"id":"generate","type":"image_generation","position":{"x":100,"y":0},"inputPorts":[{"id":"prompt","type":"text"}],"config":{"providerId":"workflow-route-provider","resolution":"1k"},"outputs":[{"id":"slot","type":"image"}]},{"id":"outside-generate","type":"image_generation","position":{"x":800,"y":0},"inputPorts":[{"id":"image","type":"image"}],"config":{"providerId":"workflow-route-provider","resolution":"1k"},"outputs":[{"id":"outside-slot","type":"image"}]}],"connections":[{"sourceNodeId":"prompt","sourceSlotId":"output","targetNodeId":"generate","targetPortId":"prompt","order":0},{"sourceNodeId":"generate","sourceSlotId":"slot","targetNodeId":"outside-generate","targetPortId":"image","order":0}],"frames":[{"id":"frame-a","name":"A","position":{"x":0,"y":0},"width":600,"height":400,"nodeIds":["generate"]},{"id":"frame-b","name":"B","position":{"x":700,"y":0},"width":600,"height":400,"nodeIds":["outside-generate"]}]}}`

func TestWorkflowFrameRunContractAndOverview(t *testing.T) {
	restore := configureWorkflowRouteRuntime(t)
	defer restore()
	owner := "workflow-frame-contract-" + time.Now().Format("150405.000000000")
	seedRouteWorkflowMember(t, owner, true)
	created := workflowRequest(http.MethodPost, "/api/v1/workflows", owner, workflowFrameRouteBody)
	var workflow model.Workflow
	if created.Code != http.StatusOK || json.Unmarshal(workflowResponse(t, created).Data, &workflow) != nil {
		t.Fatalf("create = %d/%s", created.Code, created.Body.String())
	}
	missingRevision := workflowRequest(http.MethodPost, "/api/v1/workflows/"+workflow.ID+"/runs", owner, `{"requestId":"missing-revision","scope":{"type":"frame","frameId":"frame-a"}}`)
	if missingRevision.Code != http.StatusBadRequest {
		t.Fatalf("missing revision = %d/%s", missingRevision.Code, missingRevision.Body.String())
	}
	accepted := workflowRequest(http.MethodPost, "/api/v1/workflows/"+workflow.ID+"/runs", owner, `{"requestId":"frame-run","revision":1,"scope":{"type":"frame","frameId":"frame-a"}}`)
	var detail struct {
		Run     model.WorkflowRun               `json:"run"`
		Graph   model.WorkflowGraph             `json:"graph"`
		Steps   []model.WorkflowStepExecution   `json:"steps"`
		Outputs []model.WorkflowOutputExecution `json:"outputs"`
	}
	if accepted.Code != http.StatusOK || json.Unmarshal(workflowResponse(t, accepted).Data, &detail) != nil || detail.Run.ScopeType != model.WorkflowRunScopeFrame || detail.Run.FrameName != "A" || len(detail.Graph.Frames) != 0 || len(detail.Graph.Nodes) != 2 || len(detail.Graph.Connections) != 1 || len(detail.Steps) != 1 || detail.Steps[0].NodeID != "generate" || len(detail.Outputs) != 1 || detail.Outputs[0].NodeID != "generate" {
		t.Fatalf("frame run = %d/%s decoded=%#v", accepted.Code, accepted.Body.String(), detail)
	}
	replayWithoutRevision := workflowRequest(http.MethodPost, "/api/v1/workflows/"+workflow.ID+"/runs", owner, `{"requestId":"frame-run","scope":{"type":"frame","frameId":"frame-a"}}`)
	var replayed struct {
		Run model.WorkflowRun `json:"run"`
	}
	if replayWithoutRevision.Code != http.StatusOK || json.Unmarshal(workflowResponse(t, replayWithoutRevision).Data, &replayed) != nil || replayed.Run.ID != detail.Run.ID {
		t.Fatalf("accepted replay without revision = %d/%s", replayWithoutRevision.Code, replayWithoutRevision.Body.String())
	}
	mismatchedReplay := workflowRequest(http.MethodPost, "/api/v1/workflows/"+workflow.ID+"/runs", owner, `{"requestId":"frame-run","revision":2,"scope":{"type":"frame","frameId":"frame-a"}}`)
	var mismatchData map[string]any
	_ = json.Unmarshal(workflowResponse(t, mismatchedReplay).Data, &mismatchData)
	if mismatchedReplay.Code != http.StatusConflict || mismatchData["code"] != "workflow_run_request_mismatch" {
		t.Fatalf("mismatched replay = %d/%s", mismatchedReplay.Code, mismatchedReplay.Body.String())
	}
	externalGeneration := workflowRequest(http.MethodPost, "/api/v1/workflows/"+workflow.ID+"/runs", owner, `{"requestId":"frame-b-run","revision":1,"scope":{"type":"frame","frameId":"frame-b"}}`)
	var externalData map[string]any
	_ = json.Unmarshal(workflowResponse(t, externalGeneration).Data, &externalData)
	if externalGeneration.Code != http.StatusBadRequest || externalData["code"] != "workflow_frame_external_generation" || externalData["sourceNodeId"] != "generate" || externalData["targetNodeId"] != "outside-generate" {
		t.Fatalf("external generation = %d/%s", externalGeneration.Code, externalGeneration.Body.String())
	}
	conflict := workflowRequest(http.MethodPost, "/api/v1/workflows/"+workflow.ID+"/runs", owner, `{"requestId":"frame-run-2","revision":1,"scope":{"type":"frame","frameId":"frame-a"}}`)
	payload := workflowResponse(t, conflict)
	var conflictData map[string]any
	_ = json.Unmarshal(payload.Data, &conflictData)
	if conflict.Code != http.StatusConflict || conflictData["code"] != "workflow_run_scope_active" || conflictData["runId"] != detail.Run.ID {
		t.Fatalf("conflict = %d/%s", conflict.Code, conflict.Body.String())
	}
	overview := workflowRequest(http.MethodGet, "/api/v1/workflows/"+workflow.ID+"/run-state?activePage=1&activePageSize=20", owner, "")
	var state struct {
		WorkflowID string            `json:"workflowId"`
		Revision   int               `json:"revision"`
		NodeRunIDs map[string]string `json:"nodeRunIds"`
		ActiveRuns struct {
			Total int64 `json:"total"`
		} `json:"activeRuns"`
	}
	if overview.Code != http.StatusOK || json.Unmarshal(workflowResponse(t, overview).Data, &state) != nil || state.WorkflowID != workflow.ID || state.NodeRunIDs["generate"] != detail.Run.ID || state.ActiveRuns.Total != 1 {
		t.Fatalf("overview = %d/%s decoded=%#v", overview.Code, overview.Body.String(), state)
	}
	filtered := workflowRequest(http.MethodGet, "/api/v1/workflow-runs?workflowId="+workflow.ID+"&scopeType=frame&frameId=frame-a&active=1", owner, "")
	var list struct {
		Items []model.WorkflowRun `json:"items"`
		Total int64               `json:"total"`
	}
	if filtered.Code != http.StatusOK || json.Unmarshal(workflowResponse(t, filtered).Data, &list) != nil || list.Total != 1 || len(list.Items) != 1 || list.Items[0].ID != detail.Run.ID {
		t.Fatalf("filtered runs = %d/%s decoded=%#v", filtered.Code, filtered.Body.String(), list)
	}
}

func TestWorkflowFrameRunReplaySurvivesFrameRemoval(t *testing.T) {
	restore := configureWorkflowRouteRuntime(t)
	defer restore()
	owner := "workflow-frame-replay-" + time.Now().Format("150405.000000000")
	seedRouteWorkflowMember(t, owner, true)
	created := workflowRequest(http.MethodPost, "/api/v1/workflows", owner, workflowFrameRouteBody)
	var workflow model.Workflow
	if created.Code != http.StatusOK || json.Unmarshal(workflowResponse(t, created).Data, &workflow) != nil {
		t.Fatalf("create = %d/%s", created.Code, created.Body.String())
	}
	path := "/api/v1/workflows/" + workflow.ID + "/runs"
	first := workflowRequest(http.MethodPost, path, owner, `{"requestId":"durable-frame-replay","revision":1,"scope":{"type":"frame","frameId":"frame-a"}}`)
	var original struct {
		Run model.WorkflowRun `json:"run"`
	}
	if first.Code != http.StatusOK || json.Unmarshal(workflowResponse(t, first).Data, &original) != nil {
		t.Fatalf("first = %d/%s", first.Code, first.Body.String())
	}
	workflow.Graph.Frames = nil
	updateBody, _ := json.Marshal(map[string]any{"name": workflow.Name, "revision": 1, "frameSchemaVersion": 1, "graph": workflow.Graph})
	updated := workflowRequest(http.MethodPut, "/api/v1/workflows/"+workflow.ID, owner, string(updateBody))
	if updated.Code != http.StatusOK {
		t.Fatalf("remove frame = %d/%s", updated.Code, updated.Body.String())
	}
	replay := workflowRequest(http.MethodPost, path, owner, `{"requestId":"durable-frame-replay","revision":1,"scope":{"type":"frame","frameId":"frame-a"}}`)
	var repeated struct {
		Run model.WorkflowRun `json:"run"`
	}
	if replay.Code != http.StatusOK || json.Unmarshal(workflowResponse(t, replay).Data, &repeated) != nil || repeated.Run.ID != original.Run.ID || repeated.Run.FrameName != "A" {
		t.Fatalf("replay after removal = %d/%s decoded=%#v", replay.Code, replay.Body.String(), repeated)
	}
}

func TestWorkflowFrameClientCapabilityGuardReturnsTypedConflict(t *testing.T) {
	restore := configureWorkflowRouteRuntime(t)
	defer restore()
	owner := "workflow-frame-guard-" + time.Now().Format("150405.000000000")
	seedRouteWorkflowMember(t, owner, true)
	body := `{"name":"Frame Flow","frameSchemaVersion":1,"graph":{"version":1,"nodes":[],"connections":[],"frames":[{"id":"frame-a","name":"A","position":{"x":0,"y":0},"width":600,"height":400,"nodeIds":[]}]}}`
	created := workflowRequest(http.MethodPost, "/api/v1/workflows", owner, body)
	var workflow model.Workflow
	if created.Code != http.StatusOK || json.Unmarshal(workflowResponse(t, created).Data, &workflow) != nil {
		t.Fatalf("create = %d/%s", created.Code, created.Body.String())
	}
	update := workflowRequest(http.MethodPut, "/api/v1/workflows/"+workflow.ID, owner, `{"name":"old client","revision":1,"graph":{"version":1,"nodes":[],"connections":[]}}`)
	payload := workflowResponse(t, update)
	var data map[string]any
	_ = json.Unmarshal(payload.Data, &data)
	if update.Code != http.StatusConflict || data["code"] != "workflow_frame_client_outdated" {
		t.Fatalf("update = %d/%s", update.Code, update.Body.String())
	}
}

func TestWorkflowFrameRunLockedRevisionConflictReportsCurrentServerRevision(t *testing.T) {
	restore := configureWorkflowRouteRuntime(t)
	defer restore()
	owner := "workflow-frame-revision-race-" + time.Now().Format("150405.000000000")
	seedRouteWorkflowMember(t, owner, true)
	created := workflowRequest(http.MethodPost, "/api/v1/workflows", owner, workflowFrameRouteBody)
	var workflow model.Workflow
	if created.Code != http.StatusOK || json.Unmarshal(workflowResponse(t, created).Data, &workflow) != nil {
		t.Fatalf("create = %d/%s", created.Code, created.Body.String())
	}
	database, _ := repository.DB()
	blocker := database.Begin()
	if blocker.Error != nil {
		t.Fatal(blocker.Error)
	}
	defer blocker.Rollback()
	identity := fmt.Sprintf("%d:%s:%d:%s", len(owner), owner, len(workflow.ID), workflow.ID)
	if err := blocker.Exec(`SELECT pg_advisory_xact_lock(hashtextextended(?, ?))`, identity, int64(0x6672616d6552756e)).Error; err != nil {
		t.Fatal(err)
	}
	result := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		result <- workflowRequest(http.MethodPost, "/api/v1/workflows/"+workflow.ID+"/runs", owner, `{"requestId":"revision-race-run","revision":1,"scope":{"type":"frame","frameId":"frame-a"}}`)
	}()
	deadline := time.Now().Add(5 * time.Second)
	for {
		var waiting int64
		if err := database.Raw(`SELECT COUNT(*) FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND wait_event = 'advisory' AND query LIKE '%pg_advisory_xact_lock(hashtextextended%'`).Scan(&waiting).Error; err != nil {
			t.Fatal(err)
		}
		if waiting > 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("run request did not reach admission advisory lock")
		}
		time.Sleep(10 * time.Millisecond)
	}
	updateBody, _ := json.Marshal(map[string]any{"name": workflow.Name, "revision": workflow.Revision, "frameSchemaVersion": 1, "graph": workflow.Graph})
	updated := workflowRequest(http.MethodPut, "/api/v1/workflows/"+workflow.ID, owner, string(updateBody))
	if updated.Code != http.StatusOK {
		t.Fatalf("concurrent update = %d/%s", updated.Code, updated.Body.String())
	}
	if err := blocker.Rollback().Error; err != nil {
		t.Fatal(err)
	}
	var response *httptest.ResponseRecorder
	select {
	case response = <-result:
	case <-time.After(5 * time.Second):
		t.Fatal("run request did not finish after releasing admission lock")
	}
	var data map[string]any
	_ = json.Unmarshal(workflowResponse(t, response).Data, &data)
	if response.Code != http.StatusConflict || data["code"] != "workflow_revision_conflict" || data["requestedRevision"] != float64(1) || data["serverRevision"] != float64(2) {
		t.Fatalf("locked revision conflict = %d/%s", response.Code, response.Body.String())
	}
}

func TestWorkflowFrameRunReferencesOnlySelectedMediaAndRollsBackUnavailableMedia(t *testing.T) {
	restore := configureWorkflowRouteRuntime(t)
	defer restore()
	owner := "workflow-frame-media-" + time.Now().Format("150405.000000000")
	seedRouteWorkflowMember(t, owner, true)
	used, err := repository.SaveMedia(model.Media{ID: "frame-used-media-" + owner, OwnerUID: owner, Source: model.MediaSourceUpload, ObjectKey: "frame/used/" + owner, ContentType: "image/png", CleanupStatus: model.MediaCleanupActive})
	if err != nil {
		t.Fatal(err)
	}
	unused, err := repository.SaveMedia(model.Media{ID: "frame-unused-media-" + owner, OwnerUID: owner, Source: model.MediaSourceUpload, ObjectKey: "frame/unused/" + owner, ContentType: "image/png", CleanupStatus: model.MediaCleanupActive})
	if err != nil {
		t.Fatal(err)
	}
	graph := model.WorkflowGraph{Version: 1, Nodes: []model.WorkflowNode{
		{ID: "used-input", Type: model.WorkflowNodeImageInput, MediaID: used.ID, Position: model.WorkflowPoint{X: 0, Y: 0}},
		{ID: "unused-input", Type: model.WorkflowNodeImageInput, MediaID: unused.ID, Position: model.WorkflowPoint{X: 800, Y: 0}},
		{ID: "prompt", Type: model.WorkflowNodeTextInput, Text: "frame media", Position: model.WorkflowPoint{X: 0, Y: 100}},
		{ID: "generate", Type: model.WorkflowNodeImageGeneration, Position: model.WorkflowPoint{X: 200, Y: 0}, InputPorts: []model.WorkflowInputPort{{ID: "image", Type: model.WorkflowPortImage}, {ID: "prompt", Type: model.WorkflowPortText}}, Config: &model.WorkflowNodeConfig{ProviderID: "workflow-route-provider", Resolution: "1k"}, Outputs: []model.WorkflowOutputSlot{{ID: "slot", Type: model.WorkflowPortImage}}},
	}, Connections: []model.WorkflowConnection{
		{SourceNodeID: "used-input", SourceSlotID: "output", TargetNodeID: "generate", TargetPortID: "image"},
		{SourceNodeID: "prompt", SourceSlotID: "output", TargetNodeID: "generate", TargetPortID: "prompt", Order: 1},
	}, Frames: []model.WorkflowFrame{{ID: "frame-a", Name: "A", Position: model.WorkflowPoint{X: 100, Y: 0}, Width: 600, Height: 400, NodeIDs: []string{"generate"}}}}
	body, _ := json.Marshal(map[string]any{"name": "Frame Media", "frameSchemaVersion": 1, "graph": graph})
	created := workflowRequest(http.MethodPost, "/api/v1/workflows", owner, string(body))
	var workflow model.Workflow
	if created.Code != http.StatusOK || json.Unmarshal(workflowResponse(t, created).Data, &workflow) != nil {
		t.Fatalf("create = %d/%s", created.Code, created.Body.String())
	}
	path := "/api/v1/workflows/" + workflow.ID + "/runs"
	accepted := workflowRequest(http.MethodPost, path, owner, `{"requestId":"selected-media-run","revision":1,"scope":{"type":"frame","frameId":"frame-a"}}`)
	var detail struct {
		Run model.WorkflowRun `json:"run"`
	}
	if accepted.Code != http.StatusOK || json.Unmarshal(workflowResponse(t, accepted).Data, &detail) != nil {
		t.Fatalf("run = %d/%s", accepted.Code, accepted.Body.String())
	}
	database, _ := repository.DB()
	var refs []model.WorkflowMediaRef
	if err := database.Where("owner_uid = ? AND scope = 'run' AND scope_id = ?", owner, detail.Run.ID).Order("media_id").Find(&refs).Error; err != nil {
		t.Fatal(err)
	}
	if len(refs) != 1 || refs[0].MediaID != used.ID {
		t.Fatalf("selected run refs = %#v", refs)
	}
	if err := database.Model(&model.WorkflowRun{}).Where("id = ?", detail.Run.ID).Update("status", "completed").Error; err != nil {
		t.Fatal(err)
	}
	var baselineSteps, baselineOutputs int64
	if err := database.Model(&model.WorkflowStepExecution{}).Count(&baselineSteps).Error; err != nil {
		t.Fatal(err)
	}
	if err := database.Model(&model.WorkflowOutputExecution{}).Count(&baselineOutputs).Error; err != nil {
		t.Fatal(err)
	}
	blocker := database.Begin()
	if blocker.Error != nil {
		t.Fatal(blocker.Error)
	}
	defer blocker.Rollback()
	identity := fmt.Sprintf("%d:%s:%d:%s", len(owner), owner, len(workflow.ID), workflow.ID)
	if err := blocker.Exec(`SELECT pg_advisory_xact_lock(hashtextextended(?, ?))`, identity, int64(0x6672616d6552756e)).Error; err != nil {
		t.Fatal(err)
	}
	result := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		result <- workflowRequest(http.MethodPost, path, owner, `{"requestId":"unavailable-media-run","revision":1,"scope":{"type":"frame","frameId":"frame-a"}}`)
	}()
	deadline := time.Now().Add(5 * time.Second)
	for {
		var waiting int64
		if err := database.Raw(`SELECT COUNT(*) FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND wait_event = 'advisory' AND query LIKE '%pg_advisory_xact_lock(hashtextextended%'`).Scan(&waiting).Error; err != nil {
			t.Fatal(err)
		}
		if waiting > 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("media run did not reach admission advisory lock")
		}
		time.Sleep(10 * time.Millisecond)
	}
	if err := database.Model(&model.Media{}).Where("id = ?", used.ID).Update("cleanup_status", model.MediaCleanupDeleting).Error; err != nil {
		t.Fatal(err)
	}
	if err := blocker.Rollback().Error; err != nil {
		t.Fatal(err)
	}
	var response *httptest.ResponseRecorder
	select {
	case response = <-result:
	case <-time.After(5 * time.Second):
		t.Fatal("unavailable media run did not finish")
	}
	payload := workflowResponse(t, response)
	if response.Code != http.StatusBadRequest || payload.Code != 1 {
		t.Fatalf("unavailable media response = %d/%s", response.Code, response.Body.String())
	}
	var runCount, stepCount, outputCount int64
	if err := database.Model(&model.WorkflowRun{}).Where("owner_uid = ? AND request_id = ?", owner, "unavailable-media-run").Count(&runCount).Error; err != nil {
		t.Fatal(err)
	}
	if err := database.Model(&model.WorkflowStepExecution{}).Count(&stepCount).Error; err != nil {
		t.Fatal(err)
	}
	if err := database.Model(&model.WorkflowOutputExecution{}).Count(&outputCount).Error; err != nil {
		t.Fatal(err)
	}
	if runCount != 0 || stepCount != baselineSteps || outputCount != baselineOutputs {
		t.Fatalf("rolled back rows: runs=%d steps=%d/%d outputs=%d/%d", runCount, stepCount, baselineSteps, outputCount, baselineOutputs)
	}
}
