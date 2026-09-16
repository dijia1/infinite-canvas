package service

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/repository"
	"github.com/google/uuid"
	"gorm.io/gorm"
)

type publicFolderRaceResult struct {
	err error
}

const publicFolderRaceTimeout = 15 * time.Second

func publicFolderLockQuery(tx *gorm.DB) bool {
	_, folder := tx.Statement.Dest.(*model.PublicFolder)
	_, locking := tx.Statement.Clauses["FOR"]
	return folder && locking
}

func publicFolderBackendPID(tx *gorm.DB) (int, error) {
	var pid int
	err := tx.Statement.ConnPool.QueryRowContext(context.Background(), "SELECT pg_backend_pid()").Scan(&pid)
	return pid, err
}

func awaitPublicFolderRacePID(t *testing.T, pids <-chan int, label string) int {
	t.Helper()
	select {
	case pid := <-pids:
		return pid
	case <-time.After(publicFolderRaceTimeout):
		t.Fatalf("timed out waiting for %s PostgreSQL connection", label)
		return 0
	}
}

func awaitPublicFolderLockWait(t *testing.T, database *gorm.DB, pid int) {
	t.Helper()
	deadline := time.NewTimer(publicFolderRaceTimeout)
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

func awaitPublicFolderRaceResult(t *testing.T, results <-chan publicFolderRaceResult, label string) publicFolderRaceResult {
	t.Helper()
	select {
	case result := <-results:
		return result
	case <-time.After(publicFolderRaceTimeout):
		t.Fatalf("timed out waiting for %s", label)
		return publicFolderRaceResult{}
	}
}

func runPublicFolderRace(t *testing.T, first, second func() error) (publicFolderRaceResult, publicFolderRaceResult) {
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
	beforeName := "test_public_folder_race_before_" + callbackSuffix
	afterName := "test_public_folder_race_after_" + callbackSuffix
	if err := database.Callback().Query().Before("gorm:query").Register(beforeName, func(tx *gorm.DB) {
		if !publicFolderLockQuery(tx) {
			return
		}
		index := queries.Add(1)
		tx.InstanceSet("public_folder_race_query_index", index)
		if index == 2 {
			pid, err := publicFolderBackendPID(tx)
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
		index, ok := tx.InstanceGet("public_folder_race_query_index")
		if !ok || index.(int32) != 1 || tx.Error != nil {
			return
		}
		pid, err := publicFolderBackendPID(tx)
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

	firstDone := make(chan publicFolderRaceResult, 1)
	go func() { firstDone <- publicFolderRaceResult{err: first()} }()
	firstPID := awaitPublicFolderRacePID(t, firstLocked, "first")
	secondDone := make(chan publicFolderRaceResult, 1)
	go func() { secondDone <- publicFolderRaceResult{err: second()} }()
	secondPID := awaitPublicFolderRacePID(t, secondStarted, "second")
	if firstPID == secondPID {
		t.Fatalf("race used one PostgreSQL connection: pid=%d", firstPID)
	}
	awaitPublicFolderLockWait(t, database, secondPID)
	unblock()
	return awaitPublicFolderRaceResult(t, firstDone, "first operation"), awaitPublicFolderRaceResult(t, secondDone, "second operation")
}

func TestPublicFolderRepositoryRejectsMissingTarget(t *testing.T) {
	_, err := repository.SavePublicFolder(model.PublicFolder{ID: newID("child"), ParentID: "deleted-parent", Title: "child"})
	if err == nil {
		t.Fatal("created a child with a missing parent")
	}
}

func TestPublicFolderConcurrentDeleteAndWrites(t *testing.T) {
	for _, operation := range []string{"child", "upload", "move"} {
		for _, deleteFirst := range []bool{true, false} {
			t.Run(fmt.Sprintf("%s/deleteFirst=%t", operation, deleteFirst), func(t *testing.T) {
				scope := uuid.NewString()
				parent, err := repository.SavePublicFolder(model.PublicFolder{ID: scope, Title: scope, CreatedAt: now()})
				if err != nil {
					t.Fatal(err)
				}
				owner := PortalUser{UID: "public-race-" + scope}
				var moving model.PublicImage
				if operation == "move" {
					moving, _, err = SavePublicImage(context.Background(), owner, "image.png", "image/png", tinyPNG, "image", "")
					if err != nil {
						t.Fatal(err)
					}
				}
				write := func() error {
					switch operation {
					case "child":
						_, err := CreatePublicFolder("child", parent.ID)
						return err
					case "upload":
						_, _, err := SavePublicImage(context.Background(), owner, "image.png", "image/png", tinyPNG, "image", parent.ID)
						return err
					default:
						_, err := UpdatePublicImage(moving.ID, nil, &parent.ID)
						return err
					}
				}
				remove := func() error { return DeletePublicFolder(parent.ID) }
				first, second := write, remove
				if deleteFirst {
					first, second = remove, write
				}
				a, b := runPublicFolderRace(t, first, second)
				if a.err != nil || b.err == nil {
					t.Fatalf("first=%v second=%v", a.err, b.err)
				}
				db, _ := repository.DB()
				var orphans int64
				if err := db.Raw(`SELECT (SELECT COUNT(*) FROM public_folders c LEFT JOIN public_folders p ON p.id=c.parent_id WHERE c.parent_id <> '' AND p.id IS NULL) + (SELECT COUNT(*) FROM public_images i LEFT JOIN public_folders p ON p.id=i.folder_id WHERE i.folder_id <> '' AND p.id IS NULL)`).Scan(&orphans).Error; err != nil || orphans != 0 {
					t.Fatalf("orphan count %d: %v", orphans, err)
				}
				if operation == "upload" && deleteFirst {
					var leaked int64
					if err := db.Model(&model.Media{}).Where("owner_uid = ? AND cleanup_status = ? AND expires_at IS NULL", owner.UID, model.MediaCleanupActive).Count(&leaked).Error; err != nil || leaked != 0 {
						t.Fatalf("failed upload left permanent media: %d %v", leaked, err)
					}
				}
			})
		}
	}
}
