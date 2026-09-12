package model

// WorkflowNodeType identifies the five node kinds supported by the first
// workflow graph contract.
type WorkflowNodeType string

const (
	WorkflowNodeImageInput      WorkflowNodeType = "image_input"
	WorkflowNodeVideoInput      WorkflowNodeType = "video_input"
	WorkflowNodeTextInput       WorkflowNodeType = "text_input"
	WorkflowNodeImageGeneration WorkflowNodeType = "image_generation"
	WorkflowNodeVideoGeneration WorkflowNodeType = "video_generation"
)

type WorkflowPortType string

const (
	WorkflowPortImage WorkflowPortType = "image"
	WorkflowPortVideo WorkflowPortType = "video"
	WorkflowPortText  WorkflowPortType = "text"
)

type WorkflowPoint struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
}

type WorkflowInputPort struct {
	ID   string           `json:"id"`
	Type WorkflowPortType `json:"type"`
}

type WorkflowOutputSlot struct {
	ID       string           `json:"id"`
	Type     WorkflowPortType `json:"type"`
	Position *WorkflowPoint   `json:"position,omitempty"`
	Width    *float64         `json:"width,omitempty"`
	Height   *float64         `json:"height,omitempty"`
}

// WorkflowNodeConfig contains browser-safe generation choices. Provider
// credentials and provider configuration never belong in a saved graph.
type WorkflowNodeConfig struct {
	ProviderID    string         `json:"providerId,omitempty"`
	Size          string         `json:"size,omitempty"`
	Resolution    string         `json:"resolution,omitempty"`
	Quality       string         `json:"quality,omitempty"`
	OutputFormat  string         `json:"outputFormat,omitempty"`
	Background    string         `json:"background,omitempty"`
	Seconds       *int           `json:"seconds,omitempty"`
	GenerateAudio *bool          `json:"generateAudio,omitempty"`
	Options       map[string]any `json:"options,omitempty"`
}

type WorkflowNode struct {
	ID         string               `json:"id"`
	Type       WorkflowNodeType     `json:"type"`
	Position   WorkflowPoint        `json:"position"`
	Width      *float64             `json:"width,omitempty"`
	Height     *float64             `json:"height,omitempty"`
	Text       string               `json:"text,omitempty"`
	MediaID    string               `json:"mediaId,omitempty"`
	InputPorts []WorkflowInputPort  `json:"inputPorts,omitempty"`
	Config     *WorkflowNodeConfig  `json:"config,omitempty"`
	Outputs    []WorkflowOutputSlot `json:"outputs,omitempty"`
}

type WorkflowConnection struct {
	SourceNodeID string `json:"sourceNodeId"`
	SourceSlotID string `json:"sourceSlotId"`
	TargetNodeID string `json:"targetNodeId"`
	TargetPortID string `json:"targetPortId"`
	Order        int    `json:"order"`
}

type WorkflowFrame struct {
	ID       string        `json:"id"`
	Name     string        `json:"name"`
	Position WorkflowPoint `json:"position"`
	Width    float64       `json:"width"`
	Height   float64       `json:"height"`
	NodeIDs  []string      `json:"nodeIds"`
}

type WorkflowGraph struct {
	Version     int                  `json:"version"`
	Nodes       []WorkflowNode       `json:"nodes"`
	Connections []WorkflowConnection `json:"connections"`
	Frames      []WorkflowFrame      `json:"frames,omitempty"`
}

// Workflow stores one owner-scoped, reusable graph definition. Runs keep
// their own immutable snapshots and therefore do not depend on this row.
type Workflow struct {
	ID        string        `json:"id" gorm:"primaryKey;size:128"`
	OwnerUID  string        `json:"-" gorm:"primaryKey;size:128;index;not null"`
	Name      string        `json:"name" gorm:"size:128;not null"`
	Graph     WorkflowGraph `json:"graph" gorm:"type:jsonb;serializer:json;not null"`
	Revision  int           `json:"revision" gorm:"not null;check:workflow_revision_positive,revision > 0"`
	CreatedAt string        `json:"createdAt" gorm:"index;not null"`
	UpdatedAt string        `json:"updatedAt" gorm:"index;not null"`
}

type WorkflowListItem struct {
	ID              string `json:"id"`
	Name            string `json:"name"`
	Revision        int    `json:"revision"`
	NodeCount       int    `json:"nodeCount"`
	ConnectionCount int    `json:"connectionCount"`
	CreatedAt       string `json:"createdAt"`
	UpdatedAt       string `json:"updatedAt"`
}

type WorkflowList struct {
	Items    []WorkflowListItem `json:"items"`
	Total    int64              `json:"total"`
	Page     int                `json:"page"`
	PageSize int                `json:"pageSize"`
}
