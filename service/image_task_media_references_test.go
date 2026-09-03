package service

import (
	"context"
	"errors"
	"testing"

	"github.com/basketikun/infinite-canvas/model"
)

func TestReadImageTaskMediaReferencesKeepsRequestedOrderAndChecksAccess(t *testing.T) {
	store := &memoryTaskInputStore{objects: map[string][]byte{"images/a.png": tinyPNG, "images/b.png": tinyPNG, "images/public.png": tinyPNG}}
	items := map[string]model.Media{
		"media-a":      {ID: "media-a", OwnerUID: "owner", ObjectKey: "images/a.png", Filename: "a.png", ContentType: "image/png"},
		"media-b":      {ID: "media-b", OwnerUID: "owner", ObjectKey: "images/b.png", Filename: "b.png", ContentType: "image/png"},
		"media-public": {ID: "media-public", OwnerUID: "uploader", ObjectKey: "images/public.png", Filename: "public.png", ContentType: "image/png"},
	}
	getMedia := func(id string) (model.Media, bool, error) { item, found := items[id]; return item, found, nil }
	getPublic := func(id string) (model.PublicImage, bool, error) {
		return model.PublicImage{MediaID: id}, id == "media-public", nil
	}

	references, err := readImageTaskMediaReferences(context.Background(), PortalUser{UID: "owner"}, []string{"media-b", "media-a"}, getMedia, getPublic, store)
	if err != nil {
		t.Fatalf("readImageTaskMediaReferences() error = %v", err)
	}
	if len(references) != 2 || references[0].Name != "b.png" || references[1].Name != "a.png" {
		t.Fatalf("references = %#v, want ordered media references", references)
	}

	if _, err := readImageTaskMediaReferences(context.Background(), PortalUser{UID: "other"}, []string{"media-a"}, getMedia, getPublic, store); err == nil {
		t.Fatal("readImageTaskMediaReferences() accepted another user's private image")
	}
	if _, err := readImageTaskMediaReferences(context.Background(), PortalUser{UID: "other"}, []string{"media-public"}, getMedia, getPublic, store); err != nil {
		t.Fatalf("readImageTaskMediaReferences() rejected a public image: %v", err)
	}
	missing := func(string) (model.Media, bool, error) { return model.Media{}, false, nil }
	if _, err := readImageTaskMediaReferences(context.Background(), PortalUser{UID: "owner"}, []string{"missing"}, missing, getPublic, store); err == nil {
		t.Fatal("readImageTaskMediaReferences() accepted a missing image")
	}
	failing := func(string) (model.Media, bool, error) {
		return model.Media{}, false, errors.New("database unavailable")
	}
	if _, err := readImageTaskMediaReferences(context.Background(), PortalUser{UID: "owner"}, []string{"media-a"}, failing, getPublic, store); err == nil {
		t.Fatal("readImageTaskMediaReferences() hid repository errors")
	}
}
