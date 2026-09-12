package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"regexp"
	"sort"
	"strings"
	"unicode/utf8"

	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/repository"
)

const (
	workflowGraphVersion     = 1
	maxWorkflowGraphNodes    = 1000
	maxWorkflowGraphFrames   = 1000
	maxWorkflowConnections   = 5000
	maxWorkflowNodeInputs    = 9
	maxWorkflowNodeOutputs   = 9
	maxWorkflowOptionDepth   = 8
	maxWorkflowOptionEntries = 256
	maxWorkflowGraphBytes    = 4 << 20
)

var ErrWorkflowConflict = errors.New("workflow revision conflict")

var workflowIdentifierPattern = regexp.MustCompile(`^[A-Za-z0-9._~-]+$`)

type workflowValidationError struct{ message string }

func (err workflowValidationError) Error() string       { return err.message }
func (err workflowValidationError) SafeMessage() string { return err.message }

func IsWorkflowValidationError(err error) bool {
	var validation workflowValidationError
	return errors.As(err, &validation)
}

type WorkflowCreateInput struct {
	Name               string               `json:"name"`
	Graph              *model.WorkflowGraph `json:"graph,omitempty"`
	FrameSchemaVersion *int                 `json:"frameSchemaVersion,omitempty"`
}

type WorkflowUpdateInput struct {
	Revision           int                 `json:"revision"`
	Name               string              `json:"name"`
	Graph              model.WorkflowGraph `json:"graph"`
	FrameSchemaVersion *int                `json:"frameSchemaVersion,omitempty"`
}

type WorkflowCopyInput struct {
	Name string `json:"name,omitempty"`
}

func ListWorkflows(_ context.Context, user PortalUser, page, pageSize int) (model.WorkflowList, error) {
	if strings.TrimSpace(user.UID) == "" {
		return model.WorkflowList{}, workflowValidationError{message: "未经过 Portal Gateway 身份验证"}
	}
	query := model.Query{Page: page, PageSize: pageSize}
	query.Normalize()
	items, total, err := repository.ListWorkflows(user.UID, query.Page, query.PageSize)
	if err != nil {
		return model.WorkflowList{}, err
	}
	return model.WorkflowList{Items: items, Total: total, Page: query.Page, PageSize: query.PageSize}, nil
}

func GetWorkflow(_ context.Context, user PortalUser, id string) (model.Workflow, error) {
	if strings.TrimSpace(user.UID) == "" {
		return model.Workflow{}, workflowValidationError{message: "未经过 Portal Gateway 身份验证"}
	}
	id, err := normalizeWorkflowPathID(id)
	if err != nil {
		return model.Workflow{}, err
	}
	item, found, err := repository.GetWorkflow(user.UID, id)
	if err != nil {
		return model.Workflow{}, err
	}
	if !found {
		return model.Workflow{}, safeMessageError{message: "流程不存在"}
	}
	return item, nil
}

func CreateWorkflow(_ context.Context, user PortalUser, input WorkflowCreateInput) (model.Workflow, error) {
	if strings.TrimSpace(user.UID) == "" {
		return model.Workflow{}, workflowValidationError{message: "未经过 Portal Gateway 身份验证"}
	}
	name, err := normalizeWorkflowName(input.Name)
	if err != nil {
		return model.Workflow{}, err
	}
	graph := model.WorkflowGraph{Version: workflowGraphVersion, Nodes: []model.WorkflowNode{}, Connections: []model.WorkflowConnection{}}
	if input.Graph != nil {
		graph = *input.Graph
	}
	graph, err = normalizeAndSizeWorkflowGraph(graph)
	if err != nil {
		return model.Workflow{}, err
	}
	if len(graph.Frames) > 0 && !validWorkflowFrameSchemaVersion(input.FrameSchemaVersion) {
		return model.Workflow{}, NewWorkflowBusinessError("workflow_frame_client_outdated", "页面版本过旧，请刷新后继续", nil)
	}
	current := now()
	item := model.Workflow{ID: newID("workflow"), OwnerUID: user.UID, Name: name, Graph: graph, Revision: 1, CreatedAt: current, UpdatedAt: current}
	created, err := repository.CreateWorkflow(item)
	if err != nil {
		return model.Workflow{}, workflowRepositoryError(err)
	}
	return created, nil
}

func UpdateWorkflow(_ context.Context, user PortalUser, id string, input WorkflowUpdateInput) (model.Workflow, error) {
	if strings.TrimSpace(user.UID) == "" {
		return model.Workflow{}, workflowValidationError{message: "未经过 Portal Gateway 身份验证"}
	}
	id, err := normalizeWorkflowPathID(id)
	if err != nil {
		return model.Workflow{}, err
	}
	if input.Revision < 1 {
		return model.Workflow{}, ErrWorkflowConflict
	}
	name, err := normalizeWorkflowName(input.Name)
	if err != nil {
		return model.Workflow{}, err
	}
	graph, err := normalizeAndSizeWorkflowGraph(input.Graph)
	if err != nil {
		return model.Workflow{}, err
	}
	updated, accepted, err := repository.UpdateWorkflowWithFrameSchema(user.UID, id, input.Revision, name, graph, input.FrameSchemaVersion, now())
	if err != nil {
		if errors.Is(err, repository.ErrWorkflowFrameClientOutdated) {
			return model.Workflow{}, NewWorkflowBusinessError("workflow_frame_client_outdated", "页面版本过旧，请刷新后继续", map[string]any{"workflowId": id})
		}
		return model.Workflow{}, workflowRepositoryError(err)
	}
	if accepted {
		return updated, nil
	}
	if _, found, err := repository.GetWorkflow(user.UID, id); err != nil {
		return model.Workflow{}, err
	} else if !found {
		return model.Workflow{}, safeMessageError{message: "流程不存在"}
	}
	return model.Workflow{}, ErrWorkflowConflict
}

func CopyWorkflow(ctx context.Context, user PortalUser, id string, input WorkflowCopyInput) (model.Workflow, error) {
	if strings.TrimSpace(user.UID) == "" {
		return model.Workflow{}, workflowValidationError{message: "未经过 Portal Gateway 身份验证"}
	}
	source, err := GetWorkflow(ctx, user, id)
	if err != nil {
		return model.Workflow{}, err
	}
	name := strings.TrimSpace(input.Name)
	if name == "" {
		name = source.Name + " 副本"
		if utf8.RuneCountInString(name) > 128 {
			name = source.Name
		}
	}
	name, err = normalizeWorkflowName(name)
	if err != nil {
		return model.Workflow{}, err
	}
	graph, err := normalizeAndSizeWorkflowGraph(source.Graph)
	if err != nil {
		return model.Workflow{}, err
	}
	current := now()
	copy := model.Workflow{ID: newID("workflow"), OwnerUID: user.UID, Name: name, Graph: graph, Revision: 1, CreatedAt: current, UpdatedAt: current}
	created, err := repository.CreateWorkflow(copy)
	if err != nil {
		return model.Workflow{}, workflowRepositoryError(err)
	}
	return created, nil
}

func DeleteWorkflow(_ context.Context, user PortalUser, id string, revision int) error {
	if strings.TrimSpace(user.UID) == "" {
		return workflowValidationError{message: "未经过 Portal Gateway 身份验证"}
	}
	id, err := normalizeWorkflowPathID(id)
	if err != nil {
		return err
	}
	if revision < 1 {
		return ErrWorkflowConflict
	}
	deleted, err := repository.DeleteWorkflow(user.UID, id, revision)
	if err != nil {
		return workflowRepositoryError(err)
	}
	if deleted {
		return nil
	}
	if _, found, err := repository.GetWorkflow(user.UID, id); err != nil {
		return err
	} else if !found {
		return nil
	}
	return ErrWorkflowConflict
}

func normalizeAndSizeWorkflowGraph(graph model.WorkflowGraph) (model.WorkflowGraph, error) {
	graph, err := normalizeWorkflowGraph(graph)
	if err != nil {
		return model.WorkflowGraph{}, err
	}
	encoded, err := json.Marshal(graph)
	if err != nil {
		return model.WorkflowGraph{}, workflowValidationError{message: "流程图格式无效"}
	}
	if len(encoded) > maxWorkflowGraphBytes {
		return model.WorkflowGraph{}, workflowValidationError{message: "流程图超过保存上限（4MB）"}
	}
	return graph, nil
}

func normalizeWorkflowName(value string) (string, error) {
	value = strings.TrimSpace(value)
	if length := utf8.RuneCountInString(value); length < 1 || length > 128 {
		return "", workflowValidationError{message: "流程名称长度应为 1-128 个字符"}
	}
	return value, nil
}

func workflowRepositoryError(err error) error {
	if errors.Is(err, repository.ErrCanvasMediaUnavailable) {
		return workflowValidationError{message: "流程引用的媒体不存在、无权访问或正在删除，请刷新后重试"}
	}
	return err
}

func normalizeWorkflowGraph(graph model.WorkflowGraph) (model.WorkflowGraph, error) {
	if graph.Version != workflowGraphVersion {
		return model.WorkflowGraph{}, workflowValidationError{message: "流程图版本无效"}
	}
	if len(graph.Nodes) > maxWorkflowGraphNodes || len(graph.Connections) > maxWorkflowConnections || len(graph.Frames) > maxWorkflowGraphFrames {
		return model.WorkflowGraph{}, workflowValidationError{message: "流程图规模超过保存上限"}
	}

	graph.Nodes = append([]model.WorkflowNode(nil), graph.Nodes...)
	graph.Connections = append([]model.WorkflowConnection(nil), graph.Connections...)
	graph.Frames = append([]model.WorkflowFrame(nil), graph.Frames...)
	if graph.Nodes == nil {
		graph.Nodes = []model.WorkflowNode{}
	}
	if graph.Connections == nil {
		graph.Connections = []model.WorkflowConnection{}
	}
	for index := range graph.Frames {
		graph.Frames[index].NodeIDs = append([]string(nil), graph.Frames[index].NodeIDs...)
		if graph.Frames[index].NodeIDs == nil {
			graph.Frames[index].NodeIDs = []string{}
		}
	}

	nodes := make(map[string]model.WorkflowNode, len(graph.Nodes))
	for index := range graph.Nodes {
		node := &graph.Nodes[index]
		if err := normalizeWorkflowNode(node); err != nil {
			return model.WorkflowGraph{}, err
		}
		if _, exists := nodes[node.ID]; exists {
			return model.WorkflowGraph{}, workflowValidationError{message: "流程节点 ID 重复"}
		}
		nodes[node.ID] = *node
	}
	if err := normalizeWorkflowFrames(graph.Frames, nodes); err != nil {
		return model.WorkflowGraph{}, err
	}

	incoming := make(map[string]int, len(nodes))
	targetPorts := make(map[string]struct{}, len(graph.Connections))
	orders := make(map[string]struct{}, len(graph.Connections))
	indegree := make(map[string]int, len(nodes))
	adjacency := make(map[string][]string, len(nodes))
	for id := range nodes {
		indegree[id] = 0
	}
	for index := range graph.Connections {
		connection := &graph.Connections[index]
		if err := normalizeWorkflowConnection(connection, nodes); err != nil {
			return model.WorkflowGraph{}, err
		}
		targetKey := connection.TargetNodeID + "\x00" + connection.TargetPortID
		if _, exists := targetPorts[targetKey]; exists {
			return model.WorkflowGraph{}, workflowValidationError{message: "每个目标端口只能连接一个输入"}
		}
		targetPorts[targetKey] = struct{}{}
		orderKey := connection.TargetNodeID + "\x00" + fmt.Sprint(connection.Order)
		if _, exists := orders[orderKey]; exists {
			return model.WorkflowGraph{}, workflowValidationError{message: "同一目标节点的连接顺序不能重复"}
		}
		orders[orderKey] = struct{}{}
		incoming[connection.TargetNodeID]++
		if incoming[connection.TargetNodeID] > maxWorkflowNodeInputs {
			return model.WorkflowGraph{}, workflowValidationError{message: "生成节点最多连接 9 个输入"}
		}
		adjacency[connection.SourceNodeID] = append(adjacency[connection.SourceNodeID], connection.TargetNodeID)
		indegree[connection.TargetNodeID]++
	}
	if !workflowGraphIsDAG(indegree, adjacency) {
		return model.WorkflowGraph{}, workflowValidationError{message: "流程图不能包含循环连接"}
	}
	return graph, nil
}

func validWorkflowFrameSchemaVersion(version *int) bool {
	return version != nil && *version == 1
}

func normalizeWorkflowFrames(frames []model.WorkflowFrame, nodes map[string]model.WorkflowNode) error {
	frameIDs := make(map[string]struct{}, len(frames))
	for index := range frames {
		frame := &frames[index]
		id, err := normalizeWorkflowIdentifier(frame.ID, "Frame ID")
		if err != nil {
			return err
		}
		frame.ID = id
		if _, exists := frameIDs[id]; exists {
			return workflowValidationError{message: "Frame ID 重复"}
		}
		frameIDs[id] = struct{}{}
		frame.Name = strings.TrimSpace(frame.Name)
		if length := utf8.RuneCountInString(frame.Name); length < 1 || length > 128 {
			return workflowValidationError{message: "Frame 名称长度应为 1-128 个字符"}
		}
		if !finiteWorkflowNumber(frame.Position.X) || !finiteWorkflowNumber(frame.Position.Y) || !finiteWorkflowNumber(frame.Width) || !finiteWorkflowNumber(frame.Height) || frame.Width <= 0 || frame.Height <= 0 {
			return workflowValidationError{message: "Frame 位置或尺寸无效"}
		}
	}
	for index := range frames {
		for otherIndex := index + 1; otherIndex < len(frames); otherIndex++ {
			if workflowFramesOverlap(frames[index], frames[otherIndex]) {
				return workflowValidationError{message: "Frame 不能重叠"}
			}
		}
	}
	members := make(map[string]string)
	for index := range frames {
		frame := &frames[index]
		inside := make(map[string]struct{}, len(frame.NodeIDs))
		for memberIndex, value := range frame.NodeIDs {
			id, err := normalizeWorkflowIdentifier(value, "Frame 成员 ID")
			if err != nil {
				return err
			}
			frame.NodeIDs[memberIndex] = id
			if _, isFrame := frameIDs[id]; isFrame {
				return workflowValidationError{message: "Frame 不能包含另一个 Frame"}
			}
			if _, exists := nodes[id]; !exists {
				return workflowValidationError{message: "Frame 成员引用的节点不存在"}
			}
			if _, duplicate := inside[id]; duplicate {
				return workflowValidationError{message: "Frame 成员不能重复"}
			}
			inside[id] = struct{}{}
			if prior, assigned := members[id]; assigned && prior != frame.ID {
				return workflowValidationError{message: "同一节点不能属于多个 Frame"}
			}
			members[id] = frame.ID
		}
	}
	return nil
}

func workflowFramesOverlap(first, second model.WorkflowFrame) bool {
	return first.Position.X < second.Position.X+second.Width &&
		second.Position.X < first.Position.X+first.Width &&
		first.Position.Y < second.Position.Y+second.Height &&
		second.Position.Y < first.Position.Y+first.Height
}

func normalizeWorkflowNode(node *model.WorkflowNode) error {
	id, err := normalizeWorkflowIdentifier(node.ID, "流程节点 ID")
	if err != nil {
		return err
	}
	node.ID = id
	if !finiteWorkflowNumber(node.Position.X) || !finiteWorkflowNumber(node.Position.Y) {
		return workflowValidationError{message: "流程节点位置无效"}
	}
	if !validWorkflowDimension(node.Width) || !validWorkflowDimension(node.Height) {
		return workflowValidationError{message: "流程节点尺寸无效"}
	}
	if utf8.RuneCountInString(node.Text) > 20000 {
		return workflowValidationError{message: "文本输入超过保存上限"}
	}
	node.MediaID = strings.TrimSpace(node.MediaID)
	if node.MediaID != "" {
		if _, err := normalizeWorkflowIdentifier(node.MediaID, "媒体 ID"); err != nil {
			return err
		}
	}

	switch node.Type {
	case model.WorkflowNodeImageInput, model.WorkflowNodeVideoInput:
		if node.Text != "" || len(node.InputPorts) != 0 || node.Config != nil || len(node.Outputs) != 0 {
			return workflowValidationError{message: "图片或视频输入节点字段无效"}
		}
	case model.WorkflowNodeTextInput:
		if node.MediaID != "" || len(node.InputPorts) != 0 || node.Config != nil || len(node.Outputs) != 0 {
			return workflowValidationError{message: "文本输入节点字段无效"}
		}
	case model.WorkflowNodeImageGeneration, model.WorkflowNodeVideoGeneration:
		if node.Text != "" || node.MediaID != "" {
			return workflowValidationError{message: "生成节点字段无效"}
		}
		if len(node.InputPorts) > maxWorkflowNodeInputs {
			return workflowValidationError{message: "生成节点输入端口最多为 9 个"}
		}
		if len(node.Outputs) < 1 || len(node.Outputs) > maxWorkflowNodeOutputs {
			return workflowValidationError{message: "生成节点输出槽位应为 1-9 个"}
		}
		if err := normalizeWorkflowPorts(node); err != nil {
			return err
		}
		if err := normalizeWorkflowConfig(node.Config); err != nil {
			return err
		}
	default:
		return workflowValidationError{message: "流程节点类型无效"}
	}
	return nil
}

func normalizeWorkflowPorts(node *model.WorkflowNode) error {
	ports := make(map[string]struct{}, len(node.InputPorts))
	for index := range node.InputPorts {
		port := &node.InputPorts[index]
		id, err := normalizeWorkflowIdentifier(port.ID, "输入端口 ID")
		if err != nil {
			return err
		}
		port.ID = id
		if !validWorkflowPortType(port.Type) {
			return workflowValidationError{message: "输入端口类型无效"}
		}
		if _, exists := ports[id]; exists {
			return workflowValidationError{message: "输入端口 ID 重复"}
		}
		ports[id] = struct{}{}
	}
	expectedType := model.WorkflowPortImage
	if node.Type == model.WorkflowNodeVideoGeneration {
		expectedType = model.WorkflowPortVideo
	}
	slots := make(map[string]struct{}, len(node.Outputs))
	for index := range node.Outputs {
		slot := &node.Outputs[index]
		id, err := normalizeWorkflowIdentifier(slot.ID, "输出槽位 ID")
		if err != nil {
			return err
		}
		slot.ID = id
		if slot.Type != expectedType {
			return workflowValidationError{message: "输出槽位类型与生成节点不匹配"}
		}
		if _, exists := slots[id]; exists {
			return workflowValidationError{message: "输出槽位 ID 重复"}
		}
		if slot.Position != nil && (!finiteWorkflowNumber(slot.Position.X) || !finiteWorkflowNumber(slot.Position.Y)) {
			return workflowValidationError{message: "输出槽位位置无效"}
		}
		if !validWorkflowDimension(slot.Width) || !validWorkflowDimension(slot.Height) {
			return workflowValidationError{message: "输出槽位尺寸无效"}
		}
		slots[id] = struct{}{}
	}
	return nil
}

func normalizeWorkflowConfig(config *model.WorkflowNodeConfig) error {
	if config == nil {
		return nil
	}
	for name, value := range map[string]*string{
		"模型 ID": &config.ProviderID, "尺寸": &config.Size, "分辨率": &config.Resolution,
		"质量": &config.Quality, "输出格式": &config.OutputFormat, "背景": &config.Background,
	} {
		*value = strings.TrimSpace(*value)
		if utf8.RuneCountInString(*value) > 128 {
			return workflowValidationError{message: name + "超过保存上限"}
		}
	}
	if config.ProviderID != "" {
		providerID, err := normalizeWorkflowIdentifier(config.ProviderID, "模型 ID")
		if err != nil {
			return err
		}
		config.ProviderID = providerID
	}
	if config.Seconds != nil && (*config.Seconds < 1 || *config.Seconds > 3600) {
		return workflowValidationError{message: "视频时长无效"}
	}
	entries := 0
	if err := validateWorkflowOptions(config.Options, 0, &entries); err != nil {
		return err
	}
	return nil
}

func validateWorkflowOptions(value any, depth int, entries *int) error {
	if value == nil {
		return nil
	}
	if depth > maxWorkflowOptionDepth {
		return workflowValidationError{message: "模型扩展参数嵌套过深"}
	}
	switch current := value.(type) {
	case map[string]any:
		for key, child := range current {
			*entries++
			if *entries > maxWorkflowOptionEntries {
				return workflowValidationError{message: "模型扩展参数超过保存上限"}
			}
			if unsafeWorkflowOptionKey(key) {
				return workflowValidationError{message: "模型扩展参数不能包含地址或凭据"}
			}
			if err := validateWorkflowOptions(child, depth+1, entries); err != nil {
				return err
			}
		}
	case []any:
		for _, child := range current {
			if err := validateWorkflowOptions(child, depth+1, entries); err != nil {
				return err
			}
		}
	case string:
		lower := strings.ToLower(strings.TrimSpace(current))
		if strings.HasPrefix(lower, "http://") || strings.HasPrefix(lower, "https://") || strings.HasPrefix(lower, "blob:") || strings.HasPrefix(lower, "data:") {
			return workflowValidationError{message: "模型扩展参数不能包含地址或凭据"}
		}
	case bool, float64, float32, int, int8, int16, int32, int64, uint, uint8, uint16, uint32, uint64:
		return nil
	default:
		return workflowValidationError{message: "模型扩展参数格式无效"}
	}
	return nil
}

func unsafeWorkflowOptionKey(key string) bool {
	normalized := strings.NewReplacer("_", "", "-", "", ".", "").Replace(strings.ToLower(strings.TrimSpace(key)))
	if strings.Contains(normalized, "url") || strings.Contains(normalized, "uri") {
		return true
	}
	for _, forbidden := range []string{"key", "apikey", "accesskey", "secret", "token", "providerconfig", "credential", "password"} {
		if normalized == forbidden {
			return true
		}
	}
	return false
}

func normalizeWorkflowConnection(connection *model.WorkflowConnection, nodes map[string]model.WorkflowNode) error {
	var err error
	if connection.SourceNodeID, err = normalizeWorkflowIdentifier(connection.SourceNodeID, "连线来源节点 ID"); err != nil {
		return err
	}
	if connection.SourceSlotID, err = normalizeWorkflowIdentifier(connection.SourceSlotID, "连线来源槽位 ID"); err != nil {
		return err
	}
	if connection.TargetNodeID, err = normalizeWorkflowIdentifier(connection.TargetNodeID, "连线目标节点 ID"); err != nil {
		return err
	}
	if connection.TargetPortID, err = normalizeWorkflowIdentifier(connection.TargetPortID, "连线目标端口 ID"); err != nil {
		return err
	}
	if connection.Order < 0 {
		return workflowValidationError{message: "连接顺序必须为非负整数"}
	}
	source, sourceFound := nodes[connection.SourceNodeID]
	target, targetFound := nodes[connection.TargetNodeID]
	if !sourceFound || !targetFound {
		return workflowValidationError{message: "连线引用的节点不存在"}
	}
	sourceType, found := workflowSourceSlotType(source, connection.SourceSlotID)
	if !found {
		return workflowValidationError{message: "连线引用的输出槽位不存在"}
	}
	targetType, found := workflowTargetPortType(target, connection.TargetPortID)
	if !found {
		return workflowValidationError{message: "连线引用的目标端口不存在"}
	}
	if sourceType != targetType {
		return workflowValidationError{message: "连线输入输出类型不匹配"}
	}
	return nil
}

func workflowSourceSlotType(node model.WorkflowNode, slotID string) (model.WorkflowPortType, bool) {
	switch node.Type {
	case model.WorkflowNodeImageInput:
		return model.WorkflowPortImage, slotID == "output"
	case model.WorkflowNodeVideoInput:
		return model.WorkflowPortVideo, slotID == "output"
	case model.WorkflowNodeTextInput:
		return model.WorkflowPortText, slotID == "output"
	case model.WorkflowNodeImageGeneration, model.WorkflowNodeVideoGeneration:
		for _, slot := range node.Outputs {
			if slot.ID == slotID {
				return slot.Type, true
			}
		}
	}
	return "", false
}

func workflowTargetPortType(node model.WorkflowNode, portID string) (model.WorkflowPortType, bool) {
	for _, port := range node.InputPorts {
		if port.ID == portID {
			return port.Type, true
		}
	}
	return "", false
}

func workflowGraphIsDAG(indegree map[string]int, adjacency map[string][]string) bool {
	queue := make([]string, 0, len(indegree))
	for id, degree := range indegree {
		if degree == 0 {
			queue = append(queue, id)
		}
	}
	sort.Strings(queue)
	visited := 0
	for len(queue) > 0 {
		id := queue[0]
		queue = queue[1:]
		visited++
		for _, target := range adjacency[id] {
			indegree[target]--
			if indegree[target] == 0 {
				queue = append(queue, target)
			}
		}
	}
	return visited == len(indegree)
}

func normalizeWorkflowIdentifier(value, label string) (string, error) {
	value = strings.TrimSpace(value)
	if length := utf8.RuneCountInString(value); length < 1 || length > 128 || strings.IndexFunc(value, func(r rune) bool { return r < 0x20 || r == 0x7f }) >= 0 {
		return "", workflowValidationError{message: label + "无效"}
	}
	return value, nil
}

func normalizeWorkflowPathID(value string) (string, error) {
	value = strings.TrimSpace(value)
	if length := utf8.RuneCountInString(value); length < 1 || length > 128 || !workflowIdentifierPattern.MatchString(value) || value == "." || value == ".." {
		return "", workflowValidationError{message: "流程 ID 无效"}
	}
	return value, nil
}

func validWorkflowPortType(value model.WorkflowPortType) bool {
	return value == model.WorkflowPortImage || value == model.WorkflowPortVideo || value == model.WorkflowPortText
}

func finiteWorkflowNumber(value float64) bool {
	return !math.IsInf(value, 0) && !math.IsNaN(value) && math.Abs(value) <= 1e7
}

func validWorkflowDimension(value *float64) bool {
	return value == nil || (finiteWorkflowNumber(*value) && *value > 0)
}
