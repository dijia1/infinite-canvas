package service

import (
	"context"
	"sync/atomic"
	"testing"
	"time"
)

func TestPeriodicStopWaitsForCurrentExecutionAndIsRepeatable(t *testing.T) {
	workerShutdown.Store(false)
	t.Cleanup(func() { workerShutdown.Store(false) })
	started, release := make(chan struct{}), make(chan struct{})
	var calls atomic.Int32
	stop := startPeriodicWorker(context.Background(), time.Millisecond, "fixture", func(ctx context.Context, _ time.Time) error {
		if calls.Add(1) == 1 {
			close(started)
		}
		<-release
		if ctx.Err() != nil {
			t.Error("graceful stop cancelled current execution")
		}
		return nil
	})
	<-started
	BeginWorkerShutdown()
	done := make(chan struct{})
	go func() { stop(); stop(); close(done) }()
	select {
	case <-done:
		t.Fatal("stop did not wait")
	case <-time.After(30 * time.Millisecond):
	}
	close(release)
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("worker did not stop")
	}
	if calls.Load() != 1 {
		t.Fatal("worker admitted another pass")
	}
}

func TestPeriodicHardCancellationReachesActiveWork(t *testing.T) {
	workerShutdown.Store(false)
	parent, cancel := context.WithCancel(context.Background())
	started := make(chan struct{})
	stop := startPeriodicWorker(parent, time.Hour, "fixture", func(ctx context.Context, _ time.Time) error { close(started); <-ctx.Done(); return nil })
	<-started
	cancel()
	done := make(chan struct{})
	go func() { stop(); close(done) }()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("hard cancellation did not reach work")
	}
}
