package main

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"strconv"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/basketikun/infinite-canvas/ai"
	"github.com/basketikun/infinite-canvas/config"
	"github.com/basketikun/infinite-canvas/internal/testpostgres"
	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/repository"
	"github.com/basketikun/infinite-canvas/router"
	"github.com/basketikun/infinite-canvas/service"
	"github.com/gin-gonic/gin"
	"github.com/shopspring/decimal"
	"gorm.io/gorm/logger"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

type fakeProvider struct {
	base  string
	calls atomic.Int64
}

func (p *fakeProvider) NormalizeImageTaskRequest(r ai.ImageTaskRequest) (ai.ImageTaskRequest, error) {
	return r, nil
}
func (p *fakeProvider) SummarizeImageTaskRequest(r ai.ImageTaskRequest) (ai.ImageTaskRequestSummary, error) {
	return ai.ImageTaskRequestSummary{Method: "LOCAL", Endpoint: "in-process-fake", JSONBody: json.RawMessage(`{"fake":true}`)}, nil
}
func (p *fakeProvider) CreateImageTask(ctx context.Context, r ai.ImageTaskRequest) (ai.ImageTask, error) {
	p.calls.Add(1)
	return ai.ImageTask{ID: strconv.FormatInt(time.Now().UnixNano(), 10), Status: "running"}, nil
}
func (p *fakeProvider) GetImageTask(ctx context.Context, id string) (ai.ImageTask, error) {
	t, err := strconv.ParseInt(id, 10, 64)
	if err != nil {
		return ai.ImageTask{}, err
	}
	if time.Since(time.Unix(0, t)) < time.Second {
		return ai.ImageTask{ID: id, Status: "running"}, nil
	}
	return ai.ImageTask{ID: id, Status: "completed", ResultURLs: []string{p.base + "/__loadtest/result.png"}}, nil
}

// A bounded 1ms histogram avoids manufacturing a server memory leak with instrumentation.
type queryMetrics struct {
	bins                    [10001]atomic.Int64
	count, ns, errors, slow atomic.Int64
	max                     atomic.Int64
}

func (q *queryMetrics) LogMode(logger.LogLevel) logger.Interface { return q }
func (q *queryMetrics) Info(context.Context, string, ...any)     {}
func (q *queryMetrics) Warn(context.Context, string, ...any)     {}
func (q *queryMetrics) Error(context.Context, string, ...any)    {}
func (q *queryMetrics) Trace(ctx context.Context, start time.Time, fc func() (string, int64), err error) {
	d := time.Since(start)
	q.count.Add(1)
	q.ns.Add(d.Nanoseconds())
	b := int(d.Milliseconds())
	if b > 10000 {
		b = 10000
	}
	q.bins[b].Add(1)
	for old := q.max.Load(); d.Nanoseconds() > old; old = q.max.Load() {
		if q.max.CompareAndSwap(old, d.Nanoseconds()) {
			break
		}
	}
	if d > 200*time.Millisecond {
		q.slow.Add(1)
	}
	if err != nil && err.Error() != "record not found" {
		q.errors.Add(1)
		log.Printf("loadtest SQL error: %v", err)
	}
}
func (q *queryMetrics) snapshot() map[string]any {
	n := q.count.Load()
	p := map[string]int{}
	sum := int64(0)
	for i := range q.bins {
		sum += q.bins[i].Load()
		for name, f := range map[string]float64{"p50_ms": .5, "p95_ms": .95, "p99_ms": .99} {
			if _, ok := p[name]; !ok && float64(sum) >= float64(n)*f {
				p[name] = i + 1
			}
		}
	}
	avg := 0.0
	if n > 0 {
		avg = float64(q.ns.Load()) / float64(n) / 1e6
	}
	return map[string]any{"count": n, "mean_ms": avg, "max_ms": float64(q.max.Load()) / 1e6, "percentile_upper_bounds": p, "slow_over_200ms": q.slow.Load(), "errors": q.errors.Load()}
}

func serve(path, out string) error {
	// config.Load is intentionally never called: no .env, credentials, or production DSN.
	u, err := neturlLocalDSN(os.Getenv("TEST_DATABASE_DSN"))
	if err != nil {
		return err
	}
	_ = u
	schema, err := testpostgres.NewSchema("loadtest")
	if err != nil {
		return err
	}
	defer schema.Close()
	dir, err := os.MkdirTemp("", "canvas-load-media-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(dir)
	config.Cfg = config.Config{DatabaseDSN: schema.DSN, DatabaseMaxOpenConns: 20, DatabaseMaxIdleConns: 10, DatabaseConnMaxLifetime: "30m", MediaStorage: "local", MediaLocalDir: dir, WorkflowEnabled: true, WorkflowGlobalConcurrency: 4, WorkflowRunConcurrency: 2, AITaskWorkerConcurrency: 4, AIImageTaskTimeout: "3m", CanvasSaveSuccessLogSampleRate: .05}
	db, err := repository.DB()
	if err != nil {
		return err
	}
	pool, err := db.DB()
	if err != nil {
		return err
	}
	defer pool.Close()
	queryStats := &queryMetrics{}
	db.Config.Logger = queryStats
	observer, err := sql.Open("pgx", schema.DSN)
	if err != nil {
		return err
	}
	observer.SetMaxOpenConns(1)
	defer observer.Close()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return err
	}
	defer listener.Close()
	base := "http://" + listener.Addr().String()
	fake := &fakeProvider{base: base}
	if err := ai.Register(ai.ProviderType{ID: "load-fake", Name: "Local load-test fake", Capabilities: []ai.Capability{ai.CapabilityImageGenerate, ai.CapabilityImageEdit}, CanonicalizeImageTaskRequest: fake.NormalizeImageTaskRequest, New: func(json.RawMessage) (ai.Provider, error) { return fake, nil }}); err != nil {
		return err
	}
	if _, err := repository.SaveSettings(model.Settings{AI: model.AISettings{ImageProviderID: "load-fake", Providers: []model.AIProvider{{ID: "load-fake", Name: "Local fake", Type: "load-fake", Enabled: true, ImagePrices: []model.ImageResolutionPrice{{Resolution: "1k", Amount: decimal.Zero}}, Config: json.RawMessage(`{}`)}}}}, time.Now().UTC().Format(time.RFC3339)); err != nil {
		return err
	}
	var denied atomic.Int64
	transport := http.DefaultTransport
	http.DefaultTransport = roundTripFunc(func(r *http.Request) (*http.Response, error) {
		if r.URL.Scheme != "http" || r.URL.Host != listener.Addr().String() {
			denied.Add(1)
			return nil, fmt.Errorf("loadtest blocks non-local HTTP")
		}
		return transport.RoundTrip(r)
	})
	img := image.NewRGBA(image.Rect(0, 0, 64, 64))
	for y := 0; y < 64; y++ {
		for x := 0; x < 64; x++ {
			img.Set(x, y, color.RGBA{uint8(x * 4), uint8(y * 4), 128, 255})
		}
	}
	var buffer bytes.Buffer
	if err := png.Encode(&buffer, img); err != nil {
		return err
	}
	users, err := seed(dir, buffer.Bytes())
	if err != nil {
		return err
	}
	gin.SetMode(gin.ReleaseMode)
	f, err := os.Create(filepath.Join(out, "api.log"))
	if err != nil {
		return err
	}
	defer f.Close()
	gin.DefaultWriter = f
	log.SetOutput(f)
	mux := http.NewServeMux()
	mux.Handle("/", router.New())
	mux.HandleFunc("/__loadtest/result.png", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "image/png")
		w.Write(buffer.Bytes())
	})
	mux.HandleFunc("/__loadtest/metrics", func(w http.ResponseWriter, r *http.Request) {
		stats := pool.Stats()
		var memory runtime.MemStats
		runtime.ReadMemStats(&memory)
		var usage syscall.Rusage
		syscall.Getrusage(syscall.RUSAGE_SELF, &usage)
		ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
		defer cancel()
		var active, connections, waiting, blocked int
		err := observer.QueryRowContext(ctx, `SELECT count(*) FILTER(WHERE state='active'),count(*),count(*) FILTER(WHERE wait_event_type='Lock'),count(*) FILTER(WHERE cardinality(pg_blocking_pids(pid))>0) FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()`).Scan(&active, &connections, &waiting, &blocked)
		var runs, attempts []map[string]any
		// Observer statements do not occupy the application's connection pool.
		for table, dst := range map[string]*[]map[string]any{"workflow_runs": &runs, "workflow_output_attempts": &attempts} {
			rows, e := observer.QueryContext(ctx, "SELECT status,count(*) FROM "+table+" GROUP BY status")
			if e == nil {
				for rows.Next() {
					var s string
					var n int
					rows.Scan(&s, &n)
					*dst = append(*dst, map[string]any{"status": s, "count": n})
				}
				rows.Close()
			}
		}
		var pgCalls int64
		var pgMS float64
		pgErr := observer.QueryRowContext(ctx, `SELECT COALESCE(sum(calls),0),COALESCE(sum(total_exec_time),0) FROM public.pg_stat_statements WHERE dbid=(SELECT oid FROM pg_database WHERE datname=current_database())`).Scan(&pgCalls, &pgMS)
		observerError := ""
		if err != nil {
			observerError = err.Error()
		}
		if pgErr != nil {
			observerError += pgErr.Error()
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"time": time.Now().UTC(), "go_version": runtime.Version(), "gomaxprocs": runtime.GOMAXPROCS(0), "goroutines": runtime.NumGoroutine(), "heap_alloc": memory.HeapAlloc, "heap_inuse": memory.HeapInuse, "heap_objects": memory.HeapObjects, "go_sys": memory.Sys, "gc_count": memory.NumGC, "gc_pause_ns": memory.PauseTotalNs, "cpu_user_s": float64(usage.Utime.Sec) + float64(usage.Utime.Usec)/1e6, "cpu_system_s": float64(usage.Stime.Sec) + float64(usage.Stime.Usec)/1e6, "pool": stats, "pg_active": active, "pg_connections": connections, "pg_lock_waiters": waiting, "pg_blocked": blocked, "pg_calls": pgCalls, "pg_exec_ms": pgMS, "query": queryStats.snapshot(), "runs": runs, "attempts": attempts, "fake_submissions": fake.calls.Load(), "blocked_http": denied.Load(), "observer_error": observerError})
	})
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	stopWorker, err := service.StartImageTaskWorker(ctx)
	if err != nil {
		return err
	}
	defer stopWorker()
	stopScheduler, err := service.StartWorkflowScheduler(ctx)
	if err != nil {
		return err
	}
	defer stopScheduler()
	srv := &http.Server{Handler: mux, ReadHeaderTimeout: 5 * time.Second}
	go func() {
		if err := srv.Serve(listener); err != nil && err != http.ErrServerClosed {
			log.Printf("test API stopped: %v", err)
			stop()
		}
	}()
	if err := writeJSON(path, manifest{URL: base, PID: os.Getpid(), Users: users}); err != nil {
		return err
	}
	fmt.Println("isolated load test API ready", base)
	<-ctx.Done()
	shutdown, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	return srv.Shutdown(shutdown)
}
