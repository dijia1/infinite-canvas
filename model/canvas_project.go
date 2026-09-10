package model

import (
	"encoding/json"
)

// CanvasProjectDocument keeps the JSON serialization used for canvas documents.
type CanvasProjectDocument json.RawMessage

func (document CanvasProjectDocument) MarshalJSON() ([]byte, error) {
	return json.RawMessage(document).MarshalJSON()
}

func (document *CanvasProjectDocument) UnmarshalJSON(value []byte) error {
	return (*json.RawMessage)(document).UnmarshalJSON(value)
}

// CanvasProject stores one Portal user's canvas metadata and graph document.
// Media remains in the media library; deleting a project never deletes media.
type CanvasProject struct {
	ID        string                `json:"id" gorm:"primaryKey"`
	OwnerUID  string                `json:"-" gorm:"primaryKey;index"`
	Title     string                `json:"title"`
	Document  CanvasProjectDocument `json:"document" gorm:"serializer:json"`
	Revision  int                   `json:"revision"`
	CreatedAt string                `json:"createdAt" gorm:"index"`
	UpdatedAt string                `json:"updatedAt" gorm:"index"`
}

type CanvasProjectDetail = CanvasProject

type CanvasSummary struct {
	ID              string `json:"id"`
	Title           string `json:"title"`
	Revision        int    `json:"revision"`
	CreatedAt       string `json:"createdAt"`
	UpdatedAt       string `json:"updatedAt"`
	NodeCount       int    `json:"nodeCount"`
	ConnectionCount int    `json:"connectionCount"`
}

type CanvasProjectList struct {
	Items []CanvasSummary `json:"items"`
	Total int             `json:"total"`
}

type CanvasProjectImportResult struct {
	Items []CanvasProjectDetail `json:"items"`
	Total int                   `json:"total"`
}

// CanvasSaveRequest records a successfully accepted PUT request for a short
// period. It lets clients safely retry when the server completed the write but
// the response did not reach the browser.
type CanvasSaveRequest struct {
	RequestID       string `gorm:"primaryKey;size:36"`
	ProjectID       string `gorm:"index"`
	UserUID         string `gorm:"index"`
	BaseRevision    int
	PayloadHash     string `gorm:"size:64"`
	ResultRevision  int
	ResultCreatedAt string
	ResultUpdatedAt string
	CreatedAt       string `gorm:"index"`
}
