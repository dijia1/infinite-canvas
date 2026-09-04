package handler

import (
	"bytes"
	"log"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/basketikun/infinite-canvas/config"
)

func TestCanvasProjectWriteTraceFromRequestKeepsSafeTraceHeaders(t *testing.T) {
	req := httptest.NewRequest("PUT", "/api/v1/canvas/projects/project-1", nil)
	req.Header.Set("X-Canvas-Tab-Id", "tab_A-1")
	req.Header.Set("X-Canvas-Request-Id", "tab_A-1-7")
	req.Header.Set("X-Canvas-Request-Seq", "7")
	req.Header.Set("X-Canvas-Save-Reason", "autosave")

	trace := canvasProjectWriteTraceFromRequest(req)
	if trace.TabID != "tab_A-1" || trace.RequestID != "tab_A-1-7" || trace.RequestSeq != 7 || trace.Reason != "autosave" {
		t.Fatalf("trace = %#v", trace)
	}

	entry := canvasProjectWriteLogEntry{Outcome: "conflict", UserUID: "portal-user", ProjectID: "project-1", RequestedRevision: 3, ServerRevision: 4, DurationMS: 42, PayloadBytes: 512, UserAgent: "test-agent", Trace: trace}
	line := entry.String()
	for _, fragment := range []string{"outcome=conflict", `user_uid="portal-user"`, `project_id="project-1"`, "requested_revision=3", "server_revision=4", `tab_id="tab_A-1"`, `request_id="tab_A-1-7"`, "request_seq=7", "reason=autosave", "duration_ms=42", "payload_bytes=512", `user_agent="test-agent"`} {
		if !strings.Contains(line, fragment) {
			t.Fatalf("log line %q is missing %q", line, fragment)
		}
	}
}

func TestShouldLogCanvasProjectWriteSamplesSuccessfulWritesButAlwaysLogsConflicts(t *testing.T) {
	previous := config.Cfg
	config.Cfg.CanvasSaveSuccessLogSampleRate = 0
	t.Cleanup(func() { config.Cfg = previous })

	if shouldLogCanvasProjectWrite(canvasProjectWriteLogEntry{Outcome: "saved", Trace: canvasProjectWriteTrace{RequestID: "c75e2ccf-40e9-4d29-bbb9-b5de9ee39d7a"}}) {
		t.Fatal("successful write should respect a zero sample rate")
	}
	if !shouldLogCanvasProjectWrite(canvasProjectWriteLogEntry{Outcome: "conflict"}) {
		t.Fatal("conflicts must always be logged")
	}
	if !shouldLogCanvasProjectWrite(canvasProjectWriteLogEntry{Outcome: "saved", DurationMS: 2001}) {
		t.Fatal("slow saves must always be logged")
	}
}

func TestLogCanvasProjectWriteWritesStructuredEntry(t *testing.T) {
	previousConfig := config.Cfg
	config.Cfg.CanvasSaveSuccessLogSampleRate = 1
	t.Cleanup(func() { config.Cfg = previousConfig })
	var output bytes.Buffer
	previousOutput := log.Writer()
	previousFlags := log.Flags()
	log.SetOutput(&output)
	log.SetFlags(0)
	t.Cleanup(func() {
		log.SetOutput(previousOutput)
		log.SetFlags(previousFlags)
	})

	logCanvasProjectWrite(canvasProjectWriteLogEntry{Outcome: "saved", UserUID: "portal-user", ProjectID: "project-1", RequestedRevision: 2, ServerRevision: 3, Trace: canvasProjectWriteTrace{TabID: "tab-1", RequestID: "tab-1-3", Reason: "autosave"}})

	if !strings.Contains(output.String(), "canvas_project_write outcome=saved") {
		t.Fatalf("log output = %q", output.String())
	}
}

func TestCanvasProjectWriteTraceFromRequestRejectsUnsafeHeaders(t *testing.T) {
	req := httptest.NewRequest("PUT", "/api/v1/canvas/projects/project-1", nil)
	req.Header.Set("X-Canvas-Tab-Id", "bad\nvalue")
	req.Header.Set("X-Canvas-Request-Id", strings.Repeat("a", 129))
	req.Header.Set("X-Canvas-Save-Reason", "manual")

	trace := canvasProjectWriteTraceFromRequest(req)
	if trace.TabID != "" || trace.RequestID != "" || trace.Reason != "unknown" {
		t.Fatalf("unsafe trace = %#v", trace)
	}
}
