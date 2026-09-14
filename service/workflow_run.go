package service

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/basketikun/infinite-canvas/ai"
	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/repository"
)

type CreateWorkflowRunInput struct {
	RequestID string                  `json:"requestId"`
	Revision  *int                    `json:"revision,omitempty"`
	Scope     *model.WorkflowRunScope `json:"scope,omitempty"`
}

type RetryWorkflowOutputInput struct {
	RequestID string `json:"requestId"`
	NodeID    string `json:"nodeId"`
	SlotID    string `json:"slotId"`
}

type WorkflowRunDetail struct {
	Run      model.WorkflowRun               `json:"run"`
	Graph    model.WorkflowGraph             `json:"graph"`
	Steps    []model.WorkflowStepExecution   `json:"steps"`
	Outputs  []model.WorkflowOutputExecution `json:"outputs"`
	Attempts []model.WorkflowOutputAttempt   `json:"attempts"`
}

type WorkflowRunList struct {
	Items    []model.WorkflowRun `json:"items"`
	Total    int64               `json:"total"`
	Page     int                 `json:"page"`
	PageSize int                 `json:"pageSize"`
}

type WorkflowRunListFilter struct {
	WorkflowID string
	ScopeType  string
	FrameID    string
	Active     string
}

type WorkflowRunScopeState struct {
	Scope       model.WorkflowRunScope `json:"scope"`
	LatestRun   *model.WorkflowRun     `json:"latestRun"`
	ActiveRunID *string                `json:"activeRunId"`
}

type WorkflowRunState struct {
	WorkflowID string                  `json:"workflowId"`
	Revision   int                     `json:"revision"`
	Scopes     []WorkflowRunScopeState `json:"scopes"`
	NodeRunIDs map[string]string       `json:"nodeRunIds"`
	ActiveRuns WorkflowRunList         `json:"activeRuns"`
}

func CreateWorkflowRun(ctx context.Context, user PortalUser, workflowID string, input CreateWorkflowRunInput) (WorkflowRunDetail, error) {
	workflowID, err := normalizeWorkflowPathID(workflowID)
	if err != nil {
		return WorkflowRunDetail{}, err
	}
	requestID := strings.TrimSpace(input.RequestID)
	if strings.TrimSpace(user.UID) == "" || requestID == "" || len(requestID) > 128 {
		return WorkflowRunDetail{}, workflowValidationError{message: "运行请求 ID 无效"}
	}
	scope, err := normalizeWorkflowRunScope(input.Scope)
	if err != nil {
		return WorkflowRunDetail{}, err
	}
	if existing, found, err := repository.GetWorkflowRunByRequest(user.UID, requestID); err != nil {
		return WorkflowRunDetail{}, err
	} else if found {
		if err := validateWorkflowRunReplay(existing, workflowID, scope, input.Revision); err != nil {
			return WorkflowRunDetail{}, err
		}
		return GetWorkflowRun(ctx, user, existing.ID)
	}
	if !workflowsEnabled() {
		return WorkflowRunDetail{}, workflowValidationError{message: "自动化流程运行暂不可用"}
	}
	if err := requireEnabledWorkflowMember(user.UID); err != nil {
		return WorkflowRunDetail{}, err
	}
	workflow, err := GetWorkflow(ctx, user, workflowID)
	if err != nil {
		return WorkflowRunDetail{}, err
	}
	if input.Scope != nil && input.Revision == nil {
		return WorkflowRunDetail{}, newWorkflowFrameValidationError("workflow_run_revision_required", "运行指定范围时必须提供流程版本", map[string]any{"workflowId": workflowID})
	}
	if input.Scope == nil && len(workflow.Graph.Frames) > 0 {
		return WorkflowRunDetail{}, newWorkflowFrameValidationError("workflow_run_scope_required", "当前流程包含 Frame，请刷新后明确选择运行范围", map[string]any{"workflowId": workflowID})
	}
	if input.Revision != nil {
		if *input.Revision < 1 {
			return WorkflowRunDetail{}, workflowValidationError{message: "流程版本无效"}
		}
		if *input.Revision != workflow.Revision {
			return WorkflowRunDetail{}, NewWorkflowBusinessError("workflow_revision_conflict", "流程已在其他位置更新，请刷新后重试", map[string]any{"workflowId": workflowID, "requestedRevision": *input.Revision, "serverRevision": workflow.Revision})
		}
	}
	graph, err := normalizeAndSizeWorkflowGraph(workflow.Graph)
	if err != nil {
		return WorkflowRunDetail{}, err
	}
	graph, err = SelectWorkflowRunGraph(graph, scope)
	if err != nil {
		return WorkflowRunDetail{}, err
	}
	if err := validateWorkflowRunInputs(ctx, user, graph); err != nil {
		return WorkflowRunDetail{}, err
	}
	snapshot, err := json.Marshal(graph)
	if err != nil {
		return WorkflowRunDetail{}, err
	}
	current := time.Now().UTC()
	run := model.WorkflowRun{
		ID: newID("workflow-run"), OwnerUID: user.UID, RequestID: requestID, WorkflowID: workflow.ID,
		Revision: workflow.Revision, Title: workflow.Name, ScopeType: scope.Type, FrameID: scope.FrameID, Snapshot: string(snapshot), Status: "pending", StateVersion: 1,
		CreatedAt: current, UpdatedAt: current,
	}
	if scope.Type == model.WorkflowRunScopeFrame {
		for _, frame := range workflow.Graph.Frames {
			if frame.ID == scope.FrameID {
				run.FrameName = frame.Name
				break
			}
		}
	}
	steps := []model.WorkflowStepExecution{}
	outputs := []model.WorkflowOutputExecution{}
	for _, node := range graph.Nodes {
		if node.Type != model.WorkflowNodeImageGeneration && node.Type != model.WorkflowNodeVideoGeneration {
			continue
		}
		steps = append(steps, model.WorkflowStepExecution{RunID: run.ID, NodeID: node.ID, Status: "waiting"})
		for _, slot := range node.Outputs {
			outputs = append(outputs, model.WorkflowOutputExecution{RunID: run.ID, NodeID: node.ID, SlotID: slot.ID, Status: "waiting", Attempt: 1, UpdatedAt: current})
		}
	}
	created, _, err := repository.AdmitWorkflowRun(run, steps, outputs, workflowGraphMediaIDs(graph), workflow.Revision)
	if err != nil {
		if errors.Is(err, repository.ErrWorkflowRevisionConflict) {
			serverRevision := workflow.Revision
			if current, found, readErr := repository.GetWorkflow(user.UID, workflowID); readErr == nil && found {
				serverRevision = current.Revision
			}
			data := map[string]any{"workflowId": workflowID, "serverRevision": serverRevision}
			if input.Revision != nil {
				data["requestedRevision"] = *input.Revision
			}
			return WorkflowRunDetail{}, NewWorkflowBusinessError("workflow_revision_conflict", "流程已在其他位置更新，请刷新后重试", data)
		}
		var conflict *repository.WorkflowRunAdmissionConflict
		if errors.As(err, &conflict) {
			data := map[string]any{"runId": conflict.RunID, "workflowId": workflowID}
			if len(conflict.NodeIDs) > 0 {
				data["nodeIds"] = conflict.NodeIDs
			}
			return WorkflowRunDetail{}, NewWorkflowBusinessError(conflict.Code, "运行范围与已有活跃运行冲突", data)
		}
		return WorkflowRunDetail{}, workflowRepositoryError(err)
	}
	if err := validateWorkflowRunReplay(created, workflowID, scope, input.Revision); err != nil {
		return WorkflowRunDetail{}, err
	}
	return GetWorkflowRun(ctx, user, created.ID)
}

func ListWorkflowRuns(_ context.Context, user PortalUser, filter WorkflowRunListFilter, page, pageSize int) (WorkflowRunList, error) {
	if strings.TrimSpace(user.UID) == "" {
		return WorkflowRunList{}, workflowValidationError{message: "未经过 Portal Gateway 身份验证"}
	}
	workflowID := strings.TrimSpace(filter.WorkflowID)
	if workflowID != "" {
		var err error
		workflowID, err = normalizeWorkflowPathID(workflowID)
		if err != nil {
			return WorkflowRunList{}, err
		}
	}
	query := model.Query{Page: page, PageSize: pageSize}
	query.Normalize()
	scopeType := strings.TrimSpace(filter.ScopeType)
	if scopeType != "" && scopeType != string(model.WorkflowRunScopeWorkflow) && scopeType != string(model.WorkflowRunScopeFrame) {
		return WorkflowRunList{}, workflowValidationError{message: "运行范围筛选无效"}
	}
	frameID := strings.TrimSpace(filter.FrameID)
	if frameID != "" {
		var err error
		frameID, err = normalizeWorkflowIdentifier(frameID, "Frame ID")
		if err != nil {
			return WorkflowRunList{}, err
		}
	}
	if frameID != "" && scopeType != string(model.WorkflowRunScopeFrame) {
		return WorkflowRunList{}, workflowValidationError{message: "Frame 筛选必须指定 frame 范围"}
	}
	if filter.Active != "" && filter.Active != "0" && filter.Active != "1" {
		return WorkflowRunList{}, workflowValidationError{message: "活跃状态筛选无效"}
	}
	items, total, err := repository.ListWorkflowRunsFiltered(user.UID, repository.WorkflowRunListFilter{WorkflowID: workflowID, ScopeType: scopeType, FrameID: frameID, Active: filter.Active}, query.Page, query.PageSize)
	return WorkflowRunList{Items: items, Total: total, Page: query.Page, PageSize: query.PageSize}, err
}

func GetWorkflowRunState(_ context.Context, user PortalUser, workflowID string, page, pageSize int) (WorkflowRunState, error) {
	if strings.TrimSpace(user.UID) == "" {
		return WorkflowRunState{}, workflowValidationError{message: "未经过 Portal Gateway 身份验证"}
	}
	var err error
	workflowID, err = normalizeWorkflowPathID(workflowID)
	if err != nil {
		return WorkflowRunState{}, err
	}
	if page < 1 {
		page = 1
	}
	if pageSize < 1 {
		pageSize = 20
	}
	if pageSize > 100 {
		pageSize = 100
	}
	record, err := repository.GetWorkflowRunState(user.UID, workflowID, page, pageSize)
	if err != nil {
		if errors.Is(err, repository.ErrWorkflowRunNotFound) {
			return WorkflowRunState{}, safeMessageError{message: "流程不存在"}
		}
		return WorkflowRunState{}, err
	}
	scopes := make([]model.WorkflowRunScope, 0, len(record.Workflow.Graph.Frames)+1)
	scopes = append(scopes, model.WorkflowRunScope{Type: model.WorkflowRunScopeWorkflow})
	for _, frame := range record.Workflow.Graph.Frames {
		scopes = append(scopes, model.WorkflowRunScope{Type: model.WorkflowRunScopeFrame, FrameID: frame.ID})
	}
	nodeRunIDs := make(map[string]string)
	for _, node := range record.Workflow.Graph.Nodes {
		if node.Type == model.WorkflowNodeImageGeneration || node.Type == model.WorkflowNodeVideoGeneration {
			if runID := record.NodeRunIDs[node.ID]; runID != "" {
				nodeRunIDs[node.ID] = runID
			}
		}
	}
	result := WorkflowRunState{WorkflowID: workflowID, Revision: record.Workflow.Revision, NodeRunIDs: nodeRunIDs, ActiveRuns: WorkflowRunList{Items: record.ActiveRuns, Total: record.ActiveTotal, Page: page, PageSize: pageSize}}
	for _, scope := range scopes {
		key := string(scope.Type) + "\x00" + scope.FrameID
		item := WorkflowRunScopeState{Scope: scope}
		if latest, ok := record.LatestRuns[key]; ok {
			current := latest
			item.LatestRun = &current
		}
		if activeID := record.ActiveRunIDs[key]; activeID != "" {
			current := activeID
			item.ActiveRunID = &current
		}
		result.Scopes = append(result.Scopes, item)
	}
	return result, nil
}

func normalizeWorkflowRunScope(input *model.WorkflowRunScope) (model.WorkflowRunScope, error) {
	if input == nil {
		return model.WorkflowRunScope{Type: model.WorkflowRunScopeWorkflow}, nil
	}
	scope := *input
	scope.FrameID = strings.TrimSpace(scope.FrameID)
	switch scope.Type {
	case model.WorkflowRunScopeWorkflow:
		if scope.FrameID != "" {
			return model.WorkflowRunScope{}, workflowValidationError{message: "整图运行不能指定 Frame"}
		}
	case model.WorkflowRunScopeFrame:
		if scope.FrameID == "" {
			return model.WorkflowRunScope{}, workflowValidationError{message: "Frame ID 无效"}
		}
		id, err := normalizeWorkflowIdentifier(scope.FrameID, "Frame ID")
		if err != nil {
			return model.WorkflowRunScope{}, err
		}
		scope.FrameID = id
	default:
		return model.WorkflowRunScope{}, workflowValidationError{message: "运行范围无效"}
	}
	return scope, nil
}

func validateWorkflowRunReplay(existing model.WorkflowRun, workflowID string, scope model.WorkflowRunScope, revision *int) error {
	actualType := existing.ScopeType
	if actualType == "" {
		actualType = model.WorkflowRunScopeWorkflow
	}
	if existing.WorkflowID != workflowID || actualType != scope.Type || existing.FrameID != scope.FrameID || (revision != nil && existing.Revision != *revision) {
		return NewWorkflowBusinessError("workflow_run_request_mismatch", "运行请求 ID 已用于其他范围或版本", map[string]any{"workflowId": workflowID, "runId": existing.ID})
	}
	return nil
}

func GetWorkflowRun(_ context.Context, user PortalUser, id string) (WorkflowRunDetail, error) {
	if strings.TrimSpace(user.UID) == "" {
		return WorkflowRunDetail{}, workflowValidationError{message: "未经过 Portal Gateway 身份验证"}
	}
	id, err := normalizeWorkflowPathID(id)
	if err != nil {
		return WorkflowRunDetail{}, err
	}
	record, found, err := repository.GetWorkflowRun(user.UID, id)
	if err != nil {
		return WorkflowRunDetail{}, err
	}
	if !found {
		return WorkflowRunDetail{}, safeMessageError{message: "运行记录不存在"}
	}
	var graph model.WorkflowGraph
	if err := json.Unmarshal([]byte(record.Run.Snapshot), &graph); err != nil {
		return WorkflowRunDetail{}, err
	}
	videoTaskIDs := make([]string, 0)
	for _, attempt := range record.Attempts {
		if attempt.Status == "uncertain" && attempt.TaskType == "video" && strings.TrimSpace(attempt.TaskID) != "" {
			videoTaskIDs = append(videoTaskIDs, attempt.TaskID)
		}
	}
	resumableVideoTaskIDs, err := repository.ListResumableVideoGenerationTaskIDs(user.UID, videoTaskIDs)
	if err != nil {
		return WorkflowRunDetail{}, err
	}
	for index := range record.Attempts {
		if _, resumable := resumableVideoTaskIDs[record.Attempts[index].TaskID]; resumable {
			record.Attempts[index].ResumeTaskID = record.Attempts[index].TaskID
		}
	}
	return WorkflowRunDetail{Run: record.Run, Graph: graph, Steps: record.Steps, Outputs: record.Outputs, Attempts: record.Attempts}, nil
}

func StopWorkflowRun(_ context.Context, user PortalUser, id string) (WorkflowRunDetail, error) {
	id, err := normalizeWorkflowPathID(id)
	if err != nil {
		return WorkflowRunDetail{}, err
	}
	changed, err := repository.RequestWorkflowRunStop(user.UID, id, time.Now().UTC())
	if err != nil {
		return WorkflowRunDetail{}, err
	}
	if !changed {
		if _, getErr := GetWorkflowRun(context.Background(), user, id); getErr != nil {
			return WorkflowRunDetail{}, getErr
		}
	}
	return GetWorkflowRun(context.Background(), user, id)
}

func RetryWorkflowOutput(_ context.Context, user PortalUser, id string, input RetryWorkflowOutputInput) (WorkflowRunDetail, error) {
	if !workflowsEnabled() {
		return WorkflowRunDetail{}, workflowValidationError{message: "自动化流程运行暂不可用"}
	}
	if err := requireEnabledWorkflowMember(user.UID); err != nil {
		return WorkflowRunDetail{}, err
	}
	id, err := normalizeWorkflowPathID(id)
	if err != nil {
		return WorkflowRunDetail{}, err
	}
	requestID, nodeID, slotID := strings.TrimSpace(input.RequestID), strings.TrimSpace(input.NodeID), strings.TrimSpace(input.SlotID)
	if requestID == "" || nodeID == "" || slotID == "" || len(requestID) > 128 || len(nodeID) > 128 || len(slotID) > 128 {
		return WorkflowRunDetail{}, workflowValidationError{message: "重试槽位无效"}
	}
	if _, err := repository.RetryWorkflowOutput(user.UID, id, nodeID, slotID, requestID, time.Now().UTC()); err != nil {
		var conflict *repository.WorkflowRunAdmissionConflict
		switch {
		case errors.Is(err, repository.ErrWorkflowRunNotFound):
			return WorkflowRunDetail{}, safeMessageError{message: "运行记录不存在"}
		case errors.Is(err, repository.ErrWorkflowRunActive):
			return WorkflowRunDetail{}, workflowValidationError{message: "当前槽位不可重试"}
		case errors.As(err, &conflict):
			data := map[string]any{"runId": conflict.RunID, "workflowRunId": id, "nodeId": nodeID, "slotId": slotID}
			if len(conflict.NodeIDs) > 0 {
				data["nodeIds"] = conflict.NodeIDs
			}
			return WorkflowRunDetail{}, NewWorkflowBusinessError(conflict.Code, "重试范围与已有活跃运行冲突", data)
		default:
			return WorkflowRunDetail{}, err
		}
	}
	return GetWorkflowRun(context.Background(), user, id)
}

func DeleteWorkflowRun(_ context.Context, user PortalUser, id string) error {
	id, err := normalizeWorkflowPathID(id)
	if err != nil {
		return err
	}
	err = repository.DeleteWorkflowRun(user.UID, id)
	switch {
	case errors.Is(err, repository.ErrWorkflowRunNotFound):
		return safeMessageError{message: "运行记录不存在"}
	case errors.Is(err, repository.ErrWorkflowRunActive):
		return workflowValidationError{message: "运行尚未结束，不能删除"}
	default:
		return err
	}
}

func validateWorkflowRunInputs(ctx context.Context, user PortalUser, graph model.WorkflowGraph) error {
	connectedPorts := make(map[string]struct{}, len(graph.Connections))
	for _, connection := range graph.Connections {
		connectedPorts[connection.TargetNodeID+"\x00"+connection.TargetPortID] = struct{}{}
	}
	for _, node := range graph.Nodes {
		if node.Type != model.WorkflowNodeImageGeneration && node.Type != model.WorkflowNodeVideoGeneration {
			continue
		}
		for _, port := range node.InputPorts {
			if _, connected := connectedPorts[node.ID+"\x00"+port.ID]; !connected {
				return workflowValidationError{message: "生成节点输入不完整"}
			}
		}
	}
	mediaIDs := workflowGraphMediaIDs(graph)
	if len(mediaIDs) > 0 {
		// Ownership and cleanup state are checked atomically when run refs are created.
		seen := map[string]bool{}
		for _, id := range mediaIDs {
			if strings.TrimSpace(id) == "" || seen[id] {
				return workflowValidationError{message: "流程输入素材无效"}
			}
			seen[id] = true
		}
	}
	for _, node := range graph.Nodes {
		if (node.Type != model.WorkflowNodeImageInput && node.Type != model.WorkflowNodeVideoInput) || node.MediaID == "" {
			continue
		}
		media, found, err := repository.GetMedia(node.MediaID)
		if err != nil {
			return err
		}
		if !found || media.CleanupStatus != model.MediaCleanupActive {
			return workflowValidationError{message: "流程输入素材不存在或正在删除"}
		}
		if media.OwnerUID != user.UID {
			_, public, err := repository.GetPublicImageByMediaID(node.MediaID)
			if err != nil {
				return err
			}
			if !public || node.Type == model.WorkflowNodeVideoInput {
				return workflowValidationError{message: "无权使用流程输入素材"}
			}
		}
		if node.Type == model.WorkflowNodeImageInput && !strings.HasPrefix(media.ContentType, "image/") || node.Type == model.WorkflowNodeVideoInput && media.ContentType != "video/mp4" {
			return workflowValidationError{message: "流程输入素材类型不匹配"}
		}
	}
	validationOutputs := []model.WorkflowOutputExecution{}
	for _, node := range graph.Nodes {
		for _, slot := range node.Outputs {
			validationOutputs = append(validationOutputs, model.WorkflowOutputExecution{NodeID: node.ID, SlotID: slot.ID, Status: "succeeded", MediaID: "workflow-validation-media"})
		}
	}
	settings, err := AdminSettings()
	if err != nil {
		return err
	}
	for _, node := range graph.Nodes {
		if node.Type != model.WorkflowNodeImageGeneration && node.Type != model.WorkflowNodeVideoGeneration {
			continue
		}
		if node.Config == nil || strings.TrimSpace(node.Config.ProviderID) == "" {
			return workflowValidationError{message: "生成节点尚未选择模型"}
		}
		resolved, err := resolveWorkflowInputs(graph, node.ID, validationOutputs)
		if err != nil || resolved.State != "ready" || strings.TrimSpace(resolved.Prompt) == "" {
			return workflowValidationError{message: "生成节点输入不完整"}
		}
		switch node.Type {
		case model.WorkflowNodeImageGeneration:
			if len(resolved.VideoMediaIDs) > 0 {
				return workflowValidationError{message: "图片生成节点不支持视频输入"}
			}
			mode := ImageTaskModeGeneration
			if len(resolved.ImageMediaIDs) > 0 {
				mode = ImageTaskModeEdit
			}
			request, err := workflowImageRequest(node, resolved, "workflow-validation-request")
			if err != nil {
				return err
			}
			request.ReferenceMediaIDs = nil
			for range resolved.ImageMediaIDs {
				request.References = append(request.References, ai.ImageReference{ContentType: "image/png", Data: []byte{0x89, 'P', 'N', 'G'}})
			}
			request, err = normalizeImageTaskRequest(request)
			if err != nil {
				return workflowRunValidationError(err, "图片生成节点参数无效")
			}
			provider, err := configuredImageTaskProvider(settings.AI, mode, node.Config.ProviderID)
			if err != nil {
				return workflowRunValidationError(err, "图片模型不可用")
			}
			provider, err = validateImageTaskProvider(provider)
			if err != nil {
				return workflowRunValidationError(err, "图片模型不可用")
			}
			if _, err := normalizeImageTaskRequestForProvider(provider, request); err != nil {
				return workflowRunValidationError(err, "图片生成节点参数无效")
			}
			if _, err := imageTaskAmount(provider, request.Request.Resolution); err != nil {
				return workflowRunValidationError(err, "图片生成节点价格未配置")
			}
		case model.WorkflowNodeVideoGeneration:
			store, err := newImageStore()
			if err != nil {
				return err
			}
			if _, ok := store.(*ossImageStore); !ok {
				return workflowValidationError{message: "视频生成需要 OSS 存储"}
			}
			if !providerAvailable(settings.AI, node.Config.ProviderID, ai.CapabilityVideoGenerate) {
				return workflowValidationError{message: "视频模型不可用"}
			}
			request, err := workflowVideoRequest(node, resolved, "workflow-validation-request")
			if err != nil {
				return err
			}
			if err := validateVideoTaskRequest(request); err != nil {
				return workflowRunValidationError(err, "视频生成节点参数无效")
			}
			provider, found := findProvider(settings.AI, node.Config.ProviderID)
			if !found {
				return workflowValidationError{message: "视频模型不可用"}
			}
			typeInfo, found := ai.Type(provider.Type)
			if !found || typeInfo.New == nil {
				return workflowValidationError{message: "视频模型不可用"}
			}
			instance, err := typeInfo.New(provider.Config)
			if err != nil {
				return workflowRunValidationError(err, "视频模型配置无效")
			}
			if _, ok := instance.(ai.VideoGenerator); !ok {
				return workflowValidationError{message: "视频模型不可用"}
			}
			if _, err := videoTaskAmount(provider, request); err != nil {
				return workflowRunValidationError(err, "视频生成节点价格未配置")
			}
			if err := validateWorkflowVideoReferenceDuration(ctx, graph, node.ID); err != nil {
				return err
			}
		}
	}
	return nil
}

func workflowRunValidationError(err error, fallback string) error {
	if err == nil {
		return nil
	}
	if safe, ok := err.(interface{ SafeMessage() string }); ok && strings.TrimSpace(safe.SafeMessage()) != "" {
		return workflowValidationError{message: safe.SafeMessage()}
	}
	return workflowValidationError{message: fallback}
}

func validateWorkflowVideoReferenceDuration(_ context.Context, graph model.WorkflowGraph, targetNodeID string) error {
	nodes := map[string]model.WorkflowNode{}
	for _, node := range graph.Nodes {
		nodes[node.ID] = node
	}
	total := 0.0
	for _, connection := range graph.Connections {
		if connection.TargetNodeID != targetNodeID {
			continue
		}
		source := nodes[connection.SourceNodeID]
		switch source.Type {
		case model.WorkflowNodeVideoInput:
			media, found, err := repository.GetMedia(source.MediaID)
			if err != nil {
				return err
			}
			if !found {
				return workflowValidationError{message: "视频输入素材不存在"}
			}
			total += media.Duration
		case model.WorkflowNodeVideoGeneration:
			if source.Config == nil || source.Config.Seconds == nil {
				return workflowValidationError{message: "上游视频节点参数无效"}
			}
			total += float64(*source.Config.Seconds)
		}
	}
	if total > 15.000001 {
		return workflowValidationError{message: "视频参考总时长不能超过 15 秒"}
	}
	return nil
}

func workflowGraphMediaIDs(graph model.WorkflowGraph) []string {
	ids := []string{}
	seen := map[string]bool{}
	for _, node := range graph.Nodes {
		if (node.Type == model.WorkflowNodeImageInput || node.Type == model.WorkflowNodeVideoInput) && node.MediaID != "" && !seen[node.MediaID] {
			ids, seen[node.MediaID] = append(ids, node.MediaID), true
		}
	}
	return ids
}

func requireEnabledWorkflowMember(uid string) error {
	member, found, err := repository.GetPortalMember(strings.TrimSpace(uid))
	if err != nil {
		return err
	}
	if !found || !member.Enabled {
		return workflowValidationError{message: "当前账号不可运行自动化流程"}
	}
	return nil
}
