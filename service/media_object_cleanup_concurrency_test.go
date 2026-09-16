package service

import (
	"context"

	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/repository"

	"gorm.io/gorm"
)

type mediaIntentRaceResult struct {
	err error
}

const mediaIntentRaceTimeout = 15 * time.Second

func mediaIntentLockQuery(tx *gorm.DB) bool {
	_, folder := tx.Statement.Dest.(*model.MediaUploadIntent)
	_, locking := tx.Statement.Clauses["FOR"]
	return folder && locking
}

func mediaIntentBackendPID(tx *gorm.DB) (int, error) {
	var pid int
	err := tx.Statement.ConnPool.QueryRowContext(context.Background(), "SELECT pg_backend_pid()").Scan(&pid)
	return pid, err
}

func awaitMediaUploadIntentRacePID(t *testing.T, pids <-chan int, label string) int {
	t.Helper()
	select {
	case pid := <-pids:
		return pid
	case <-time.After(mediaIntentRaceTimeout):
		t.Fatalf("timed out waiting for %s PostgreSQL connection", label)
		return 0
	}
}

func awaitMediaUploadIntentLockWait(t *testing.T, database *gorm.DB, pid int) {
	t.Helper()
	deadline := time.NewTimer(mediaIntentRaceTimeout)
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
			t.Fatal("second PostgreSQL connection never entered a lock wait")
		case <-ticker.C:
		}
	}
}

func awaitMediaUploadIntentRaceResult(t *testing.T, results <-chan mediaIntentRaceResult, label string) mediaIntentRaceResult {
	t.Helper()
	select {
	case result := <-results:
		return result
	case <-time.After(mediaIntentRaceTimeout):
		t.Fatalf("timed out waiting for %s", label)
		return mediaIntentRaceResult{}
	}
}

func runMediaUploadIntentRace(t *testing.T, first, second func() error) (mediaIntentRaceResult, mediaIntentRaceResult) {
	t.Helper()
	database, err := repository.DB()
	if err != nil {
		t.Fatal(err)
	}
	firstLocked := make(chan int, 1)
	secondStarted := make(chan int, 1)
	release := make(chan struct{})
	var releaseOnce sync.Once
	unblock := func() { releaseOnce.Do(func() { close(release) }) }
	defer unblock()
	var queries atomic.Int32
	callbackSuffix := strings.NewReplacer("/", "_", " ", "_").Replace(t.Name())
	beforeName := "test_media_intent_race_before_" + callbackSuffix
	afterName := "test_media_intent_race_after_" + callbackSuffix
	if err := database.Callback().Query().Before("gorm:query").Register(beforeName, func(tx *gorm.DB) {
		if !mediaIntentLockQuery(tx) {
			return
		}
		index := queries.Add(1)
		tx.InstanceSet("media_intent_race_query_index", index)
		if index == 2 {
			pid, err := mediaIntentBackendPID(tx)
			if err != nil {
				tx.AddError(err)
				return
			}
			secondStarted <- pid
		}
	}); err != nil {
		t.Fatal(err)
	}
	if err := database.Callback().Query().After("gorm:query").Register(afterName, func(tx *gorm.DB) {
		index, ok := tx.InstanceGet("media_intent_race_query_index")
		if !ok || index.(int32) != 1 || tx.Error != nil {
			return
		}
		pid, err := mediaIntentBackendPID(tx)
		if err != nil {
			tx.AddError(err)
			return
		}
		firstLocked <- pid
		<-release
	}); err != nil {
		database.Callback().Query().Remove(beforeName)
		t.Fatal(err)
	}
	t.Cleanup(func() {
		database.Callback().Query().Remove(beforeName)
		database.Callback().Query().Remove(afterName)
	})

	firstDone := make(chan mediaIntentRaceResult, 1)
	go func() { firstDone <- mediaIntentRaceResult{err: first()} }()
	firstPID := awaitMediaUploadIntentRacePID(t, firstLocked, "first")
	secondDone := make(chan mediaIntentRaceResult, 1)
	go func() { secondDone <- mediaIntentRaceResult{err: second()} }()
	secondPID := awaitMediaUploadIntentRacePID(t, secondStarted, "second")
	if firstPID == secondPID {
		t.Fatalf("race used one PostgreSQL connection: pid=%d", firstPID)
	}
	awaitMediaUploadIntentLockWait(t, database, secondPID)
	unblock()
	return awaitMediaUploadIntentRaceResult(t, firstDone, "first operation"), awaitMediaUploadIntentRaceResult(t, secondDone, "second operation")
}

func TestMediaReservationPublicationAndCleanupInterleave(t *testing.T) {
	for _, cleanupFirst := range []bool{false, true} {
		t.Run(map[bool]string{false: "publication-first", true: "cleanup-first"}[cleanupFirst], func(t *testing.T) {
			current := time.Now().UTC()
			owner := newID("owner")
			key := newID("key")
			intent := model.MediaUploadIntent{ID: newID("intent"), OwnerUID: owner, ObjectKey: key, Intent: repository.InternalMediaUploadIntent, ExpiresAt: current.Add(-time.Hour).Format(time.RFC3339Nano)}
			if err := repository.SaveMediaUploadIntent(intent); err != nil {
				t.Fatal(err)
			}
			item := model.Media{ID: newID("media"), OwnerUID: owner, ObjectKey: key}
			publish := func() error { _, err := repository.SaveMedia(item); return err }
			var keys []string
			cleanup := func() error {
				_, claimed, _, err := repository.ClaimMediaUploadCleanup(context.Background(), intent.ID, current)
				keys = claimed
				return err
			}
			first, second := publish, cleanup
			if cleanupFirst {
				first, second = cleanup, publish
			}
			a, b := runMediaUploadIntentRace(t, first, second)
			if a.err != nil {
				t.Fatal(a.err)
			}
			if cleanupFirst {
				if b.err == nil || len(keys) != 1 {
					t.Fatalf("publication after cleanup: %v keys=%v", b.err, keys)
				}
			} else {
				if b.err != nil || len(keys) != 0 {
					t.Fatalf("cleanup selected published media: %v keys=%v", b.err, keys)
				}
			}
		})
	}
}
