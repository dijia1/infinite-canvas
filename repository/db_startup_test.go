package repository

import (
	"context"
	"errors"
	"io"
	"net"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
)

func TestWaitForDatabaseRetriesBeforeInitialization(t *testing.T) {
	calls := 0
	err := waitForDatabase(context.Background(), func(context.Context) error {
		calls++
		if calls < 3 {
			return errors.New("connection refused")
		}
		return nil
	}, time.Millisecond)
	if err != nil || calls != 3 {
		t.Fatalf("calls=%d err=%v", calls, err)
	}
}

func TestWaitForDatabaseCancellationStopsRetries(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	calls := 0
	err := waitForDatabase(ctx, func(context.Context) error {
		calls++
		cancel()
		return errors.New("connection refused")
	}, time.Hour)
	if !errors.Is(err, context.Canceled) || calls != 1 {
		t.Fatalf("calls=%d err=%v", calls, err)
	}
}

func TestWaitForDatabaseBoundsInFlightConnection(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	err := waitForDatabase(ctx, func(attempt context.Context) error {
		<-attempt.Done()
		return attempt.Err()
	}, time.Hour)
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("err=%v", err)
	}
}

func TestWaitForDatabaseDoesNotExposeConnectionCredentials(t *testing.T) {
	err := WaitForDatabase(context.Background(), "postgres://user:secret-password@host:invalid/database")
	if err == nil || strings.Contains(err.Error(), "secret-password") {
		t.Fatalf("unsafe error=%v", err)
	}
}

func TestWaitForDatabaseRejectsInvalidAuthenticationWithoutRetry(t *testing.T) {
	for _, code := range []string{"28P01", "28000", "3D000"} {
		calls := 0
		err := waitForDatabase(context.Background(), func(context.Context) error {
			calls++
			return &pgconn.PgError{Code: code, Message: "secret connection detail"}
		}, time.Hour)
		if err == nil || calls != 1 || !strings.Contains(err.Error(), code) || strings.Contains(err.Error(), "secret") {
			t.Fatalf("code=%s calls=%d error=%v", code, calls, err)
		}
	}
}

func TestWaitForDatabaseRecoversAgainstPostgresWithoutPoisoningInitialization(t *testing.T) {
	cfg := newRepositoryTestConfig(t, "startup_recovery")
	useRepositoryTestDB(t, cfg)
	target, err := url.Parse(cfg.DatabaseDSN)
	if err != nil {
		t.Fatal(err)
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	blocked := make(chan struct{})
	allow := make(chan struct{})
	stopped := make(chan struct{})
	var connections sync.WaitGroup
	var first sync.Once
	go func() {
		defer close(stopped)
		for {
			connection, err := listener.Accept()
			if err != nil {
				return
			}
			select {
			case <-allow:
				connections.Add(1)
				go func() {
					defer connections.Done()
					defer connection.Close()
					upstream, err := net.DialTimeout("tcp", target.Host, time.Second)
					if err != nil {
						return
					}
					defer upstream.Close()
					copied := make(chan struct{})
					go func() { _, _ = io.Copy(upstream, connection); _ = upstream.Close(); close(copied) }()
					_, _ = io.Copy(connection, upstream)
					_ = connection.Close()
					<-copied
				}()
			default:
				_ = connection.Close()
				first.Do(func() { close(blocked) })
			}
		}
	}()
	t.Cleanup(func() { _ = listener.Close(); <-stopped; connections.Wait() })
	proxy := *target
	proxy.Host = listener.Addr().String()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	result := make(chan error, 1)
	go func() { result <- WaitForDatabase(ctx, proxy.String()) }()
	select {
	case <-blocked:
	case <-ctx.Done():
		t.Fatal("startup did not attempt database connection")
	}
	if db != nil || dbErr != nil {
		t.Fatal("readiness probe initialized the global repository")
	}
	select {
	case err := <-result:
		t.Fatalf("startup stopped before database recovered: %v", err)
	default:
	}
	close(allow)
	if err := <-result; err != nil {
		t.Fatal(err)
	}
	// The real migrations still run once, after connectivity has recovered.
	database, err := DB()
	if err != nil {
		t.Fatal(err)
	}
	if !database.Migrator().HasTable("canvas_projects") {
		t.Fatal("database initialization did not run")
	}
}
