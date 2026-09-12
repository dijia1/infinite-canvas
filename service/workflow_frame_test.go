package service

import (
	"errors"
	"testing"

	"github.com/basketikun/infinite-canvas/model"
)

func frameSelectionGraph() model.WorkflowGraph {
	return model.WorkflowGraph{
		Version: 1,
		Nodes: []model.WorkflowNode{
			{ID: "outside-text", Type: model.WorkflowNodeTextInput, Text: "style"},
			{ID: "outside-image", Type: model.WorkflowNodeImageInput, MediaID: "media-static"},
			{ID: "a", Type: model.WorkflowNodeImageGeneration, InputPorts: []model.WorkflowInputPort{{ID: "text", Type: model.WorkflowPortText}, {ID: "image", Type: model.WorkflowPortImage}}, Outputs: []model.WorkflowOutputSlot{{ID: "a-1", Type: model.WorkflowPortImage}, {ID: "a-2", Type: model.WorkflowPortImage}}},
			{ID: "b", Type: model.WorkflowNodeImageGeneration, InputPorts: []model.WorkflowInputPort{{ID: "image", Type: model.WorkflowPortImage}}, Outputs: []model.WorkflowOutputSlot{{ID: "b-1", Type: model.WorkflowPortImage}}},
		},
		Connections: []model.WorkflowConnection{
			{SourceNodeID: "outside-text", SourceSlotID: "output", TargetNodeID: "a", TargetPortID: "text", Order: 0},
			{SourceNodeID: "outside-image", SourceSlotID: "output", TargetNodeID: "a", TargetPortID: "image", Order: 1},
			{SourceNodeID: "a", SourceSlotID: "a-1", TargetNodeID: "b", TargetPortID: "image", Order: 0},
		},
		Frames: []model.WorkflowFrame{{ID: "frame-a", Name: "A", Width: 600, Height: 400, NodeIDs: []string{"a"}}, {ID: "frame-b", Name: "B", Width: 600, Height: 400, NodeIDs: []string{"b"}}},
	}
}

func TestSelectWorkflowRunGraphKeepsExternalStaticInputsAndStopsOutgoingConnections(t *testing.T) {
	selected, err := SelectWorkflowRunGraph(frameSelectionGraph(), model.WorkflowRunScope{Type: model.WorkflowRunScopeFrame, FrameID: "frame-a"})
	if err != nil {
		t.Fatal(err)
	}
	if len(selected.Nodes) != 3 || len(selected.Connections) != 2 || selected.Frames != nil {
		t.Fatalf("selected graph = %#v", selected)
	}
	if selected.Nodes[2].ID != "a" || len(selected.Nodes[2].Outputs) != 2 {
		t.Fatalf("generation output slots changed: %#v", selected.Nodes[2])
	}
}

func TestSelectWorkflowRunGraphRejectsExternalGenerationDependency(t *testing.T) {
	_, err := SelectWorkflowRunGraph(frameSelectionGraph(), model.WorkflowRunScope{Type: model.WorkflowRunScopeFrame, FrameID: "frame-b"})
	var business *WorkflowBusinessError
	if !errors.As(err, &business) || business.Code != "workflow_frame_external_generation" || business.Data["sourceNodeId"] != "a" || business.Data["targetNodeId"] != "b" {
		t.Fatalf("error = %#v", err)
	}
}

func TestSelectWorkflowRunGraphRejectsMissingAndEmptyFrames(t *testing.T) {
	graph := frameSelectionGraph()
	graph.Frames = append(graph.Frames, model.WorkflowFrame{ID: "empty", Name: "Empty", Width: 100, Height: 100})
	for _, id := range []string{"missing", "empty"} {
		_, err := SelectWorkflowRunGraph(graph, model.WorkflowRunScope{Type: model.WorkflowRunScopeFrame, FrameID: id})
		var business *WorkflowBusinessError
		if !errors.As(err, &business) || business.Code != "workflow_frame_not_runnable" {
			t.Fatalf("frame %s error = %#v", id, err)
		}
	}
}

func TestNormalizeWorkflowGraphValidatesFramesAndDoesNotMutateInput(t *testing.T) {
	graph := validWorkflowGraph()
	graph.Frames = []model.WorkflowFrame{{ID: "frame-a", Name: " A ", Position: model.WorkflowPoint{X: 10, Y: 20}, Width: 300, Height: 200, NodeIDs: []string{"image-generation"}}}
	normalized, err := normalizeWorkflowGraph(graph)
	if err != nil {
		t.Fatal(err)
	}
	if normalized.Frames[0].Name != "A" || graph.Frames[0].Name != " A " {
		t.Fatalf("normalized=%#v input=%#v", normalized.Frames, graph.Frames)
	}

	invalid := make([]model.WorkflowGraph, 4)
	for i := range invalid {
		invalid[i] = graph
		invalid[i].Frames = append([]model.WorkflowFrame(nil), graph.Frames...)
		invalid[i].Frames[0].NodeIDs = append([]string(nil), graph.Frames[0].NodeIDs...)
	}
	invalid[0].Frames = append(invalid[0].Frames, model.WorkflowFrame{ID: "frame-b", Name: "B", Width: 100, Height: 100, NodeIDs: []string{"image-generation"}})
	invalid[1].Frames[0].NodeIDs = []string{"missing"}
	invalid[2].Frames[0].Width = 0
	invalid[3].Frames[0].NodeIDs = []string{"frame-a"}
	for index := range invalid {
		if _, err := normalizeWorkflowGraph(invalid[index]); err == nil {
			t.Fatalf("invalid frame graph %d was accepted", index)
		}
	}
}

func TestNormalizeWorkflowGraphRejectsOverlappingFrames(t *testing.T) {
	tests := []struct {
		name   string
		second model.WorkflowFrame
	}{
		{
			name:   "partial overlap",
			second: model.WorkflowFrame{ID: "frame-b", Name: "B", Position: model.WorkflowPoint{X: 90, Y: 40}, Width: 80, Height: 80},
		},
		{
			name:   "contained frame",
			second: model.WorkflowFrame{ID: "frame-b", Name: "B", Position: model.WorkflowPoint{X: 40, Y: 30}, Width: 20, Height: 20},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			graph := model.WorkflowGraph{
				Version: 1,
				Frames: []model.WorkflowFrame{
					{ID: "frame-a", Name: "A", Position: model.WorkflowPoint{X: 10, Y: 20}, Width: 100, Height: 100},
					test.second,
				},
			}
			_, err := normalizeWorkflowGraph(graph)
			if err == nil || err.Error() != "Frame 不能重叠" {
				t.Fatalf("normalizeWorkflowGraph() error = %v, want Frame 不能重叠", err)
			}
		})
	}
}

func TestNormalizeWorkflowGraphAllowsFrameBoundaryContact(t *testing.T) {
	tests := []struct {
		name   string
		second model.WorkflowFrame
	}{
		{
			name:   "vertical edge",
			second: model.WorkflowFrame{ID: "frame-b", Name: "B", Position: model.WorkflowPoint{X: 110, Y: 40}, Width: 80, Height: 80},
		},
		{
			name:   "horizontal edge",
			second: model.WorkflowFrame{ID: "frame-b", Name: "B", Position: model.WorkflowPoint{X: 40, Y: 120}, Width: 80, Height: 80},
		},
		{
			name:   "corner",
			second: model.WorkflowFrame{ID: "frame-b", Name: "B", Position: model.WorkflowPoint{X: 110, Y: 120}, Width: 80, Height: 80},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			graph := model.WorkflowGraph{
				Version: 1,
				Frames: []model.WorkflowFrame{
					{ID: "frame-a", Name: "A", Position: model.WorkflowPoint{X: 10, Y: 20}, Width: 100, Height: 100},
					test.second,
				},
			}
			if _, err := normalizeWorkflowGraph(graph); err != nil {
				t.Fatalf("normalizeWorkflowGraph() error = %v", err)
			}
		})
	}
}
