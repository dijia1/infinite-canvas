package repository

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/basketikun/infinite-canvas/model"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

type cleanupClaimResult struct {
	item    model.Media
	claimed bool
	err     error
}

func TestMediaCleanupWaitsForImageSnapshotPreparationReference(t *testing.T) {
	database, current := seedCleanupProtocolMedia(t, "cleanup_image_preparation")
	transaction := database.Begin()
	if transaction.Error != nil {
		t.Fatal(transaction.Error)
	}
	var locked model.Media
	if err := transaction.Clauses(clause.Locking{Strength: "UPDATE"}).First(&locked, "id = ?", "image").Error; err != nil {
		_ = transaction.Rollback()
		t.Fatal(err)
	}

	result := make(chan cleanupClaimResult, 1)
	go func() {
		item, claimed, err := ClaimCanvasMediaCleanup("image", current, time.Minute)
		result <- cleanupClaimResult{item: item, claimed: claimed, err: err}
	}()
	select {
	case early := <-result:
		_ = transaction.Rollback()
		t.Fatalf("cleanup did not wait for media lock: %#v", early)
	case <-time.After(100 * time.Millisecond):
	}

	task := model.ImageGenerationTask{ID: "preparing-task", OwnerUID: "owner", ClientRequestID: "preparing-request", Status: model.ImageTaskPreparing}
	input := model.ImageGenerationTaskInput{ID: "preparing-input", TaskID: task.ID, Position: 0, Purpose: "image", SourceMediaID: "image", SourceObjectKey: "image", PreparationStatus: "pending"}
	if err := transaction.Create(&task).Error; err != nil {
		_ = transaction.Rollback()
		t.Fatal(err)
	}
	if err := transaction.Create(&input).Error; err != nil {
		_ = transaction.Rollback()
		t.Fatal(err)
	}
	if err := transaction.Commit().Error; err != nil {
		t.Fatal(err)
	}

	select {
	case claimed := <-result:
		if claimed.err != nil || claimed.claimed {
			t.Fatalf("cleanup claimed media used by preparing image task: %#v", claimed)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("cleanup did not resume after image task transaction committed")
	}
}

func seedCleanupProtocolMedia(t *testing.T, prefix string) (*gorm.DB, time.Time) {
	t.Helper()
	useRepositoryTestDB(t, newRepositoryTestConfig(t, prefix))
	current := time.Now().UTC()
	expired := current.Add(-time.Minute)
	if _, err := SaveMedia(model.Media{ID: "image", OwnerUID: "owner", ObjectKey: "image", ExpiresAt: &expired}); err != nil {
		t.Fatal(err)
	}
	database, err := DB()
	if err != nil {
		t.Fatal(err)
	}
	return database, current
}

func cleanupClaimAsync(current time.Time) <-chan cleanupClaimResult {
	done := make(chan cleanupClaimResult, 1)
	go func() {
		item, claimed, err := ClaimCanvasMediaCleanup("image", current, time.Minute)
		done <- cleanupClaimResult{item, claimed, err}
	}()
	return done
}

func awaitCleanupSignal(t *testing.T, signal <-chan struct{}) {
	t.Helper()
	select {
	case <-signal:
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for transaction barrier")
	}
}

func awaitCleanupClaim(t *testing.T, result <-chan cleanupClaimResult) cleanupClaimResult {
	t.Helper()
	select {
	case value := <-result:
		return value
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for cleanup claim")
		return cleanupClaimResult{}
	}
}

// Observe an actual PostgreSQL lock wait instead of relying on goroutine timing.
func awaitCleanupLockWait(t *testing.T, database *gorm.DB, pids <-chan int) {
	t.Helper()
	var pid int
	select {
	case pid = <-pids:
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for cleanup connection")
	}
	deadline := time.NewTimer(5 * time.Second)
	defer deadline.Stop()
	ticker := time.NewTicker(5 * time.Millisecond)
	defer ticker.Stop()
	for {
		var waiting bool
		if err := database.Raw("SELECT COALESCE(wait_event_type = 'Lock', false) FROM pg_stat_activity WHERE pid = ?", pid).Scan(&waiting).Error; err != nil {
			t.Fatal(err)
		}
		if waiting {
			return
		}
		select {
		case <-deadline.C:
			t.Fatal("cleanup never entered PostgreSQL lock wait")
		case <-ticker.C:
		}
	}
}

func cleanupMediaLockQuery(tx *gorm.DB) bool {
	_, isMedia := tx.Statement.Dest.(*model.Media)
	_, isBatch := tx.Statement.Dest.(*[]model.Media)
	_, locking := tx.Statement.Clauses["FOR"]
	return (isMedia || isBatch) && locking
}

func sendCleanupBackendPID(tx *gorm.DB, pids chan<- int) {
	var pid int
	if err := tx.Statement.ConnPool.QueryRowContext(context.Background(), "SELECT pg_backend_pid()").Scan(&pid); err != nil {
		tx.AddError(err)
		return
	}
	pids <- pid
}

func TestCanvasCleanupClaimsSerializeAcrossWorkers(t *testing.T) {
	database, current := seedCleanupProtocolMedia(t, "cleanup_worker_race")
	locked := make(chan struct{})
	release := make(chan struct{})
	pids := make(chan int, 1)
	var releaseOnce sync.Once
	unblock := func() { releaseOnce.Do(func() { close(release) }) }
	defer unblock()
	var queries atomic.Int32
	beforeName, afterName := "test_cleanup_worker_before", "test_cleanup_worker_after"
	if err := database.Callback().Query().Before("gorm:query").Register(beforeName, func(tx *gorm.DB) {
		if !cleanupMediaLockQuery(tx) {
			return
		}
		index := queries.Add(1)
		tx.InstanceSet("cleanup_test_query_index", index)
		if index == 2 {
			sendCleanupBackendPID(tx, pids)
		}
	}); err != nil {
		t.Fatal(err)
	}
	if err := database.Callback().Query().After("gorm:query").Register(afterName, func(tx *gorm.DB) {
		if index, ok := tx.InstanceGet("cleanup_test_query_index"); ok && index.(int32) == 1 && tx.Error == nil {
			close(locked)
			<-release
		}
	}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { database.Callback().Query().Remove(beforeName); database.Callback().Query().Remove(afterName) })
	first := cleanupClaimAsync(current)
	awaitCleanupSignal(t, locked)
	second := cleanupClaimAsync(current)
	awaitCleanupLockWait(t, database, pids)
	unblock()
	winner, loser := awaitCleanupClaim(t, first), awaitCleanupClaim(t, second)
	if winner.err != nil || !winner.claimed || winner.item.CleanupClaimID == "" {
		t.Fatalf("first claim: %#v", winner)
	}
	if loser.err != nil || loser.claimed {
		t.Fatalf("second claim: %#v", loser)
	}
	stored, found, err := GetMedia("image")
	if err != nil || !found || stored.CleanupClaimID != winner.item.CleanupClaimID {
		t.Fatalf("stored claim changed: %#v %v", stored, err)
	}
}

func TestCanvasCleanupWaitsForReferenceRestoreTransaction(t *testing.T) {
	database, current := seedCleanupProtocolMedia(t, "cleanup_restore_race")
	if _, _, err := CreateCanvasProject(model.CanvasProject{ID: "project", OwnerUID: "owner", Document: model.CanvasProjectDocument(`{}`), Revision: 1}); err != nil {
		t.Fatal(err)
	}
	restored := make(chan struct{})
	release := make(chan struct{})
	pids := make(chan int, 1)
	var releaseOnce sync.Once
	unblock := func() { releaseOnce.Do(func() { close(release) }) }
	defer unblock()
	updateName, queryName := "test_cleanup_restore_update", "test_cleanup_restore_query"
	if err := database.Callback().Update().After("gorm:update").Register(updateName, func(tx *gorm.DB) {
		if tx.Statement.Table != "media" || tx.Error != nil {
			return
		}
		values, ok := tx.Statement.Dest.(map[string]any)
		if !ok {
			return
		}
		if expiry, exists := values["expires_at"]; exists {
			pointer, typed := expiry.(*time.Time)
			if expiry == nil || (typed && pointer == nil) {
				close(restored)
				<-release
			}
		}
	}); err != nil {
		t.Fatal(err)
	}
	if err := database.Callback().Query().Before("gorm:query").Register(queryName, func(tx *gorm.DB) {
		if cleanupMediaLockQuery(tx) {
			// Only observe the cleanup query after the writer reaches its barrier.
			select {
			case <-restored:
				sendCleanupBackendPID(tx, pids)
			default:
			}
		}
	}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { database.Callback().Update().Remove(updateName); database.Callback().Query().Remove(queryName) })
	saved := make(chan error, 1)
	go func() {
		_, accepted, err := UpdateCanvasProject("owner", "project", 1, "", []byte(`{"nodes":[{"type":"image","metadata":{"mediaId":"image"}}]}`), "")
		if err == nil && !accepted {
			err = errors.New("restore not accepted")
		}
		saved <- err
	}()
	awaitCleanupSignal(t, restored)
	cleanup := cleanupClaimAsync(current)
	awaitCleanupLockWait(t, database, pids)
	unblock()
	select {
	case err := <-saved:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("restore did not finish")
	}
	result := awaitCleanupClaim(t, cleanup)
	if result.err != nil || result.claimed {
		t.Fatalf("restored reference claimed: %#v", result)
	}
	item, found, err := GetMedia("image")
	if err != nil || !found || item.ExpiresAt != nil || item.CleanupStatus != model.MediaCleanupActive {
		t.Fatalf("restored media: %#v %v", item, err)
	}
}

func TestCanvasCleanupRechecksExpiryAfterCandidateSnapshot(t *testing.T) {
	_, current := seedCleanupProtocolMedia(t, "cleanup_snapshot")
	candidates, err := ListExpiredPrivateMedia(current)
	if err != nil || len(candidates) != 1 {
		t.Fatalf("candidates: %#v %v", candidates, err)
	}
	if updated, err := SetPrivateMediaExpiry("image", "owner", nil); err != nil || !updated {
		t.Fatalf("clear expiry: %v %v", updated, err)
	}
	if _, claimed, err := ClaimCanvasMediaCleanup(candidates[0].ID, current, time.Minute); err != nil || claimed {
		t.Fatalf("stale candidate claimed: %v %v", claimed, err)
	}
}

func TestCanvasCleanupClaimRejectsAllNewCanvasReferences(t *testing.T) {
	_, current := seedCleanupProtocolMedia(t, "cleanup_claim_writes")
	if _, _, err := CreateCanvasProject(model.CanvasProject{ID: "existing", OwnerUID: "owner", Document: model.CanvasProjectDocument(`{}`), Revision: 1}); err != nil {
		t.Fatal(err)
	}
	if _, claimed, err := ClaimCanvasMediaCleanup("image", current, time.Minute); err != nil || !claimed {
		t.Fatalf("claim: %v %v", claimed, err)
	}
	doc := model.CanvasProjectDocument(`{"nodes":[{"type":"image","metadata":{"mediaId":"image"}}]}`)
	writes := []struct {
		name string
		run  func() error
	}{
		{"create", func() error {
			_, _, err := CreateCanvasProject(model.CanvasProject{ID: "create", OwnerUID: "owner", Document: doc, Revision: 1})
			return err
		}},
		{"import", func() error {
			_, err := ImportCanvasProjects([]model.CanvasProject{{ID: "import", OwnerUID: "owner", Document: doc, Revision: 1}})
			return err
		}},
		{"update", func() error { _, _, err := UpdateCanvasProject("owner", "existing", 1, "", doc, ""); return err }},
		{"idempotent", func() error {
			_, _, _, err := UpdateCanvasProjectIdempotently("owner", "existing", 1, "", doc, "", "request", "hash")
			return err
		}},
	}
	for _, write := range writes {
		t.Run(write.name, func(t *testing.T) {
			if err := write.run(); !errors.Is(err, ErrCanvasMediaUnavailable) {
				t.Fatalf("write error = %v", err)
			}
		})
	}
	item, _, err := GetMedia("image")
	if err != nil || item.CleanupStatus != model.MediaCleanupDeleting {
		t.Fatalf("claim was restored: %#v %v", item, err)
	}
}

func TestCanvasCleanupLeaseTakeoverFencesOldDelete(t *testing.T) {
	_, current := seedCleanupProtocolMedia(t, "cleanup_lease_takeover")
	current = current.Truncate(time.Second).Add(123456789 * time.Nanosecond)
	first, claimed, err := ClaimCanvasMediaCleanup("image", current, time.Minute)
	if err != nil || !claimed {
		t.Fatalf("first claim: %v %v", claimed, err)
	}
	// Compare stored values: the initial claim returns Go's nanosecond timestamp,
	// while PostgreSQL preserves only microseconds when a worker reads it back.
	persisted, found, err := GetMedia("image")
	if err != nil || !found || persisted.CleanupStartedAt == nil || !persisted.CleanupStartedAt.Equal(current.Truncate(time.Microsecond)) {
		t.Fatalf("persisted first claim: %#v, found %v, err %v", persisted, found, err)
	}
	next, claimed, err := ClaimCanvasMediaCleanup("image", current.Add(time.Minute), time.Minute)
	if err != nil || !claimed || next.CleanupClaimID == first.CleanupClaimID || next.CleanupClaimID == "" {
		t.Fatalf("takeover: %#v %v %v", next, claimed, err)
	}
	if next.CleanupStartedAt == nil || !persisted.CleanupStartedAt.Equal(*next.CleanupStartedAt) {
		t.Fatalf("takeover changed deletion timestamp: before %v, after %v", persisted.CleanupStartedAt, next.CleanupStartedAt)
	}
	if deleted, err := DeleteClaimedCanvasMedia("image", first.CleanupClaimID); err != nil || deleted {
		t.Fatalf("stale delete: %v %v", deleted, err)
	}
	if updated, err := SetPrivateMediaExpiry("image", "owner", nil); err != nil || updated {
		t.Fatalf("deleting media restored: %v %v", updated, err)
	}
	if deleted, err := DeleteClaimedCanvasMedia("image", next.CleanupClaimID); err != nil || !deleted {
		t.Fatalf("current delete: %v %v", deleted, err)
	}
}

func TestCanvasCleanupMalformedDocumentBlocksClaim(t *testing.T) {
	database, current := seedCleanupProtocolMedia(t, "cleanup_corrupt_document")
	if err := database.Create(&model.CanvasProject{ID: "corrupt", OwnerUID: "owner", Document: model.CanvasProjectDocument(`{"nodes":123}`), Revision: 1}).Error; err != nil {
		t.Fatal(err)
	}
	if _, claimed, err := ClaimCanvasMediaCleanup("image", current, time.Minute); !errors.Is(err, ErrCanvasMediaInvalidDocument) || claimed {
		t.Fatalf("corrupt document claim: %v %v", claimed, err)
	}
	item, _, err := GetMedia("image")
	if err != nil || item.CleanupStatus != model.MediaCleanupActive || item.CleanupClaimID != "" {
		t.Fatalf("failed claim changed state: %#v %v", item, err)
	}
}
