package service

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/basketikun/infinite-canvas/config"
	"github.com/basketikun/infinite-canvas/repository"
)

func TestGeneratedVideoStreamsToOSSAndRecoversWithoutProbeOrDownload(t *testing.T) {
	for _, knownLength := range []bool{true, false} {
		t.Run(fmt.Sprintf("known-length-%v", knownLength), func(t *testing.T) {
			// No MP4 header: storing the provider result must not inspect its format.
			first := bytes.Repeat([]byte("provider-output"), 8192)
			last := []byte("end of video")
			forwarded := make(chan struct{})
			var providerReads, puts, gets atomic.Int32
			provider := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				providerReads.Add(1)
				if knownLength {
					w.Header().Set("Content-Length", fmt.Sprint(len(first)+len(last)))
				}
				w.Write(first)
				w.(http.Flusher).Flush()
				// The provider cannot finish until OSS receives bytes. Buffering or
				// spooling the whole response would deadlock this transfer.
				select {
				case <-forwarded:
					w.Write(last)
				case <-r.Context().Done():
				}
			}))
			defer provider.Close()
			var mu sync.Mutex
			var stored []byte
			ossServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch r.Method {
				case http.MethodPut:
					puts.Add(1)
					prefix := make([]byte, len(first))
					if _, err := io.ReadFull(r.Body, prefix); err != nil {
						t.Error(err)
						w.WriteHeader(http.StatusBadRequest)
						return
					}
					close(forwarded)
					suffix, err := io.ReadAll(r.Body)
					if err != nil {
						t.Error(err)
						w.WriteHeader(http.StatusBadRequest)
						return
					}
					if !bytes.Equal(prefix, first) || !bytes.Equal(suffix, last) || r.Header.Get("Content-Type") != "video/mp4" {
						t.Error("provider bytes were altered")
					}
					mu.Lock()
					stored = append(prefix, suffix...)
					mu.Unlock()
					w.Header().Set("x-oss-version-id", "result-version")
					w.Header().Set("ETag", "result-etag")
				case http.MethodHead:
					mu.Lock()
					defer mu.Unlock()
					if stored == nil {
						w.WriteHeader(http.StatusNotFound)
						return
					}
					w.Header().Set("Content-Length", fmt.Sprint(len(stored)))
					w.Header().Set("Content-Type", "video/mp4")
					w.Header().Set("x-oss-version-id", "result-version")
					w.Header().Set("ETag", "result-etag")
				default:
					gets.Add(1)
					http.Error(w, "OSS result downloads are forbidden", http.StatusBadRequest)
				}
			}))
			defer ossServer.Close()
			previousConfig, previousClient := config.Cfg, videoDownloadClient
			t.Cleanup(func() { config.Cfg, videoDownloadClient = previousConfig, previousClient })
			config.Cfg.MediaStorage = "oss"
			config.Cfg.OSSRegion, config.Cfg.OSSBucket = "cn-test", "test"
			config.Cfg.OSSInternalEndpoint, config.Cfg.OSSPublicEndpoint = ossServer.URL, ossServer.URL
			config.Cfg.OSSAccessKeyID, config.Cfg.OSSAccessKeySecret = "fake", "fake"
			config.Cfg.OSSSignedURLTTL = "15m"
			videoDownloadClient = provider.Client()
			item, current := seedWorkerVideo(t, "saving", workerVideoProvider{})
			output := videoOutputReservation{ID: newID("video-result"), ObjectKey: newID("video-output") + ".mp4"}
			encoded, _ := json.Marshal([]videoOutputReservation{output})
			item.PendingOutputsJSON = string(encoded)
			item.RequestJSON = `{"seconds":5,"size":"9:16","resolution":"720p"}`
			item.ResultURLsJSON = fmt.Sprintf(`["%s/result.mp4"]`, provider.URL)
			if err := repository.UpdateClaimedVideoTask(item, map[string]any{"pending_outputs_json": item.PendingOutputsJSON, "request_json": item.RequestJSON, "result_urls_json": item.ResultURLsJSON}); err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			if err := processVideoTaskStep(ctx, item, current); err != nil {
				t.Fatal(err)
			}
			if task := readWorkerVideo(t, item); task.Status != "succeeded" {
				t.Fatalf("streamed video was not published: %+v", task)
			}
			media, found, err := repository.GetMedia(output.ID)
			if err != nil || !found || media.Duration != 5 || media.Width != 0 || media.Height != 0 || media.Bytes != int64(len(first)+len(last)) || media.ObjectVersionID != "result-version" {
				t.Fatalf("wrong result metadata: %+v %v", media, err)
			}
			item.ResultURLsJSON = `["https://expired.invalid/video.mp4"]`
			results, err := saveVideoTaskResults(ctx, item)
			if err != nil || len(results) != 1 || results[0].ID != output.ID {
				t.Fatalf("stored result recovery: %+v %v", results, err)
			}
			if providerReads.Load() != 1 || puts.Load() != 1 || gets.Load() != 0 {
				t.Fatalf("provider reads=%d puts=%d OSS downloads=%d", providerReads.Load(), puts.Load(), gets.Load())
			}
		})
	}
}

func TestGeneratedVideoRetainsSizeLimitWithoutInspectingContents(t *testing.T) {
	_, err := putVideoStream(context.Background(), nil, "result.mp4", io.NopCloser(strings.NewReader("x")), maxVideoBytes+1)
	if err == nil || !strings.Contains(err.Error(), "100 MB") {
		t.Fatalf("large video accepted: %v", err)
	}
}
