package repository

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/basketikun/infinite-canvas/model"
)

func TestListWorkflowRunsOmitsSnapshotWithoutChangingResults(t *testing.T) {
	useRepositoryTestDB(t, newRepositoryTestConfig(t, "workflow_run_list"))
	current := time.Now().UTC().Truncate(time.Microsecond)
	snapshot := `{"version":1,"nodes":[],"connections":[],"note":"` + strings.Repeat("x", 65536) + `"}`
	base := model.WorkflowRun{OwnerUID: "owner", WorkflowID: "flow", Revision: 7, Title: "流程中文名称", Snapshot: snapshot, Status: "running", StateVersion: 9, StopRequested: true, CreatedAt: current, UpdatedAt: current.Add(time.Second)}
	stored := make(map[string]model.WorkflowRun)
	for _, fixture := range []struct {
		id, owner, workflow string
		age                 time.Duration
	}{
		{"run-b", "owner", "flow", 0}, {"run-c", "owner", "flow", 0},
		{"run-a", "owner", "other-flow", -time.Hour}, {"run-foreign", "other-owner", "flow", time.Hour},
	} {
		item := base
		item.ID, item.RequestID, item.OwnerUID, item.WorkflowID = fixture.id, fixture.id+"-request", fixture.owner, fixture.workflow
		item.CreatedAt = current.Add(fixture.age)
		if _, inserted, err := CreateWorkflowRun(item, nil, nil, nil); err != nil || !inserted {
			t.Fatalf("create fixture: inserted=%t err=%v", inserted, err)
		}
		record, found, err := GetWorkflowRun(item.OwnerUID, item.ID)
		if err != nil || !found {
			t.Fatalf("read fixture: found=%t err=%v", found, err)
		}
		stored[item.ID] = record.Run
	}
	for _, tc := range []struct {
		name, owner, workflow string
		page, size            int
		ids                   []string
		total                 int64
	}{
		{"first page stable tie order", "owner", "", 1, 1, []string{"run-c"}, 3},
		{"second page", "owner", "", 2, 1, []string{"run-b"}, 3},
		{"last page", "owner", "", 3, 1, []string{"run-a"}, 3},
		{"workflow filter", "owner", "flow", 1, 10, []string{"run-c", "run-b"}, 2},
		{"beyond last page", "owner", "flow", 3, 1, nil, 2},
		{"owner isolation", "other-owner", "flow", 1, 10, []string{"run-foreign"}, 1},
		{"unknown owner", "missing", "", 1, 10, nil, 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			items, total, err := ListWorkflowRuns(tc.owner, tc.workflow, tc.page, tc.size)
			if err != nil || total != tc.total || len(items) != len(tc.ids) {
				t.Fatalf("list: count=%d total=%d err=%v", len(items), total, err)
			}
			for i, item := range items {
				if item.ID != tc.ids[i] {
					t.Fatalf("order=%s, want %s", item.ID, tc.ids[i])
				}
				if item.Snapshot != "" {
					t.Fatalf("list loaded %d bytes of snapshot for %s", len(item.Snapshot), item.ID)
				}
				want := stored[item.ID]
				gotJSON, _ := json.Marshal(item)
				wantJSON, _ := json.Marshal(want)
				if string(gotJSON) != string(wantJSON) {
					t.Fatalf("public list fields changed: got %s want %s", gotJSON, wantJSON)
				}
			}
		})
	}
	detail, found, err := GetWorkflowRun("owner", "run-b")
	if err != nil || !found || detail.Run.Snapshot != snapshot {
		t.Fatalf("detail snapshot lost: found=%t bytes=%d err=%v", found, len(detail.Run.Snapshot), err)
	}
	byRequest, found, err := GetWorkflowRunByRequest("owner", "run-b-request")
	if err != nil || !found || byRequest.Snapshot != snapshot {
		t.Fatalf("idempotent request snapshot lost: found=%t err=%v", found, err)
	}
	open, err := ListOpenWorkflowRuns("", 10)
	if err != nil || len(open) != 4 {
		t.Fatalf("scheduler run list count=%d err=%v", len(open), err)
	}
	for _, item := range open {
		if item.Snapshot != snapshot {
			t.Fatalf("scheduler snapshot lost for %s", item.ID)
		}
	}
}
