package repository

import (
	"errors"
	"github.com/basketikun/infinite-canvas/model"
	"sync"
	"testing"
	"time"
)

func videoFixture(t *testing.T) (model.VideoGenerationTask, time.Time) {
	t.Helper()
	useRepositoryTestDB(t, newRepositoryTestConfig(t, "video_protocol"))
	current := time.Now().UTC()
	expired := current.Add(-time.Minute)
	if _, err := SaveMedia(model.Media{ID: "reference", OwnerUID: "owner", ObjectKey: "ref.mp4", ContentType: "video/mp4", ExpiresAt: &expired}); err != nil {
		t.Fatal(err)
	}
	return model.VideoGenerationTask{ID: "task", OwnerUID: "owner", ClientRequestID: "client", Status: "queued", InputMediaIDsJSON: `["reference"]`, ResultMediaIDsJSON: `[]`, ResultURLsJSON: `[]`, OperationLogID: "operation", NextPollAt: current, Deadline: current.Add(time.Hour), CreatedAt: current}, current
}
func createVideoFixture(t *testing.T, item model.VideoGenerationTask) {
	t.Helper()
	if _, err := CreateVideoGenerationTask(item, model.OperationLog{ID: item.OperationLogID, ActorUID: item.OwnerUID, Action: "video_generate", Status: model.OperationStatusSubmitted, CreatedAt: time.Now()}, []string{"reference"}); err != nil {
		t.Fatal(err)
	}
}
func TestVideoTaskCreationHoldsMediaAndIsIdempotent(t *testing.T) {
	item, current := videoFixture(t)
	createVideoFixture(t, item)
	duplicate := item
	duplicate.ID = "duplicate"
	duplicate.OperationLogID = "duplicate-operation"
	got, err := CreateVideoGenerationTask(duplicate, model.OperationLog{ID: "duplicate-operation"}, []string{"reference"})
	if err != nil || got.ID != item.ID {
		t.Fatalf("%+v %v", got, err)
	}
	if _, claimed, err := ClaimCanvasMediaCleanup("reference", current, time.Minute); err != nil || claimed {
		t.Fatalf("held reference claimed: %v %v", claimed, err)
	}
	media, _, _ := GetMedia("reference")
	if media.ExpiresAt == nil {
		t.Fatal("task hold must preserve expiry so cleanup can retry after task terminates")
	}
	if _, err := PreparePrivateMediaDeletion("reference", "owner", current); err == nil {
		t.Fatal("direct delete bypassed task hold")
	}
	if _, found, _ := GetVideoGenerationTask(item.ID, "other"); found {
		t.Fatal("cross-user task exposed")
	}
}
func TestVideoTaskCannotReferenceDeletingMedia(t *testing.T) {
	item, current := videoFixture(t)
	if _, claimed, err := ClaimCanvasMediaCleanup("reference", current, time.Minute); err != nil || !claimed {
		t.Fatal(err)
	}
	if _, err := CreateVideoGenerationTask(item, model.OperationLog{ID: item.OperationLogID}, []string{"reference"}); !errors.Is(err, ErrCanvasMediaUnavailable) {
		t.Fatalf("got %v", err)
	}
	if _, found, _ := GetVideoGenerationTask(item.ID, "owner"); found {
		t.Fatal("failed task insert leaked")
	}
}
func TestVideoTaskWorkersClaimOnceAndFenceOldLease(t *testing.T) {
	item, current := videoFixture(t)
	createVideoFixture(t, item)
	barrier := make(chan struct{})
	var wg sync.WaitGroup
	results := make(chan model.VideoGenerationTask, 2)
	errs := make(chan error, 2)
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-barrier
			task, found, err := ClaimNextVideoGenerationTask(current)
			if err != nil {
				errs <- err
			}
			if found {
				results <- task
			}
		}()
	}
	close(barrier)
	wg.Wait()
	close(results)
	close(errs)
	for err := range errs {
		t.Fatal(err)
	}
	if len(results) != 1 {
		t.Fatalf("claims=%d", len(results))
	}
	old := <-results
	next, found, err := ClaimNextVideoGenerationTask(current.Add(3 * time.Minute))
	if err != nil || !found {
		t.Fatal(err)
	}
	if err := UpdateClaimedVideoTask(old, map[string]any{"status": "failed"}); !errors.Is(err, ErrVideoLeaseLost) {
		t.Fatalf("old lease accepted: %v", err)
	}
	if err := UpdateClaimedVideoTask(next, map[string]any{"status": "running", "provider_task_id": "upstream", "lease_until": nil, "next_poll_at": current.Add(4 * time.Minute)}); err != nil {
		t.Fatal(err)
	}
	if _, found, err := ClaimNextVideoGenerationTask(current.Add(3 * time.Minute)); err != nil || found {
		t.Fatal("poll scheduled too early", err)
	}
}

func TestVideoTaskRejectsWritesAfterLeaseExpiresWithoutReplacement(t *testing.T) {
	item, current := videoFixture(t)
	createVideoFixture(t, item)
	claimed, found, err := ClaimNextVideoGenerationTask(current)
	if err != nil || !found || claimed.ID != item.ID {
		t.Fatalf("claim = %#v, %v, %v", claimed, found, err)
	}
	database, _ := DB()
	if err := database.Model(&model.VideoGenerationTask{}).Where("id = ?", claimed.ID).Updates(map[string]any{"lease_until": current.Add(-time.Second), "status": "saving"}).Error; err != nil {
		t.Fatal(err)
	}
	if err := UpdateClaimedVideoTask(claimed, map[string]any{"status": "running"}); !errors.Is(err, ErrVideoLeaseLost) {
		t.Fatalf("expired UpdateClaimedVideoTask() error = %v", err)
	}
	claimed.Status = "saving"
	if err := CompleteVideoGenerationTask(claimed, []model.Media{{ID: "expired-video-result", OwnerUID: claimed.OwnerUID}}); !errors.Is(err, ErrVideoLeaseLost) {
		t.Fatalf("expired CompleteVideoGenerationTask() error = %v", err)
	}
	if err := FinishFailedVideoTask(claimed, "late failure", current); !errors.Is(err, ErrVideoLeaseLost) {
		t.Fatalf("expired FinishFailedVideoTask() error = %v", err)
	}
}

func TestVideoCompletionRollsBackAndCanConverge(t *testing.T) {
	item, current := videoFixture(t)
	createVideoFixture(t, item)
	task, _, _ := ClaimNextVideoGenerationTask(current)
	if err := UpdateClaimedVideoTask(task, map[string]any{"status": "saving", "provider_task_id": "upstream"}); err != nil {
		t.Fatal(err)
	}
	db, _ := DB()
	if err := db.Create(&model.WorkflowRun{ID: "video-complete-run", OwnerUID: task.OwnerUID, RequestID: "video-run-request", Status: "running"}).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&model.WorkflowOutputAttempt{ID: "video-complete-attempt", RunID: "video-complete-run", NodeID: "node", SlotID: "slot", Attempt: 1, OwnerUID: task.OwnerUID, RequestID: task.ClientRequestID, Status: "running"}).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Exec(`CREATE FUNCTION fail_video_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit failure'; END $$`).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Exec(`CREATE TRIGGER fail_video_audit BEFORE UPDATE ON operation_logs FOR EACH ROW EXECUTE FUNCTION fail_video_audit()`).Error; err != nil {
		t.Fatal(err)
	}
	media := []model.Media{{ID: "result", OwnerUID: "owner", ObjectKey: "result.mp4", ContentType: "video/mp4"}}
	if err := CompleteVideoGenerationTask(task, media); err == nil {
		t.Fatal("expected rollback")
	}
	if _, found, _ := GetMedia("result"); found {
		t.Fatal("partial media committed")
	}
	var refs []model.WorkflowMediaRef
	if err := db.Where("media_id = ?", "result").Find(&refs).Error; err != nil || len(refs) != 0 {
		t.Fatalf("failed completion leaked workflow refs: %+v err=%v", refs, err)
	}
	state, _, _ := GetVideoGenerationTask(task.ID, "owner")
	if state.Status != "saving" {
		t.Fatal(state.Status)
	}
	if err := db.Exec(`DROP TRIGGER fail_video_audit ON operation_logs`).Error; err != nil {
		t.Fatal(err)
	}
	if err := CompleteVideoGenerationTask(task, media); err != nil {
		t.Fatal(err)
	}
	if err := CompleteVideoGenerationTask(task, media); !errors.Is(err, ErrVideoLeaseLost) {
		t.Fatal("completion repeated", err)
	}
	var op model.OperationLog
	if err := db.First(&op, "id = ?", item.OperationLogID).Error; err != nil {
		t.Fatal(err)
	}
	if op.Status != model.OperationStatusSuccess || len(op.MediaIDs) != 1 {
		t.Fatalf("audit %+v", op)
	}
	if err := db.Where("media_id = ?", "result").Find(&refs).Error; err != nil || len(refs) != 1 || refs[0].OwnerUID != task.OwnerUID || refs[0].Scope != "run" || refs[0].ScopeID != "video-complete-run" {
		t.Fatalf("missing transactional workflow video hold: %+v err=%v", refs, err)
	}
	if _, err := PreparePrivateMediaDeletion("result", task.OwnerUID, time.Now()); err == nil {
		t.Fatal("video result deletable before scheduler receives it")
	}
}

func TestVideoCompletionRejectsResultOwnedByAnotherUser(t *testing.T) {
	item, current := videoFixture(t)
	createVideoFixture(t, item)
	task, _, _ := ClaimNextVideoGenerationTask(current)
	if err := UpdateClaimedVideoTask(task, map[string]any{"status": "saving", "provider_task_id": "upstream"}); err != nil {
		t.Fatal(err)
	}
	foreign := model.Media{ID: "foreign-result", OwnerUID: "another-owner", ObjectKey: "foreign-result.mp4", ContentType: "video/mp4"}
	if err := CompleteVideoGenerationTask(task, []model.Media{foreign}); err == nil {
		t.Fatal("video completion accepted a cross-owner result")
	}
	if _, found, err := GetMedia(foreign.ID); err != nil || found {
		t.Fatalf("cross-owner result committed: found=%t err=%v", found, err)
	}
}
func TestVideoCanvasStableReferenceAndMalformedJSON(t *testing.T) {
	ids, err := CanvasDocumentMediaIDs([]byte(`{"nodes":[{"type":"video","metadata":{"mediaId":"remote"}}]}`))
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := ids["remote"]; !ok {
		t.Fatal("video reference missing")
	}
	if _, err := CanvasDocumentMediaIDs([]byte(`{"nodes":[{"type":"video","metadata":{"mediaId":3}}]}`)); err == nil {
		t.Fatal("malformed video reference accepted")
	}
}

func TestPublicImageDeletionCannotRaceVideoTaskInputs(t *testing.T) {
	item, current := videoFixture(t)
	db, _ := DB()
	if err := db.Model(&model.Media{}).Where("id = ?", "reference").Update("content_type", "image/png").Error; err != nil {
		t.Fatal(err)
	}
	if _, err := SavePublicImage(model.PublicImage{ID: "public-ref", MediaID: "reference"}); err != nil {
		t.Fatal(err)
	}
	item.OwnerUID = "reader"
	createVideoFixture(t, item)
	if _, err := PreparePublicImageDeletion("public-ref", current); err == nil {
		t.Fatal("public delete bypassed active task")
	}
	if _, found, err := GetPublicImage("public-ref"); err != nil || !found {
		t.Fatal("failed delete removed public reference", err)
	}
}

func TestVideoUploadPublicationLeaseAndReservationSurviveRetry(t *testing.T) {
	_, current := videoFixture(t)
	intent := model.MediaUploadIntent{ID: "video-upload", OwnerUID: "owner", ObjectKey: "staging.mp4", ContentType: "video/mp4", ExpiresAt: current.Add(15 * time.Minute).Format(time.RFC3339Nano)}
	if err := SaveMediaUploadIntent(intent); err != nil {
		t.Fatal(err)
	}
	first, err := ClaimVideoUploadCompletion(intent.ID, "owner", "final.mp4", current)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := ClaimVideoUploadCompletion(intent.ID, "owner", "other.mp4", current); err == nil {
		t.Fatal("concurrent publisher accepted")
	}
	next, err := ClaimVideoUploadCompletion(intent.ID, "owner", "other.mp4", current.Add(3*time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	if next.FinalObjectKey != first.FinalObjectKey || next.FinalizeClaimID == first.FinalizeClaimID {
		t.Fatal("reservation or lease lost")
	}
	media := model.Media{ID: "uploaded", OwnerUID: "owner", ObjectKey: first.FinalObjectKey, ContentType: "video/mp4"}
	_, _, created, err := FinalizeMediaUploadIntent(intent.ID, "owner", current.Add(3*time.Minute).Format(time.RFC3339Nano), media, first.FinalizeClaimID)
	if err != nil || created {
		t.Fatal("stale publisher committed", err)
	}
	_, _, created, err = FinalizeMediaUploadIntent(intent.ID, "owner", current.Add(3*time.Minute).Format(time.RFC3339Nano), media, next.FinalizeClaimID)
	if err != nil || !created {
		t.Fatal("publisher failed", err)
	}
	stored, err := ClaimVideoUploadCompletion(intent.ID, "owner", "another.mp4", current.Add(4*time.Minute))
	if err != nil || stored.CompletedMediaID != media.ID {
		t.Fatal("committed response loss not recoverable", err)
	}
}
