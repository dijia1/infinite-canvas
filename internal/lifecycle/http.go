// Package lifecycle keeps native net/http semantics while tracking handler work
// that can outlive a disconnected client. It does not own application routes.
package lifecycle

import (
	"bufio"
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"sync"
	"sync/atomic"
)

type HTTP struct {
	Server   *http.Server
	closing  atomic.Bool
	mu       sync.Mutex
	handlers sync.WaitGroup
}

func NewHTTP(address string, handler http.Handler) *HTTP {
	h := &HTTP{}
	h.Server = &http.Server{Addr: address, Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h.mu.Lock()
		if h.closing.Load() {
			h.mu.Unlock()
			w.Header().Set("Connection", "close")
			http.Error(w, "service stopping", http.StatusServiceUnavailable)
			return
		}
		h.handlers.Add(1)
		h.mu.Unlock()
		defer h.handlers.Done()
		handler.ServeHTTP(&responseWriter{ResponseWriter: w, closing: &h.closing}, r)
	})}
	return h
}

func (h *HTTP) Shutdown(ctx context.Context) error {
	h.mu.Lock()
	h.closing.Store(true)
	h.mu.Unlock()
	h.Server.SetKeepAlivesEnabled(false)
	err := h.Server.Shutdown(ctx)
	done := make(chan struct{})
	go func() { h.handlers.Wait(); close(done) }()
	select {
	case <-done:
		return err
	case <-ctx.Done():
		return errors.Join(err, ctx.Err())
	}
}

type responseWriter struct {
	http.ResponseWriter
	closing *atomic.Bool
	wrote   bool
}

func (w *responseWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }
func (w *responseWriter) WriteHeader(code int) {
	if !w.wrote {
		if w.closing.Load() {
			w.Header().Set("Connection", "close")
		}
		w.wrote = true
	}
	w.ResponseWriter.WriteHeader(code)
}
func (w *responseWriter) Write(data []byte) (int, error) {
	if !w.wrote {
		w.WriteHeader(http.StatusOK)
	}
	return w.ResponseWriter.Write(data)
}
func (w *responseWriter) Flush() {
	if !w.wrote {
		w.WriteHeader(http.StatusOK)
	}
	_ = http.NewResponseController(w.ResponseWriter).Flush()
}
func (w *responseWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	return http.NewResponseController(w.ResponseWriter).Hijack()
}
func (w *responseWriter) CloseNotify() <-chan bool {
	return w.ResponseWriter.(http.CloseNotifier).CloseNotify()
}
func (w *responseWriter) ReadFrom(r io.Reader) (int64, error) {
	if !w.wrote {
		w.WriteHeader(http.StatusOK)
	}
	if rf, ok := w.ResponseWriter.(io.ReaderFrom); ok {
		return rf.ReadFrom(r)
	}
	return io.Copy(w.ResponseWriter, r)
}
