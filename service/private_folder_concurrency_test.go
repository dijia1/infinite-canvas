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

type privateFolderRaceResult struct {
	err error
}

const privateFolderRaceTimeout = 15 * time.Second

func privateFolderLockQuery(tx *gorm.DB) bool {
	_, folder := tx.Statement.Dest.(*model.PrivateFolder)
	_, locking := tx.Statement.Clauses["FOR"]
	return folder && locking
}

func privateFolderBackendPID(tx *gorm.DB) (int, error) {
	var pid int
	err := tx.Statement.ConnPool.QueryRowContext(context.Background(), "SELECT pg_backend_pid()").Scan(&pid)
	return pid, err
}

func awaitPrivateFolderRacePID(t *testing.T, pids <-chan int, label string) int {
	t.Helper()
	select {
	case pid := <-pids:
		return pid
	case <-time.After(privateFolderRaceTimeout):
		t.Fatalf("timed out waiting for %s PostgreSQL connection", label)
		return 0
	}
}

func awaitPrivateFolderLockWait(t *testing.T, database *gorm.DB, pid int) {
	t.Helper()
	deadline := time.NewTimer(privateFolderRaceTimeout)
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

func awaitPrivateFolderRaceResult(t *testing.T, results <-chan privateFolderRaceResult, label string) privateFolderRaceResult {
	t.Helper()
	select {
	case result := <-results:
		return result
	case <-time.After(privateFolderRaceTimeout):
		t.Fatalf("timed out waiting for %s", label)
		return privateFolderRaceResult{}
	}
}

func runPrivateFolderRace(t *testing.T, first, second func() error) (privateFolderRaceResult, privateFolderRaceResult) {
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
	beforeName := "test_private_folder_race_before_" + callbackSuffix
	afterName := "test_private_folder_race_after_" + callbackSuffix
	if err := database.Callback().Query().Before("gorm:query").Register(beforeName, func(tx *gorm.DB) {
		if !privateFolderLockQuery(tx) {
			return
		}
		index := queries.Add(1)
		tx.InstanceSet("private_folder_race_query_index", index)
		if index == 2 {
			pid, err := privateFolderBackendPID(tx)
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
		index, ok := tx.InstanceGet("private_folder_race_query_index")
		if !ok || index.(int32) != 1 || tx.Error != nil {
			return
		}
		pid, err := privateFolderBackendPID(tx)
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

	firstDone := make(chan privateFolderRaceResult, 1)
	go func() { firstDone <- privateFolderRaceResult{err: first()} }()
	firstPID := awaitPrivateFolderRacePID(t, firstLocked, "first")
	secondDone := make(chan privateFolderRaceResult, 1)
	go func() { secondDone <- privateFolderRaceResult{err: second()} }()
	secondPID := awaitPrivateFolderRacePID(t, secondStarted, "second")
	if firstPID == secondPID {
		t.Fatalf("race used one PostgreSQL connection: pid=%d", firstPID)
	}
	awaitPrivateFolderLockWait(t, database, secondPID)
	unblock()
	return awaitPrivateFolderRaceResult(t, firstDone, "first operation"), awaitPrivateFolderRaceResult(t, secondDone, "second operation")
}

func assertNoPrivateFolderOrphans(t *testing.T, ownerUID string) {
	t.Helper()
	database, err := repository.DB()
	if err != nil {
		t.Fatal(err)
	}
	var childOrphans int64
	if err := database.Raw(`SELECT COUNT(*)
		FROM private_folders child
		LEFT JOIN private_folders parent ON parent.id = child.parent_id AND parent.owner_uid = child.owner_uid
		WHERE child.owner_uid = ? AND child.parent_id <> '' AND parent.id IS NULL`, ownerUID).Scan(&childOrphans).Error; err != nil {
		t.Fatal(err)
	}
	var mediaOrphans int64
	if err := database.Raw(`SELECT COUNT(*)
		FROM media item
		LEFT JOIN private_folders folder ON folder.id = item.folder_id AND folder.owner_uid = item.owner_uid
		WHERE item.owner_uid = ? AND item.folder_id <> '' AND folder.id IS NULL`, ownerUID).Scan(&mediaOrphans).Error; err != nil {
		t.Fatal(err)
	}
	if childOrphans != 0 || mediaOrphans != 0 {
		t.Fatalf("private folder orphans: children=%d media=%d", childOrphans, mediaOrphans)
	}
}

func savePrivateFolderRaceParent(t *testing.T, ownerUID, id string) model.PrivateFolder {
	t.Helper()
	item := model.PrivateFolder{ID: id, OwnerUID: ownerUID, Title: id, CreatedAt: time.Now().UTC().Format(time.RFC3339Nano)}
	saved, err := repository.SavePrivateFolder(item)
	if err != nil {
		t.Fatal(err)
	}
	return saved
}

func TestPrivateFolderChildCreationMakesConcurrentDeleteRefuse(t *testing.T) {
	scope := uuid.NewString()
	owner := "private-folder-child-wins-owner-" + scope
	parent := savePrivateFolderRaceParent(t, owner, "private-folder-child-wins-parent-"+scope)
	user := PortalUser{UID: owner}
	var child model.PrivateFolder
	create, remove := runPrivateFolderRace(t,
		func() error {
			var err error
			child, err = CreatePrivateFolder(context.Background(), user, "child", parent.ID)
			return err
		},
		func() error { return DeletePrivateFolder(context.Background(), user, parent.ID) },
	)
	if create.err != nil {
		t.Fatalf("create child: %v", create.err)
	}
	if got := fmt.Sprint(remove.err); got != "文件夹包含图片或子文件夹，请先整理内容" {
		t.Fatalf("delete error = %q", got)
	}
	if _, found, err := repository.GetPrivateFolder(owner, parent.ID); err != nil || !found {
		t.Fatalf("parent after rejected delete: found=%t err=%v", found, err)
	}
	if _, found, err := repository.GetPrivateFolder(owner, child.ID); err != nil || !found {
		t.Fatalf("child after create: found=%t err=%v", found, err)
	}
	assertNoPrivateFolderOrphans(t, owner)
}

func TestPrivateFolderDeleteMakesConcurrentChildCreationFail(t *testing.T) {
	scope := uuid.NewString()
	owner := "private-folder-delete-before-child-owner-" + scope
	parent := savePrivateFolderRaceParent(t, owner, "private-folder-delete-before-child-parent-"+scope)
	user := PortalUser{UID: owner}
	remove, create := runPrivateFolderRace(t,
		func() error { return DeletePrivateFolder(context.Background(), user, parent.ID) },
		func() error {
			_, err := CreatePrivateFolder(context.Background(), user, "child", parent.ID)
			return err
		},
	)
	if remove.err != nil {
		t.Fatalf("delete parent: %v", remove.err)
	}
	if got := fmt.Sprint(create.err); got != "父文件夹不存在" {
		t.Fatalf("create error = %q", got)
	}
	if _, found, err := repository.GetPrivateFolder(owner, parent.ID); err != nil || found {
		t.Fatalf("parent after delete: found=%t err=%v", found, err)
	}
	assertNoPrivateFolderOrphans(t, owner)
}

func TestPrivateMediaMoveMakesConcurrentFolderDeleteRefuse(t *testing.T) {
	scope := uuid.NewString()
	owner := "private-folder-move-wins-owner-" + scope
	folder := savePrivateFolderRaceParent(t, owner, "private-folder-move-wins-folder-"+scope)
	media, err := repository.SaveMedia(model.Media{ID: "private-folder-move-wins-media-" + scope, OwnerUID: owner, ObjectKey: "private-folder/move-wins/" + scope, ContentType: "image/png"})
	if err != nil {
		t.Fatal(err)
	}
	user := PortalUser{UID: owner}
	destination := folder.ID
	move, remove := runPrivateFolderRace(t,
		func() error {
			_, err := UpdatePrivateImage(context.Background(), user, media.ID, nil, &destination)
			return err
		},
		func() error { return DeletePrivateFolder(context.Background(), user, folder.ID) },
	)
	if move.err != nil {
		t.Fatalf("move media: %v", move.err)
	}
	if got := fmt.Sprint(remove.err); got != "文件夹包含图片或子文件夹，请先整理内容" {
		t.Fatalf("delete error = %q", got)
	}
	stored, found, err := repository.GetMedia(media.ID)
	if err != nil || !found || stored.FolderID != folder.ID {
		t.Fatalf("media after move: found=%t folder=%q err=%v", found, stored.FolderID, err)
	}
	assertNoPrivateFolderOrphans(t, owner)
}

func TestPrivateFolderDeleteMakesConcurrentMediaMoveFail(t *testing.T) {
	scope := uuid.NewString()
	owner := "private-folder-delete-before-move-owner-" + scope
	folder := savePrivateFolderRaceParent(t, owner, "private-folder-delete-before-move-folder-"+scope)
	media, err := repository.SaveMedia(model.Media{ID: "private-folder-delete-before-move-media-" + scope, OwnerUID: owner, ObjectKey: "private-folder/delete-before-move/" + scope, ContentType: "image/png"})
	if err != nil {
		t.Fatal(err)
	}
	user := PortalUser{UID: owner}
	destination := folder.ID
	remove, move := runPrivateFolderRace(t,
		func() error { return DeletePrivateFolder(context.Background(), user, folder.ID) },
		func() error {
			_, err := UpdatePrivateImage(context.Background(), user, media.ID, nil, &destination)
			return err
		},
	)
	if remove.err != nil {
		t.Fatalf("delete folder: %v", remove.err)
	}
	if got := fmt.Sprint(move.err); got != "文件夹不存在" {
		t.Fatalf("move error = %q", got)
	}
	stored, found, err := repository.GetMedia(media.ID)
	if err != nil || !found || stored.FolderID != "" {
		t.Fatalf("media after rejected move: found=%t folder=%q err=%v", found, stored.FolderID, err)
	}
	assertNoPrivateFolderOrphans(t, owner)
}

func TestPrivateFolderMembershipKeepsOwnerScope(t *testing.T) {
	scope := uuid.NewString()
	owner := "private-folder-owner-scope-owner-" + scope
	otherOwner := "private-folder-owner-scope-other-" + scope
	folder := savePrivateFolderRaceParent(t, otherOwner, "private-folder-owner-scope-folder-"+scope)
	media, err := repository.SaveMedia(model.Media{ID: "private-folder-owner-scope-media-" + scope, OwnerUID: owner, ObjectKey: "private-folder/owner-scope/" + scope, ContentType: "image/png"})
	if err != nil {
		t.Fatal(err)
	}
	user := PortalUser{UID: owner}
	if _, err := CreatePrivateFolder(context.Background(), user, "child", folder.ID); fmt.Sprint(err) != "父文件夹不存在" {
		t.Fatalf("cross-owner child create error = %q", fmt.Sprint(err))
	}
	destination := folder.ID
	if _, err := UpdatePrivateImage(context.Background(), user, media.ID, nil, &destination); fmt.Sprint(err) != "文件夹不存在" {
		t.Fatalf("cross-owner media move error = %q", fmt.Sprint(err))
	}
	if err := DeletePrivateFolder(context.Background(), user, folder.ID); fmt.Sprint(err) != "文件夹不存在" {
		t.Fatalf("cross-owner folder delete error = %q", fmt.Sprint(err))
	}
	if _, found, err := repository.GetPrivateFolder(otherOwner, folder.ID); err != nil || !found {
		t.Fatalf("other owner's folder changed: found=%t err=%v", found, err)
	}
	stored, found, err := repository.GetMedia(media.ID)
	if err != nil || !found || stored.FolderID != "" {
		t.Fatalf("media after rejected cross-owner move: found=%t folder=%q err=%v", found, stored.FolderID, err)
	}
}

func TestPrivateFolderMembershipKeepsEmptyRootSemantics(t *testing.T) {
	scope := uuid.NewString()
	owner := "private-folder-root-semantics-owner-" + scope
	user := PortalUser{UID: owner}
	folder, err := CreatePrivateFolder(context.Background(), user, "root folder", "  ")
	if err != nil || folder.ParentID != "" {
		t.Fatalf("root folder: parent=%q err=%v", folder.ParentID, err)
	}
	media, err := repository.SaveMedia(model.Media{ID: "private-folder-root-semantics-media-" + scope, OwnerUID: owner, ObjectKey: "private-folder/root-semantics/" + scope, ContentType: "image/png", FolderID: folder.ID})
	if err != nil {
		t.Fatal(err)
	}
	root := "  "
	updated, err := UpdatePrivateImage(context.Background(), user, media.ID, nil, &root)
	if err != nil || updated.FolderID != "" {
		t.Fatalf("move to root: folder=%q err=%v", updated.FolderID, err)
	}
}
