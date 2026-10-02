package service

import (
	"context"
	"log"
	"sync"
	"sync/atomic"
	"time"
)

// Admission stops independently of execution: claimed work keeps its context
// and lease heartbeat until completion or the process-wide hard deadline.
var workerShutdown atomic.Bool

func BeginWorkerShutdown()  { workerShutdown.Store(true) }
func workersStopping() bool { return workerShutdown.Load() }

func startPeriodicWorker(parent context.Context, interval time.Duration, name string, run func(context.Context, time.Time) error) func() {
	poll, cancel := context.WithCancel(parent)
	done := make(chan struct{})
	go func() {
		defer close(done)
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			if poll.Err() != nil || workersStopping() {
				return
			}
			if err := run(parent, time.Now()); err != nil {
				log.Printf("%s cleanup failed: %v", name, err)
			}
			select {
			case <-poll.Done():
				return
			case <-ticker.C:
			}
		}
	}()
	var once sync.Once
	return func() { once.Do(cancel); <-done }
}
