package handler

import (
	"crypto/sha256"
	"fmt"
	"log"
	"net/http"
	"regexp"
	"strconv"
	"strings"

	"github.com/basketikun/infinite-canvas/config"
)

const canvasProjectTraceValueMaxLength = 128

var canvasProjectTraceValuePattern = regexp.MustCompile(`^[A-Za-z0-9._~-]+$`)

type canvasProjectWriteTrace struct {
	TabID      string
	RequestID  string
	RequestSeq int
	Reason     string
}

type canvasProjectWriteLogEntry struct {
	Outcome           string
	UserUID           string
	ProjectID         string
	RequestedRevision int
	ServerRevision    int
	DurationMS        int64
	PayloadBytes      int64
	UserAgent         string
	Trace             canvasProjectWriteTrace
}

func canvasProjectWriteTraceFromRequest(r *http.Request) canvasProjectWriteTrace {
	reason := strings.TrimSpace(r.Header.Get("X-Canvas-Save-Reason"))
	if reason != "autosave" && reason != "retry" && reason != "delete" {
		reason = "unknown"
	}
	return canvasProjectWriteTrace{
		TabID:      canvasProjectTraceHeader(r, "X-Canvas-Tab-Id"),
		RequestID:  canvasProjectTraceHeader(r, "X-Canvas-Request-Id"),
		RequestSeq: canvasProjectTraceSequence(r),
		Reason:     reason,
	}
}

func canvasProjectTraceSequence(r *http.Request) int {
	value := strings.TrimSpace(r.Header.Get("X-Canvas-Request-Seq"))
	sequence, err := strconv.Atoi(value)
	if err != nil || sequence < 1 {
		return 0
	}
	return sequence
}

func canvasProjectTraceHeader(r *http.Request, name string) string {
	value := strings.TrimSpace(r.Header.Get(name))
	if len(value) > canvasProjectTraceValueMaxLength || !canvasProjectTraceValuePattern.MatchString(value) {
		return ""
	}
	return value
}

func (entry canvasProjectWriteLogEntry) String() string {
	return fmt.Sprintf(
		"canvas_project_write outcome=%s user_uid=%q project_id=%q requested_revision=%d server_revision=%d tab_id=%q request_id=%q request_seq=%d reason=%s duration_ms=%d payload_bytes=%d user_agent=%q",
		entry.Outcome,
		entry.UserUID,
		entry.ProjectID,
		entry.RequestedRevision,
		entry.ServerRevision,
		entry.Trace.TabID,
		entry.Trace.RequestID,
		entry.Trace.RequestSeq,
		entry.Trace.Reason,
		entry.DurationMS,
		entry.PayloadBytes,
		entry.UserAgent,
	)
}

func logCanvasProjectWrite(entry canvasProjectWriteLogEntry) {
	if !shouldLogCanvasProjectWrite(entry) {
		return
	}
	log.Print(entry.String())
}

func shouldLogCanvasProjectWrite(entry canvasProjectWriteLogEntry) bool {
	if entry.Outcome != "saved" && entry.Outcome != "deduplicated" {
		return true
	}
	if entry.DurationMS > 2000 {
		return true
	}
	rate := config.Cfg.CanvasSaveSuccessLogSampleRate
	if rate <= 0 {
		return false
	}
	if rate >= 1 {
		return true
	}
	sum := sha256.Sum256([]byte(entry.Trace.RequestID + "\x00" + entry.ProjectID + "\x00" + fmt.Sprint(entry.RequestedRevision)))
	return int(sum[0]) < int(rate*256)
}
