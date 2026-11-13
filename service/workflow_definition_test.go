package service

import (
	"strings"
	"testing"

	"github.com/basketikun/infinite-canvas/model"
)

func validWorkflowGraph() model.WorkflowGraph {
	return model.WorkflowGraph{
		Version: 1,
		Nodes: []model.WorkflowNode{
			{ID: "image-input", Type: model.WorkflowNodeImageInput, Position: model.WorkflowPoint{X: 0, Y: 0}},
			{ID: "text-input", Type: model.WorkflowNodeTextInput, Position: model.WorkflowPoint{X: 0, Y: 120}, Text: "生成产品图"},
			{
				ID: "image-generation", Type: model.WorkflowNodeImageGeneration, Position: model.WorkflowPoint{X: 300, Y: 0},
				InputPorts: []model.WorkflowInputPort{{ID: "reference", Type: model.WorkflowPortImage}, {ID: "prompt", Type: model.WorkflowPortText}},
				Config:     &model.WorkflowNodeConfig{ProviderID: "image-provider"},
				Outputs:    []model.WorkflowOutputSlot{{ID: "image-1", Type: model.WorkflowPortImage}},
			},
		},
		Connections: []model.WorkflowConnection{
			{SourceNodeID: "image-input", SourceSlotID: "output", TargetNodeID: "image-generation", TargetPortID: "reference", Order: 0},
			{SourceNodeID: "text-input", SourceSlotID: "output", TargetNodeID: "image-generation", TargetPortID: "prompt", Order: 1},
		},
	}
}

func TestNormalizeWorkflowGraphAcceptsDraftAndNineInputOutputBoundary(t *testing.T) {
	graph := validWorkflowGraph()
	graph.Nodes[0].MediaID = ""
	ports := make([]model.WorkflowInputPort, 9)
	outputs := make([]model.WorkflowOutputSlot, 9)
	for index := range 9 {
		ports[index] = model.WorkflowInputPort{ID: "port-" + string(rune('a'+index)), Type: model.WorkflowPortImage}
		outputs[index] = model.WorkflowOutputSlot{ID: "slot-" + string(rune('a'+index)), Type: model.WorkflowPortImage}
	}
	graph.Nodes[2].InputPorts = ports
	graph.Nodes[2].Outputs = outputs
	graph.Connections = nil

	got, err := normalizeWorkflowGraph(graph)
	if err != nil {
		t.Fatalf("normalizeWorkflowGraph() error = %v", err)
	}
	if len(got.Nodes[2].InputPorts) != 9 || len(got.Nodes[2].Outputs) != 9 || got.Nodes[0].MediaID != "" {
		t.Fatalf("normalized draft = %#v", got)
	}
}

func TestNormalizeWorkflowGraphRejectsInvalidStructure(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*model.WorkflowGraph)
		want   string
	}{
		{
			name: "twelve input ports",
			mutate: func(graph *model.WorkflowGraph) {
				graph.Nodes[2].InputPorts = append(graph.Nodes[2].InputPorts, []model.WorkflowInputPort{
					{ID: "three", Type: model.WorkflowPortImage}, {ID: "four", Type: model.WorkflowPortImage},
					{ID: "five", Type: model.WorkflowPortImage}, {ID: "six", Type: model.WorkflowPortImage},
					{ID: "seven", Type: model.WorkflowPortImage}, {ID: "eight", Type: model.WorkflowPortImage},
					{ID: "nine", Type: model.WorkflowPortImage}, {ID: "ten", Type: model.WorkflowPortImage},
					{ID: "eleven", Type: model.WorkflowPortImage}, {ID: "twelve", Type: model.WorkflowPortImage},
				}...)
			},
			want: "输入端口",
		},
		{
			name: "ten output slots",
			mutate: func(graph *model.WorkflowGraph) {
				for index := 1; index < 10; index++ {
					graph.Nodes[2].Outputs = append(graph.Nodes[2].Outputs, model.WorkflowOutputSlot{ID: "extra-" + string(rune('a'+index)), Type: model.WorkflowPortImage})
				}
			},
			want: "输出槽位",
		},
		{
			name: "cycle",
			mutate: func(graph *model.WorkflowGraph) {
				graph.Nodes = append(graph.Nodes, model.WorkflowNode{
					ID: "image-generation-2", Type: model.WorkflowNodeImageGeneration, Position: model.WorkflowPoint{X: 600, Y: 0},
					InputPorts: []model.WorkflowInputPort{{ID: "reference", Type: model.WorkflowPortImage}},
					Outputs:    []model.WorkflowOutputSlot{{ID: "image-2", Type: model.WorkflowPortImage}},
				})
				graph.Nodes[2].InputPorts = append(graph.Nodes[2].InputPorts, model.WorkflowInputPort{ID: "loop", Type: model.WorkflowPortImage})
				graph.Connections = append(graph.Connections,
					model.WorkflowConnection{SourceNodeID: "image-generation", SourceSlotID: "image-1", TargetNodeID: "image-generation-2", TargetPortID: "reference", Order: 0},
					model.WorkflowConnection{SourceNodeID: "image-generation-2", SourceSlotID: "image-2", TargetNodeID: "image-generation", TargetPortID: "loop", Order: 2},
				)
			},
			want: "循环",
		},
		{
			name: "type mismatch",
			mutate: func(graph *model.WorkflowGraph) {
				graph.Nodes[2].InputPorts[0].Type = model.WorkflowPortVideo
			},
			want: "类型",
		},
		{
			name: "duplicate target port",
			mutate: func(graph *model.WorkflowGraph) {
				graph.Nodes = append(graph.Nodes, model.WorkflowNode{ID: "image-input-2", Type: model.WorkflowNodeImageInput, Position: model.WorkflowPoint{X: 0, Y: 240}})
				graph.Connections = append(graph.Connections, model.WorkflowConnection{SourceNodeID: "image-input-2", SourceSlotID: "output", TargetNodeID: "image-generation", TargetPortID: "reference", Order: 2})
			},
			want: "目标端口",
		},
		{
			name: "duplicate order",
			mutate: func(graph *model.WorkflowGraph) {
				graph.Connections[1].Order = 0
			},
			want: "顺序",
		},
		{
			name: "unlisted url option",
			mutate: func(graph *model.WorkflowGraph) {
				graph.Nodes[2].Config.Options = map[string]any{"previewUrl": "https://signed.example/image.png"}
			},
			want: "地址或凭据",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			graph := validWorkflowGraph()
			test.mutate(&graph)
			_, err := normalizeWorkflowGraph(graph)
			if err == nil || !strings.Contains(err.Error(), test.want) {
				t.Fatalf("normalizeWorkflowGraph() error = %v, want containing %q", err, test.want)
			}
		})
	}
}
