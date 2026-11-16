package service

import (
	"context"
	"encoding/json"
	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/repository"
	"github.com/shopspring/decimal"
	"testing"
	"time"
)

func TestVideoDraftProvenanceAndFinalInheritance(t *testing.T) {
	db, err := repository.DB()
	if err != nil {
		t.Fatal(err)
	}
	owner := newID("draft-owner")
	original := CreateVideoTaskRequest{Mode: "draft", Prompt: "original prompt", Seconds: 10, Size: "9:16", Resolution: "480p", GenerateAudio: true, ImageMediaIDs: []string{"old-image"}, VideoMediaIDs: []string{"old-video"}}
	raw, _ := json.Marshal(original)
	source := model.VideoGenerationTask{ID: newID("video-task"), OwnerUID: owner, ClientRequestID: newID("client"), ProviderID: "provider", ProviderType: "maizi-video-seedance-2-5", Status: "succeeded", ProviderTaskID: "f3a1c2d3-4567-49ab-8def-0123456789ab", RequestJSON: string(raw), CreatedAt: time.Now()}
	if err = db.Create(&source).Error; err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Delete(&model.VideoGenerationTask{}, "id = ?", source.ID) })
	request := CreateVideoTaskRequest{ClientRequestID: "formal-client", Mode: "final", SourceDraftTaskID: source.ID, Prompt: "changed", Seconds: 1, Resolution: "480p", ImageMediaIDs: []string{"untrusted"}}
	normalized, err := normalizeVideoTaskRequest(request)
	if err != nil {
		t.Fatal(err)
	}
	final, _, err := resolveDraftVideoRequest(PortalUser{UID: owner}, normalized)
	if err != nil {
		t.Fatal(err)
	}
	if final.Prompt != original.Prompt || final.Seconds != 10 || final.Size != "9:16" || final.Resolution != "1080p" || !final.GenerateAudio || final.ProviderID != "provider" || len(final.ImageMediaIDs) > 0 || len(final.VideoMediaIDs) > 0 {
		t.Fatalf("incorrect inherited snapshot: %#v", final)
	}
	upstream, err := resolveVideoTaskInputs(context.Background(), PortalUser{UID: owner}, final, nil)
	if err != nil || upstream.DraftTaskID != source.ProviderTaskID || len(upstream.VideoURLs) > 0 || upstream.Prompt != "" {
		t.Fatalf("formal should not resolve or download media: %#v %v", upstream, err)
	}
	for _, bad := range []CreateVideoTaskRequest{{Mode: "final", SourceDraftTaskID: source.ID, ProviderID: "other"}, {Mode: "final", SourceDraftTaskID: "missing"}} {
		if _, _, err := resolveDraftVideoRequest(PortalUser{UID: owner}, bad); err == nil {
			t.Fatal("accepted invalid draft")
		}
	}
	if _, _, err := resolveDraftVideoRequest(PortalUser{UID: "someone-else"}, request); err == nil {
		t.Fatal("accepted another owner's sample")
	}
	hash, _ := videoTaskRequestHash(final)
	retried := request
	retried.ProviderID = "provider"
	retryHash, _ := videoTaskRequestHash(retried)
	if hash != retryHash {
		t.Fatal("formal retry identity depends on inherited fields")
	}
	access, err := mediaVideoGenerationSource(model.Media{OwnerUID: owner, GenerationTaskID: source.ID})
	if err != nil || access == nil || access.TaskID != source.ID || access.Mode != "draft" {
		t.Fatal(access, err)
	}
	provider := model.AIProvider{AspectRatios: []string{"9:16"}, VideoPrices: []model.ImageResolutionPrice{{Resolution: "480p", Amount: decimal.RequireFromString("0.77")}, {Resolution: "1080p", Amount: decimal.RequireFromString("4.2")}}}
	amount, err := videoTaskAmount(provider, final)
	if err != nil || amount.String() != "42" {
		t.Fatal(amount, err)
	}
	db.Model(&source).Update("status", "running")
	if _, _, err := resolveDraftVideoRequest(PortalUser{UID: owner}, request); err == nil {
		t.Fatal("accepted unfinished sample")
	}
	db.Model(&source).Updates(map[string]any{"status": "succeeded", "request_json": `{"mode":"","seconds":10}`})
	if _, _, err := resolveDraftVideoRequest(PortalUser{UID: owner}, request); err == nil {
		t.Fatal("accepted normal video as sample")
	}
}

func TestVideoLegacyHashRemainsVersionOne(t *testing.T) {
	req := CreateVideoTaskRequest{ProviderID: "old", Prompt: "move", Seconds: 5, Size: "16:9", Resolution: "720p"}
	expected, _ := canonicalRequestHash(struct {
		Version       int      `json:"version"`
		Kind          string   `json:"kind"`
		ProviderID    string   `json:"providerId"`
		Prompt        string   `json:"prompt"`
		Seconds       int      `json:"seconds"`
		Size          string   `json:"size"`
		Resolution    string   `json:"resolution"`
		GenerateAudio bool     `json:"generateAudio"`
		ImageMediaIDs []string `json:"imageMediaIds"`
		VideoMediaIDs []string `json:"videoMediaIds"`
	}{1, "video", "old", "move", 5, "16:9", "720p", false, []string{}, []string{}})
	got, _ := videoTaskRequestHash(req)
	if got != expected {
		t.Fatal("old task hash changed")
	}
	req.Mode = "draft"
	draft, _ := videoTaskRequestHash(req)
	if got == draft {
		t.Fatal("sample identity equals normal generation")
	}
}

func TestCreateFormalVideoTaskSnapshotsAndReplaysWithoutMediaResolution(t *testing.T) {
	original, err := AdminSettings()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if _, err := saveGenerationSettingsForTest(t, original); err != nil {
			t.Error(err)
		}
	})
	provider := model.AIProvider{ID: newID("seedance25"), Name: "Seedance 2.5", Type: "maizi-video-seedance-2-5", Enabled: true, Config: json.RawMessage(`{"apiKey":"fixture","model":"doubao-seedance-2.5"}`), AspectRatios: []string{"16:9"}, VideoPrices: []model.ImageResolutionPrice{{Resolution: "480p", Amount: decimal.RequireFromString("0.77")}, {Resolution: "720p", Amount: decimal.RequireFromString("1.4")}, {Resolution: "1080p", Amount: decimal.RequireFromString("4.2")}}}
	settings := original
	settings.AI = model.AISettings{Providers: []model.AIProvider{provider}, VideoProviderID: provider.ID}
	if _, err = SaveSettings(settings); err != nil {
		t.Fatal(err)
	}
	db, _ := repository.DB()
	owner := newID("formal-owner")
	raw, _ := json.Marshal(CreateVideoTaskRequest{Mode: "draft", Prompt: "reviewed", Seconds: 5, Size: "16:9", Resolution: "480p", ImageMediaIDs: []string{"expired-input"}})
	sample := model.VideoGenerationTask{ID: newID("sample"), OwnerUID: owner, ClientRequestID: newID("sample-client"), ProviderID: provider.ID, ProviderType: provider.Type, Status: "succeeded", ProviderTaskID: "f3a1c2d3-4567-49ab-8def-0123456789ab", RequestJSON: string(raw)}
	if err = db.Create(&sample).Error; err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Delete(&model.VideoGenerationTask{}, "owner_uid = ?", owner) })
	ctx := WithPortalUser(context.Background(), PortalUser{UID: owner})
	req := CreateVideoTaskRequest{ClientRequestID: newID("final-client"), Mode: "final", SourceDraftTaskID: sample.ID}
	view, err := CreateVideoGenerationTask(ctx, req)
	if err != nil {
		t.Fatal(err)
	}
	saved, found, err := repository.GetVideoGenerationTask(view.ID, owner)
	if err != nil || !found || saved.Amount.String() != "21" {
		t.Fatalf("saved=%#v err=%v", saved, err)
	}
	var snapshot CreateVideoTaskRequest
	if err = json.Unmarshal([]byte(saved.RequestJSON), &snapshot); err != nil {
		t.Fatal(err)
	}
	if snapshot.Mode != "final" || snapshot.Prompt != "reviewed" || snapshot.Resolution != "1080p" || snapshot.Seconds != 5 {
		t.Fatalf("snapshot=%#v", snapshot)
	}
	replay, err := CreateVideoGenerationTask(ctx, req)
	if err != nil || replay.ID != view.ID {
		t.Fatal(replay, err)
	}
	req.SourceDraftTaskID = "different"
	if _, err = CreateVideoGenerationTask(ctx, req); err != ErrGenerationRequestConflict {
		t.Fatalf("conflict = %v", err)
	}
}
