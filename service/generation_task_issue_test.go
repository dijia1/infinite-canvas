package service

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"
	"time"

	"github.com/basketikun/infinite-canvas/ai"
	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/repository"
)

type classifiedQueryProvider struct {
	err     error
	status  string
	creates int
}

func (p *classifiedQueryProvider) CreateImageTask(context.Context, ai.ImageTaskRequest) (ai.ImageTask, error) {
	p.creates++
	return ai.ImageTask{}, p.err
}
func (p *classifiedQueryProvider) GetImageTask(context.Context, string) (ai.ImageTask, error) {
	return ai.ImageTask{ID: "original-upstream", Status: p.status}, p.err
}
func (p *classifiedQueryProvider) SummarizeImageTaskRequest(ai.ImageTaskRequest) (ai.ImageTaskRequestSummary, error) {
	return ai.ImageTaskRequestSummary{}, nil
}
func (p *classifiedQueryProvider) CreateVideo(context.Context, ai.VideoRequest) (ai.VideoTask, error) {
	p.creates++
	return ai.VideoTask{}, p.err
}
func (p *classifiedQueryProvider) GetVideo(context.Context, string) (ai.VideoTask, error) {
	return ai.VideoTask{ID: "original-upstream", Status: p.status}, p.err
}

func TestGenerationQueryIssuesMatchCanvasAndWorkflow(t *testing.T) {
	for _, kind := range []string{"image", "video"} {
		for _, test := range []struct {
			code          int
			status, issue string
		}{{503, "running", ai.TaskIssueTransient}, {429, "running", ai.TaskIssueTransient}, {401, "paused", ai.TaskIssueConfiguration}, {404, "uncertain", ai.TaskIssueMissing}, {0, "uncertain", ai.TaskIssueUnknown}, {-1, "paused", ai.TaskIssueConfiguration}} {
			t.Run(fmt.Sprintf("%s-%d", kind, test.code), func(t *testing.T) {
				provider := &classifiedQueryProvider{status: ai.ImageTaskStatusUncertain}
				if test.code > 0 {
					provider.err = ai.NewTaskQueryError(test.code, "供应商查询异常")
				}
				providerType := newID("query-provider")
				if err := ai.Register(ai.ProviderType{ID: providerType, Name: providerType, Capabilities: []ai.Capability{ai.CapabilityImageGenerate, ai.CapabilityVideoGenerate}, New: func(json.RawMessage) (ai.Provider, error) {
					if test.code == -1 {
						return nil, fmt.Errorf("invalid provider configuration")
					}
					return provider, nil
				}}); err != nil {
					t.Fatal(err)
				}
				db, _ := repository.DB()
				current := time.Now().UTC()
				until := current.Add(time.Minute)
				taskID, owner := newID("query-task"), newID("query-owner")
				var issue *model.GenerationTaskIssue
				var canvasError string
				if kind == "image" {
					task := model.ImageGenerationTask{ID: taskID, OwnerUID: owner, ClientRequestID: newID("request"), Status: model.ImageTaskRunning, ProviderType: providerType, ProviderTaskID: "original-upstream", ReferencesJSON: "[]", ClaimID: "claim", LeaseUntil: &until, CreatedAt: now(), UpdatedAt: now()}
					if err := db.Create(&task).Error; err != nil {
						t.Fatal(err)
					}
					t.Cleanup(func() { db.Delete(&task) })
					executeImageTask(context.Background(), task)
					stored, _, _ := repository.GetImageGenerationTask(taskID)
					view, err := GetImageTask(WithPortalUser(context.Background(), PortalUser{UID: owner}), taskID)
					if err != nil || view.Status != test.status || stored.ProviderTaskID != "original-upstream" {
						t.Fatalf("image=%+v err=%v", view, err)
					}
					issue, canvasError = view.Issue, view.Error
				} else {
					task := model.VideoGenerationTask{ID: taskID, OwnerUID: owner, ClientRequestID: newID("request"), Status: "running", ProviderType: providerType, ProviderTaskID: "original-upstream", ProviderConfig: `{}`, ClaimID: "claim", LeaseUntil: &until, Deadline: current.Add(time.Hour), NextPollAt: current, ResultMediaIDsJSON: "[]", ResultURLsJSON: "[]", CreatedAt: current, UpdatedAt: current}
					if err := db.Create(&task).Error; err != nil {
						t.Fatal(err)
					}
					t.Cleanup(func() { db.Delete(&task) })
					if err := processVideoTaskStep(context.Background(), task, current); err != nil {
						t.Fatal(err)
					}
					stored, _, _ := repository.GetVideoGenerationTask(taskID, owner)
					view, err := GetVideoGenerationTask(WithPortalUser(context.Background(), PortalUser{UID: owner}), taskID)
					if err != nil || view.Status != test.status || stored.ProviderTaskID != "original-upstream" {
						t.Fatalf("video=%+v err=%v", view, err)
					}
					issue, canvasError = view.Issue, view.Error
				}
				if issue == nil || issue.Kind != test.issue || issue.Stage != "query" {
					t.Fatalf("canvas issue=%+v", issue)
				}
				if test.issue == ai.TaskIssueTransient && (issue.ConsecutiveFailures != 1 || issue.NextRetryAt == nil) {
					t.Fatalf("retry info=%+v", issue)
				}
				nodeType := model.WorkflowNodeImageGeneration
				if kind == "video" {
					nodeType = model.WorkflowNodeVideoGeneration
				}
				run := seedWorkflowRunGraph(t, newID("issue-run"), owner, model.WorkflowGraph{Version: 1, Nodes: []model.WorkflowNode{{ID: "generate", Type: nodeType, Outputs: []model.WorkflowOutputSlot{{ID: "out", Type: model.WorkflowPortType(kind)}}}}})
				attempt := model.WorkflowOutputAttempt{ID: newID("attempt"), OwnerUID: owner, RunID: run.ID, NodeID: "generate", SlotID: "out", Attempt: 1, RequestID: newID("attempt-request"), TaskType: kind, TaskID: taskID, Status: "running", CreatedAt: current, UpdatedAt: current}
				if err := db.Create(&attempt).Error; err != nil {
					t.Fatal(err)
				}
				if err := db.Model(&model.WorkflowOutputExecution{}).Where("run_id = ?", run.ID).Update("status", "running").Error; err != nil {
					t.Fatal(err)
				}
				detail, err := GetWorkflowRun(context.Background(), PortalUser{UID: owner}, run.ID)
				if err != nil || len(detail.Outputs) != 1 || detail.Outputs[0].TaskStatus != test.status || detail.Outputs[0].Issue == nil || detail.Outputs[0].Issue.Kind != issue.Kind || detail.Outputs[0].Error != canvasError {
					t.Fatalf("workflow=%+v err=%v", detail, err)
				}
				if provider.creates != 0 {
					t.Fatalf("query retried generation %d times", provider.creates)
				}
			})
		}
	}
}

func TestResumeRefreshesOnlyAuthenticationForOriginalTask(t *testing.T) {
	original, err := AdminSettings()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if _, err := saveGenerationSettingsForTest(t, original); err != nil {
			t.Error(err)
		}
	})
	settings := original
	providerID := newID("credential-provider")
	settings.AI = model.AISettings{Providers: []model.AIProvider{{ID: providerID, Type: "maizi-image", Config: json.RawMessage(`{"apiKey":"new-key","model":"new-model","baseURL":"https://new.example"}`)}}}
	if _, err := saveGenerationSettingsForTest(t, settings); err != nil {
		t.Fatal(err)
	}
	db, _ := repository.DB()
	deadline := time.Now().UTC().Add(time.Hour)
	task := model.ImageGenerationTask{ID: newID("resume-task"), OwnerUID: newID("owner"), ClientRequestID: newID("client"), Status: model.ImageTaskPaused, ProviderID: providerID, ProviderType: "maizi-image", ProviderConfig: `{"apiKey":"old-key","model":"original-model","baseURL":"https://original.example"}`, ProviderTaskID: "original-upstream", Deadline: &deadline, ReferencesJSON: "[]", ErrorKind: ai.TaskIssueConfiguration, ErrorStage: "query", PollFailures: 5}
	if err := db.Create(&task).Error; err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Delete(&task) })
	if _, err := ResumeImageGenerationTask(WithPortalUser(context.Background(), PortalUser{UID: task.OwnerUID}), task.ID); err != nil {
		t.Fatal(err)
	}
	stored, _, _ := repository.GetImageGenerationTask(task.ID)
	var value map[string]string
	if err := json.Unmarshal([]byte(stored.ProviderConfig), &value); err != nil {
		t.Fatal(err)
	}
	if value["apiKey"] != "new-key" || value["model"] != "original-model" || value["baseURL"] != "https://original.example" || stored.ProviderTaskID != task.ProviderTaskID || stored.ErrorKind != "" || stored.PollFailures != 0 {
		t.Fatalf("resumed config=%+v task=%+v", value, stored)
	}
}
