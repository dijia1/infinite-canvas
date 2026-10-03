package service

import (
	"context"
	"time"

	"github.com/basketikun/infinite-canvas/repository"
)

const canvasSaveRequestRetention = 7 * 24 * time.Hour

func CleanupExpiredCanvasSaveRequests(current time.Time) error {
	return repository.DeleteCanvasSaveRequestsBefore(current.UTC().Add(-canvasSaveRequestRetention).Format(time.RFC3339Nano))
}

func StartCanvasSaveRequestRetention(ctx context.Context) func() {
	return startPeriodicWorker(ctx, 24*time.Hour, "CanvasSaveRequest", func(_ context.Context, current time.Time) error { return CleanupExpiredCanvasSaveRequests(current) })
}
