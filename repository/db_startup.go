package repository

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/stdlib"
)

// WaitForDatabase probes connectivity before DB's one-time initialization and
// migrations. A failed probe must not poison dbOnce or start any task workers.
func WaitForDatabase(ctx context.Context, dsn string) error {
	parsed, err := pgx.ParseConfig(dsn)
	if err != nil {
		// Parse errors may contain the original DSN, including its password.
		return errors.New("invalid DATABASE_DSN")
	}
	probe := stdlib.OpenDB(*parsed)
	defer probe.Close()
	probe.SetMaxOpenConns(1)
	probe.SetMaxIdleConns(0)
	return waitForDatabase(ctx, probe.PingContext, time.Second)
}

func waitForDatabase(ctx context.Context, ping func(context.Context) error, interval time.Duration) error {
	for {
		if err := ctx.Err(); err != nil {
			return fmt.Errorf("waiting for database: %w", err)
		}
		attempt, cancel := context.WithTimeout(ctx, 2*time.Second)
		err := ping(attempt)
		cancel()
		if err == nil {
			return nil
		}
		var pgError *pgconn.PgError
		if errors.As(err, &pgError) && (strings.HasPrefix(pgError.Code, "28") || pgError.Code == "3D000") {
			return fmt.Errorf("database startup rejected (SQLSTATE %s)", pgError.Code)
		}
		timer := time.NewTimer(interval)
		select {
		case <-ctx.Done():
			timer.Stop()
			return fmt.Errorf("waiting for database: %w", ctx.Err())
		case <-timer.C:
		}
	}
}
