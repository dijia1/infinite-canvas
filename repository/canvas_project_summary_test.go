package repository

import (
	"bytes"
	"encoding/json"
	"log"
	"reflect"
	"regexp"
	"strings"
	"testing"

	"github.com/basketikun/infinite-canvas/model"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

func TestListCanvasProjectsReturnsOwnerScopedSummaryCountsWithoutDocuments(t *testing.T) {
	useRepositoryTestDB(t, newRepositoryTestConfig(t, "canvas_project_summaries"))
	database, err := DB()
	if err != nil {
		t.Fatal(err)
	}

	const owner = "canvas-summary-owner"
	fixtures := []model.CanvasProject{
		{
			ID: "current", OwnerUID: owner, Title: "当前画布", Revision: 4,
			Document:  model.CanvasProjectDocument(`{"nodes":[{"id":"node-a"},{"id":"node-b"}],"connections":[{"id":"line-a"}]}`),
			CreatedAt: "2026-09-10T01:00:00Z", UpdatedAt: "2026-09-10T04:00:00Z",
		},
		{
			ID: "empty", OwnerUID: owner, Title: "空画布", Revision: 2,
			Document:  model.CanvasProjectDocument(`{"nodes":[],"connections":[]}`),
			CreatedAt: "2026-09-10T02:00:00Z", UpdatedAt: "2026-09-10T03:00:00Z",
		},
		{
			ID: "missing-arrays", OwnerUID: owner, Title: "旧画布", Revision: 1,
			Document:  model.CanvasProjectDocument(`{"viewport":{"x":0,"y":0,"k":1}}`),
			CreatedAt: "2026-09-10T03:00:00Z", UpdatedAt: "2026-09-10T02:00:00Z",
		},
		{
			ID: "null-arrays", OwnerUID: owner, Title: "空值数组旧画布", Revision: 1,
			Document:  model.CanvasProjectDocument(`{"nodes":null,"connections":null}`),
			CreatedAt: "2026-09-10T03:00:00Z", UpdatedAt: "2026-09-10T01:30:00Z",
		},
		{
			ID: "non-array-values", OwnerUID: owner, Title: "错误类型旧画布", Revision: 1,
			Document:  model.CanvasProjectDocument(`{"nodes":42,"connections":{}}`),
			CreatedAt: "2026-09-10T03:00:00Z", UpdatedAt: "2026-09-10T01:00:00Z",
		},
		{
			ID: "current", OwnerUID: "another-owner", Title: "其他用户画布", Revision: 9,
			Document:  model.CanvasProjectDocument(`{"nodes":[{"id":"foreign"}],"connections":[]}`),
			CreatedAt: "2026-09-10T04:00:00Z", UpdatedAt: "2026-09-10T05:00:00Z",
		},
	}
	if err := database.Create(&fixtures).Error; err != nil {
		t.Fatal(err)
	}

	items, err := ListCanvasProjects(owner)
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 5 {
		t.Fatalf("ListCanvasProjects() returned %d items, want 5 owner-scoped items", len(items))
	}
	wantCounts := map[string][2]int{
		"current":          {2, 1},
		"empty":            {0, 0},
		"missing-arrays":   {0, 0},
		"null-arrays":      {0, 0},
		"non-array-values": {0, 0},
	}
	for _, item := range items {
		value := reflect.ValueOf(item)
		if document := value.FieldByName("Document"); document.IsValid() && document.Len() != 0 {
			t.Fatalf("ListCanvasProjects() returned the full document to Go for %q", item.ID)
		}
		encoded, err := json.Marshal(item)
		if err != nil {
			t.Fatal(err)
		}
		var summary struct {
			ID              string          `json:"id"`
			Document        json.RawMessage `json:"document"`
			NodeCount       int             `json:"nodeCount"`
			ConnectionCount int             `json:"connectionCount"`
		}
		if err := json.Unmarshal(encoded, &summary); err != nil {
			t.Fatal(err)
		}
		if len(summary.Document) != 0 {
			t.Fatalf("summary %q JSON contains document: %s", summary.ID, encoded)
		}
		want, ok := wantCounts[summary.ID]
		if !ok {
			t.Fatalf("ListCanvasProjects() leaked another owner's project %q", summary.ID)
		}
		if summary.NodeCount != want[0] || summary.ConnectionCount != want[1] {
			t.Errorf("summary %q counts = (%d, %d), want (%d, %d)", summary.ID, summary.NodeCount, summary.ConnectionCount, want[0], want[1])
		}
	}
}

func TestListCanvasProjectsUsesAnExplicitSummaryProjection(t *testing.T) {
	useRepositoryTestDB(t, newRepositoryTestConfig(t, "canvas_project_summary_projection"))
	database, err := DB()
	if err != nil {
		t.Fatal(err)
	}
	if err := database.Create(&model.CanvasProject{
		ID: "projection", OwnerUID: "projection-owner", Title: "投影", Revision: 1,
		Document:  model.CanvasProjectDocument(`{"nodes":[],"connections":[]}`),
		CreatedAt: "2026-09-10T01:00:00Z", UpdatedAt: "2026-09-10T01:00:00Z",
	}).Error; err != nil {
		t.Fatal(err)
	}

	var statements bytes.Buffer
	db = database.Session(&gorm.Session{Logger: logger.New(log.New(&statements, "", 0), logger.Config{
		LogLevel:             logger.Info,
		ParameterizedQueries: true,
		Colorful:             false,
	})})
	if _, err := ListCanvasProjects("projection-owner"); err != nil {
		t.Fatal(err)
	}

	query := canvasProjectListQuery(t, statements.String())
	projection := strings.ToLower(query[strings.Index(strings.ToLower(query), "select ")+len("select ") : strings.Index(strings.ToLower(query), " from ")])
	if strings.Contains(projection, "*") {
		t.Fatalf("canvas list query uses a wildcard projection: %s", query)
	}
	if regexp.MustCompile(`(^|,)\s*(canvas_projects\.)?"?document"?\s*(,|$)`).MatchString(projection) {
		t.Fatalf("canvas list query selects the full document column: %s", query)
	}
	for _, required := range []string{"id", "title", "revision", "created_at", "updated_at", "node_count", "connection_count"} {
		if !strings.Contains(projection, required) {
			t.Errorf("canvas list projection is missing %q: %s", required, query)
		}
	}
}

func canvasProjectListQuery(t *testing.T, statements string) string {
	t.Helper()
	for _, line := range strings.Split(statements, "\n") {
		lower := strings.ToLower(line)
		if strings.Contains(lower, "select ") && strings.Contains(lower, ` from "canvas_projects"`) {
			return line
		}
	}
	t.Fatalf("canvas list SELECT was not logged:\n%s", statements)
	return ""
}
