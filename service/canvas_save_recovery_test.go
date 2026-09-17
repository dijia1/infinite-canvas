package service

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
	"time"

	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/repository"
	"github.com/google/uuid"
	"gorm.io/gorm"
)

func TestCanvasSaveReplayBetweenReceiptMissAndVersionRead(t *testing.T) {
	owner, id := "save-race-owner", "save-race-project"
	saveTestCanvasProject(t, id, owner, testValidCanvasDocument())
	input := CanvasProjectUpdateInput{Title: "A", Revision: 1, Document: testValidCanvasDocument()}
	requestID := uuid.NewString()
	db, _ := repository.DB()
	missed, release := make(chan struct{}), make(chan struct{})
	var count atomic.Int32
	const hook = "test:canvas_receipt_miss"
	if err := db.Callback().Query().After("gorm:query").Register(hook, func(tx *gorm.DB) {
		if tx.Statement.Table == "canvas_save_requests" && tx.RowsAffected == 0 && tx.Error == nil && count.Add(1) == 1 {
			close(missed)
			<-release
		}
	}); err != nil {
		t.Fatal(err)
	}
	defer db.Callback().Query().Remove(hook)
	type result struct {
		item  model.CanvasProject
		dedup bool
		err   error
	}
	done := make(chan result, 1)
	go func() {
		item, dedup, err := UpdateCanvasProject(context.Background(), PortalUser{UID: owner}, id, input, requestID)
		done <- result{item, dedup, err}
	}()
	select {
	case <-missed:
	case <-time.After(5 * time.Second):
		t.Fatal("replay did not reach receipt barrier")
	}
	item, dedup, err := UpdateCanvasProject(context.Background(), PortalUser{UID: owner}, id, input, requestID)
	close(release)
	if err != nil || dedup || item.Revision != 2 {
		t.Fatalf("original: %+v %v %v", item, dedup, err)
	}
	select {
	case replay := <-done:
		if replay.err != nil || !replay.dedup || replay.item.Revision != 2 {
			t.Fatalf("replay after receipt miss: %+v", replay)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("replay stuck")
	}
	stored, _, _ := repository.GetCanvasProject(owner, id)
	if stored.Revision != 2 {
		t.Fatalf("duplicate write: revision %d", stored.Revision)
	}
}

func TestCanvasSaveOldReceiptNeverAdvancesOrRevivesTheDocument(t *testing.T) {
	owner, id := "save-receipt-owner", "save-receipt-project"
	saveTestCanvasProject(t, id, owner, testValidCanvasDocument())
	input := CanvasProjectUpdateInput{Title: "A", Revision: 1, Document: testValidCanvasDocument()}
	requestID := uuid.NewString()
	if _, _, err := UpdateCanvasProject(context.Background(), PortalUser{UID: owner}, id, input, requestID); err != nil {
		t.Fatal(err)
	}
	newer := input
	newer.Title = "C"
	newer.Revision = 2
	if _, _, err := UpdateCanvasProject(context.Background(), PortalUser{UID: owner}, id, newer, uuid.NewString()); err != nil {
		t.Fatal(err)
	}
	receipt, replayed, err := UpdateCanvasProject(context.Background(), PortalUser{UID: owner}, id, input, requestID)
	if err != nil || !replayed || receipt.Revision != 2 {
		t.Fatalf("old receipt: %+v %v %v", receipt, replayed, err)
	}
	if _, _, err := UpdateCanvasProject(context.Background(), PortalUser{UID: owner}, id, newer, uuid.NewString()); !errors.Is(err, ErrCanvasProjectConflict) {
		t.Fatalf("must retain true conflict: %v", err)
	}
	if _, err := repository.DeleteCanvasProject(owner, id, 3); err != nil {
		t.Fatal(err)
	}
	if _, replayed, err := UpdateCanvasProject(context.Background(), PortalUser{UID: owner}, id, input, requestID); err != nil || !replayed {
		t.Fatalf("deleted receipt: %v %v", replayed, err)
	}
	if _, found, _ := repository.GetCanvasProject(owner, id); found {
		t.Fatal("receipt revived deleted project")
	}
}

func TestCanvasSaveConcurrentTransactionsShareOneReceipt(t *testing.T) {
	owner, id := "save-tx-owner", "save-tx-project"
	saveTestCanvasProject(t, id, owner, testValidCanvasDocument())
	requestID := uuid.NewString()
	input := CanvasProjectUpdateInput{Title: "A", Revision: 1, Document: testValidCanvasDocument()}
	db, _ := repository.DB()
	entered, release := make(chan int, 2), make(chan struct{})
	const hook = "test:canvas_two_save_transactions"
	if err := db.Callback().Create().Before("gorm:create").Register(hook, func(tx *gorm.DB) {
		if tx.Statement.Table != "canvas_save_requests" {
			return
		}
		var pid int
		if err := tx.Statement.ConnPool.QueryRowContext(context.Background(), "SELECT pg_backend_pid()").Scan(&pid); err != nil {
			tx.AddError(err)
			return
		}
		entered <- pid
		<-release
	}); err != nil {
		t.Fatal(err)
	}
	defer db.Callback().Create().Remove(hook)
	results := make(chan error, 2)
	for i := 0; i < 2; i++ {
		go func() {
			item, _, err := UpdateCanvasProject(context.Background(), PortalUser{UID: owner}, id, input, requestID)
			if err == nil && item.Revision != 2 {
				err = errors.New("wrong revision")
			}
			results <- err
		}()
	}
	pids := []int{}
	for i := 0; i < 2; i++ {
		select {
		case pid := <-entered:
			pids = append(pids, pid)
		case <-time.After(5 * time.Second):
			close(release)
			t.Fatal("both transactions did not reach the barrier")
		}
	}
	close(release)
	if pids[0] == pids[1] {
		t.Fatal("expected independent database connections")
	}
	for i := 0; i < 2; i++ {
		if err := <-results; err != nil {
			t.Fatal(err)
		}
	}
	stored, _, _ := repository.GetCanvasProject(owner, id)
	if stored.Revision != 2 {
		t.Fatalf("updated twice: %d", stored.Revision)
	}
}

func TestCanvasSaveRejectionIdentityAndExpiredReceipt(t *testing.T) {
	owner, id := "save-errors-owner", "save-errors-project"
	saveTestCanvasProject(t, id, owner, testValidCanvasDocument())
	valid := CanvasProjectUpdateInput{Title: "A", Revision: 1, Document: testValidCanvasDocument()}
	invalid := valid
	invalid.Document = testValidCanvasDocument("nonexistent-save-media")
	_, _, err := UpdateCanvasProject(context.Background(), PortalUser{UID: owner}, id, invalid, uuid.NewString())
	if CanvasSaveErrorCode(err) != "canvas_save_rejected" {
		t.Fatalf("media rejection: %v code=%s", err, CanvasSaveErrorCode(err))
	}
	stored, _, _ := repository.GetCanvasProject(owner, id)
	if stored.Revision != 1 {
		t.Fatal("rejected write advanced revision")
	}
	requestID := uuid.NewString()
	if _, _, err := UpdateCanvasProject(context.Background(), PortalUser{UID: owner}, id, valid, requestID); err != nil {
		t.Fatal(err)
	}
	for _, field := range []string{"owner", "project", "revision", "title", "document", "invalid_payload"} {
		t.Run(field, func(t *testing.T) {
			u, p, v := owner, id, valid
			switch field {
			case "owner":
				u = "other"
			case "project":
				p = "other"
			case "revision":
				v.Revision = 2
			case "title":
				v.Title = "different"
			case "invalid_payload":
				v.Title = ""
				v.Document = []byte("not JSON")
			case "document":
				v.Document = testValidCanvasDocument("other-media")
			}
			_, _, err := UpdateCanvasProject(context.Background(), PortalUser{UID: u}, p, v, requestID)
			if CanvasSaveErrorCode(err) != "canvas_save_request_mismatch" {
				t.Fatalf("mismatch: %v", err)
			}
		})
	}
	db, _ := repository.DB()
	if err := db.Where("request_id = ?", requestID).Delete(&model.CanvasSaveRequest{}).Error; err != nil {
		t.Fatal(err)
	}
	if _, _, err := UpdateCanvasProject(context.Background(), PortalUser{UID: owner}, id, valid, requestID); !errors.Is(err, ErrCanvasProjectConflict) {
		t.Fatalf("expired receipt must conflict: %v", err)
	}
}
