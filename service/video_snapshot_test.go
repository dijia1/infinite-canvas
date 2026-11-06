package service

import (
	"context"
	"errors"
	"github.com/basketikun/infinite-canvas/model"
	"testing"
	"time"
)

func TestVideoSnapshotUsesFirstFrame(t *testing.T) {
	for _, duration := range []float64{5, 0.4, 0} {
		store := &snapshotTestStore{}
		access, err := mediaAccess(context.Background(), store, model.Media{ID: "video", ContentType: "video/mp4", Duration: duration})
		if err != nil || access.URL == "" || access.PreviewURL == "" {
			t.Fatalf("duration %v: unexpected access: %#v %v", duration, access, err)
		}
		if len(store.processes) != 2 || store.processes[1] != "video/snapshot,t_0,f_jpg,w_480" {
			t.Fatalf("duration %v: unexpected signed process: %v", duration, store.processes)
		}
	}
}

type snapshotTestStore struct {
	localImageStore
	failPreview bool
	processes   []string
}

func (s *snapshotTestStore) SignedURL(_ context.Context, _ string, process string) (string, time.Time, error) {
	s.processes = append(s.processes, process)
	if process != "" && s.failPreview {
		return "", time.Time{}, errors.New("sign failed")
	}
	return "https://test/video?process=" + process, time.Now().Add(time.Hour), nil
}
func TestVideoSnapshotSigningFailureKeepsPlayback(t *testing.T) {
	store := &snapshotTestStore{failPreview: true}
	access, err := mediaAccess(context.Background(), store, model.Media{ID: "video", ContentType: "video/mp4", Duration: 0.4})
	if err != nil || access.URL == "" || access.PreviewURL != "" {
		t.Fatalf("playback should survive poster failure: %#v %v", access, err)
	}
	if len(store.processes) != 2 || store.processes[1] != "video/snapshot,t_0,f_jpg,w_480" {
		t.Fatalf("unexpected signed process: %v", store.processes)
	}
}
func TestLocalVideoHasNoSnapshotURL(t *testing.T) {
	access, err := mediaAccess(context.Background(), localImageStore{}, model.Media{ID: "local", ContentType: "video/mp4"})
	if err != nil || access.PreviewURL != "" || access.URL != "/api/v1/media/local/content" {
		t.Fatalf("unexpected local video access: %#v %v", access, err)
	}
}
