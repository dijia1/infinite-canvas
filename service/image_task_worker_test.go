package service

import (
	"context"
	"testing"
	"time"

	"github.com/basketikun/infinite-canvas/ai"
)

func TestImageTaskWorkerConcurrencyDefaultsAndRejectsInvalidValues(t *testing.T) {
	if value, err := parseImageTaskWorkerConcurrency(0); err != nil || value != 4 {
		t.Fatalf("parseImageTaskWorkerConcurrency(0) = %d, %v", value, err)
	}
	if value, err := parseImageTaskWorkerConcurrency(7); err != nil || value != 7 {
		t.Fatalf("parseImageTaskWorkerConcurrency(7) = %d, %v", value, err)
	}
	if _, err := parseImageTaskWorkerConcurrency(-1); err == nil {
		t.Fatal("negative worker concurrency must be rejected")
	}
}

func TestMaintainImageTaskLeaseRenewsUntilTheTaskContextEnds(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	renewed := make(chan struct{}, 1)
	done := make(chan struct{})
	go func() {
		defer close(done)
		maintainImageTaskLease(ctx, time.Millisecond, func() (bool, error) {
			select {
			case renewed <- struct{}{}:
			default:
			}
			return true, nil
		})
	}()

	select {
	case <-renewed:
	case <-time.After(100 * time.Millisecond):
		t.Fatal("lease was not renewed while the task was active")
	}

	cancel()
	select {
	case <-done:
	case <-time.After(100 * time.Millisecond):
		t.Fatal("lease heartbeat did not stop when the task context ended")
	}
}

func TestImageTaskTerminalResultHandlesDirectURLsAndProviderFailures(t *testing.T) {
	urls, failure, terminal := imageTaskTerminalResult(ai.ImageTask{Status: "completed", ResultURLs: []string{"https://cdn.example.com/result.png"}})
	if !terminal || failure != nil || len(urls) != 1 {
		t.Fatalf("completed direct result = %#v, %v, %t", urls, failure, terminal)
	}

	for _, status := range []string{"failed", "violated", "rejected"} {
		urls, failure, terminal = imageTaskTerminalResult(ai.ImageTask{Status: status, Error: "上游拒绝"})
		if !terminal || failure == nil || len(urls) != 0 {
			t.Errorf("%s result = %#v, %v, %t", status, urls, failure, terminal)
		}
	}

	urls, failure, terminal = imageTaskTerminalResult(ai.ImageTask{Status: "processing"})
	if terminal || failure != nil || len(urls) != 0 {
		t.Fatalf("processing result = %#v, %v, %t", urls, failure, terminal)
	}
}
