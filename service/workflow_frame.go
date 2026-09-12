package service

import (
	"fmt"

	"github.com/basketikun/infinite-canvas/model"
)

type WorkflowBusinessError struct {
	Code       string
	Message    string
	HTTPStatus int
	Data       map[string]any
}

func (err *WorkflowBusinessError) Error() string       { return err.Message }
func (err *WorkflowBusinessError) SafeMessage() string { return err.Message }

func NewWorkflowBusinessError(code, message string, data map[string]any) *WorkflowBusinessError {
	return &WorkflowBusinessError{Code: code, Message: message, HTTPStatus: 409, Data: data}
}

func newWorkflowFrameValidationError(code, message string, data map[string]any) *WorkflowBusinessError {
	return &WorkflowBusinessError{Code: code, Message: message, HTTPStatus: 400, Data: data}
}

func SelectWorkflowRunGraph(graph model.WorkflowGraph, scope model.WorkflowRunScope) (model.WorkflowGraph, error) {
	if scope.Type == model.WorkflowRunScopeWorkflow {
		graph.Frames = nil
		return graph, nil
	}
	if scope.Type != model.WorkflowRunScopeFrame || scope.FrameID == "" {
		return model.WorkflowGraph{}, newWorkflowFrameValidationError("workflow_frame_not_runnable", "Frame 不存在或没有可运行节点", nil)
	}
	var selectedFrame *model.WorkflowFrame
	for index := range graph.Frames {
		if graph.Frames[index].ID == scope.FrameID {
			selectedFrame = &graph.Frames[index]
			break
		}
	}
	if selectedFrame == nil {
		return model.WorkflowGraph{}, newWorkflowFrameValidationError("workflow_frame_not_runnable", "Frame 不存在或没有可运行节点", map[string]any{"frameId": scope.FrameID})
	}
	nodeByID := make(map[string]model.WorkflowNode, len(graph.Nodes))
	for _, node := range graph.Nodes {
		nodeByID[node.ID] = node
	}
	executed := make(map[string]struct{})
	for _, id := range selectedFrame.NodeIDs {
		node := nodeByID[id]
		if node.Type == model.WorkflowNodeImageGeneration || node.Type == model.WorkflowNodeVideoGeneration {
			executed[id] = struct{}{}
		}
	}
	if len(executed) == 0 {
		return model.WorkflowGraph{}, newWorkflowFrameValidationError("workflow_frame_not_runnable", "Frame 不存在或没有可运行节点", map[string]any{"frameId": scope.FrameID})
	}
	included := make(map[string]struct{}, len(executed))
	for id := range executed {
		included[id] = struct{}{}
	}
	connections := make([]model.WorkflowConnection, 0)
	for _, connection := range graph.Connections {
		if _, targetIncluded := executed[connection.TargetNodeID]; !targetIncluded {
			continue
		}
		source := nodeByID[connection.SourceNodeID]
		switch source.Type {
		case model.WorkflowNodeImageGeneration, model.WorkflowNodeVideoGeneration:
			if _, sourceIncluded := executed[source.ID]; !sourceIncluded {
				return model.WorkflowGraph{}, newWorkflowFrameValidationError("workflow_frame_external_generation", "Frame 依赖了外部生成节点", map[string]any{"frameId": scope.FrameID, "sourceNodeId": source.ID, "targetNodeId": connection.TargetNodeID})
			}
		case model.WorkflowNodeImageInput, model.WorkflowNodeVideoInput, model.WorkflowNodeTextInput:
			included[source.ID] = struct{}{}
		default:
			return model.WorkflowGraph{}, fmt.Errorf("unsupported workflow source node type %q", source.Type)
		}
		connections = append(connections, connection)
	}
	nodes := make([]model.WorkflowNode, 0, len(included))
	for _, node := range graph.Nodes {
		if _, ok := included[node.ID]; ok {
			nodes = append(nodes, node)
		}
	}
	return model.WorkflowGraph{Version: graph.Version, Nodes: nodes, Connections: connections}, nil
}
