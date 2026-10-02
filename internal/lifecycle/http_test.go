package lifecycle

import (
	"context"
	"io"
	"net"
	"net/http"
	"strings"
	"testing"
	"time"
)

func serve(t *testing.T, h *HTTP) string {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	go func() { _ = h.Server.Serve(listener) }()
	t.Cleanup(func() { _ = h.Server.Close() })
	return "http://" + listener.Addr().String()
}

func TestShutdownCompletesInflightResponseAndRefusesNewConnections(t *testing.T) {
	started, release := make(chan struct{}), make(chan struct{})
	h := NewHTTP("", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(started)
		<-release
		_, _ = w.Write([]byte("complete"))
	}))
	address := serve(t, h)
	response := make(chan *http.Response, 1)
	go func() {
		r, err := http.Get(address)
		if err == nil {
			response <- r
		}
	}()
	<-started
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- h.Shutdown(ctx) }()
	for !h.closing.Load() {
		time.Sleep(time.Millisecond)
	}
	if r, err := http.Get(address); err == nil {
		r.Body.Close()
		t.Fatal("new connection accepted")
	}
	select {
	case <-done:
		t.Fatal("shutdown completed before handler")
	case <-time.After(30 * time.Millisecond):
	}
	close(release)
	r := <-response
	body, _ := io.ReadAll(r.Body)
	r.Body.Close()
	if string(body) != "complete" || !r.Close {
		t.Fatalf("body=%q close=%t", body, r.Close)
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

func TestShutdownWaitsForDisconnectedHandlerWork(t *testing.T) {
	started, release := make(chan struct{}), make(chan struct{})
	h := NewHTTP("", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte("started"))
		w.(http.Flusher).Flush()
		close(started)
		<-release
	}))
	address := serve(t, h)
	r, err := http.Get(address)
	if err != nil {
		t.Fatal(err)
	}
	<-started
	r.Body.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- h.Shutdown(ctx) }()
	select {
	case <-done:
		t.Fatal("disconnected work abandoned")
	case <-time.After(30 * time.Millisecond):
	}
	close(release)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

func TestShutdownDeadlineDoesNotReportSuccess(t *testing.T) {
	started, release := make(chan struct{}), make(chan struct{})
	defer close(release)
	h := NewHTTP("", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { close(started); <-release }))
	address := serve(t, h)
	go http.Get(address)
	<-started
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	if err := h.Shutdown(ctx); err == nil {
		t.Fatal("deadline reported success")
	}
}

func TestStreamingAndReaderFromPreserveBody(t *testing.T) {
	h := NewHTTP("", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/zip")
		w.(http.Flusher).Flush()
		_, _ = io.Copy(w, strings.NewReader(strings.Repeat("zip", 1024)))
	}))
	r, err := http.Get(serve(t, h))
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(r.Body)
	r.Body.Close()
	if string(body) != strings.Repeat("zip", 1024) {
		t.Fatal("stream corrupted")
	}
	if err := h.Shutdown(context.Background()); err != nil {
		t.Fatal(err)
	}
}
